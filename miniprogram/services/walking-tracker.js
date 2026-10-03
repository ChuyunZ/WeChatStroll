const { callCloudFunction } = require("./cloud-function-client");
const { isValidGeoPoint } = require("../utils/geo");
const { createCodedError } = require("../utils/errors");

const TRACKING_STORAGE_KEY = "activeWalkTracking";
const TRACKING_VERSION = 1;
const MIN_UPLOAD_INTERVAL_MS = 15000;
const MAX_PENDING_RETRY_ATTEMPTS = 1;
const MAX_TRACKING_SESSION_AGE_MS = 12 * 60 * 60 * 1000;
const TRACE_SEARCH_RETRY_DELAYS_MS = [500, 1000];

const ERROR_CODES = {
  INVALID_SESSION: "INVALID_TRACKING_SESSION",
  SESSION_CONFLICT: "TRACKING_SESSION_CONFLICT",
  BACKGROUND_LOCATION_UNAVAILABLE: "BACKGROUND_LOCATION_UNAVAILABLE",
  BACKGROUND_LOCATION_PERMISSION_DENIED: "BACKGROUND_LOCATION_PERMISSION_DENIED",
  BACKGROUND_LOCATION_FAILED: "BACKGROUND_LOCATION_FAILED"
};

let activeSession = null;
let locationHandler = null;
let lastUploadAttemptAtMs = 0;
let uploadInFlight = false;
let pendingUpload = null;
let stopPromise = null;
let startPromise = null;
let finalPromise = null;
let finalizedSession = null;
let expiryTimer = null;
let stopping = false;
let finalizing = false;
let currentUpload = null;
const OPERATION_TIMEOUT_MS = 3000;
const FINAL_FLUSH_TIMEOUT_MS = 5000;

function bounded(promise, timeoutMs = OPERATION_TIMEOUT_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(createCodedError(
      "TRACK_OPERATION_TIMEOUT", "Tracking operation timed out."
    )), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function markPartial(session) {
  session.trajectoryPartial = true;
  try {
    if (activeSession === session && !stopping) saveTrackingSession(session);
    const walk = wx.getStorageSync("activeWalkSession");
    if (walk && walk.routeId === session.routeId && walk.startTimeMs === session.startTimeMs) {
      wx.setStorageSync("activeWalkSession", { ...walk, trajectoryPartial: true });
    }
  } catch (error) {
    console.warn("[Walking Tracker] Unable to persist trajectory quality.");
  }
}

function cleanupInBackground() {
  stopTracking().catch(() => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(cleanupInBackground, 30000);
  });
}

function ensureActiveSessionFresh() {
  if (stopping) return false;
  if (activeSession && isStaleTrackingSession(activeSession)) {
    markPartial(activeSession);
    cleanupInBackground();
    return false;
  }
  return Boolean(activeSession && !stopping);
}

function isValidTrackingSession(session) {
  return (
    session &&
    typeof session === "object" &&
    !Array.isArray(session) &&
    session.version === TRACKING_VERSION &&
    ["active", "stopPending"].includes(session.status) &&
    typeof session.routeId === "string" &&
    session.routeId.trim() !== "" &&
    Number.isFinite(session.startTimeMs) &&
    session.startTimeMs > 0
  );
}

function isSameTrackingSession(first, second) {
  return (
    isValidTrackingSession(first) &&
    isValidTrackingSession(second) &&
    first.routeId === second.routeId &&
    first.startTimeMs === second.startTimeMs
  );
}

function createTrackingSession(routeId, startTimeMs) {
  if (typeof routeId !== "string" || routeId.trim() === "") {
    throw createCodedError(
      ERROR_CODES.INVALID_SESSION,
      "Tracking route ID must be a non-empty string."
    );
  }

  if (!Number.isFinite(startTimeMs) || startTimeMs <= 0) {
    throw createCodedError(
      ERROR_CODES.INVALID_SESSION,
      "Tracking start time must be a positive timestamp."
    );
  }

  return {
    version: TRACKING_VERSION,
    status: "active",
    routeId,
    startTimeMs
  };
}

function isStaleTrackingSession(
  session,
  nowMs = Date.now()
) {
  return (
    Number.isFinite(nowMs) &&
    nowMs >= session.startTimeMs &&
    nowMs - session.startTimeMs >=
      MAX_TRACKING_SESSION_AGE_MS
  );
}

function getTrackingSession() {
  const session = wx.getStorageSync(TRACKING_STORAGE_KEY);

  if (!session) {
    return null;
  }

  if (!isValidTrackingSession(session)) {
    wx.removeStorageSync(TRACKING_STORAGE_KEY);
    return null;
  }

  if (session.status === "stopPending" || isStaleTrackingSession(session)) {
    if (!activeSession) activeSession = session;
    cleanupInBackground();
    return null;
  }
  return session;
}

function saveTrackingSession(session) {
  if (!isValidTrackingSession(session)) {
    throw createCodedError(
      ERROR_CODES.INVALID_SESSION,
      "Invalid walking tracking session."
    );
  }

  wx.setStorageSync(TRACKING_STORAGE_KEY, session);
  return session;
}

function clearTrackingSession() {
  wx.removeStorageSync(TRACKING_STORAGE_KEY);
}

function getSettings() {
  if (typeof wx.getSetting !== "function") {
    return Promise.resolve({
      authSetting: {}
    });
  }

  return new Promise((resolve, reject) => {
    wx.getSetting({
      success: resolve,
      fail: reject
    });
  });
}

function authorizeBackgroundLocation() {
  if (typeof wx.authorize !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    wx.authorize({
      scope: "scope.userLocationBackground",
      success: resolve,
      fail: reject
    });
  });
}

async function ensureBackgroundLocationPermission() {
  let settings;

  try {
    settings = await getSettings();
  } catch (error) {
    throw createCodedError(
      ERROR_CODES.BACKGROUND_LOCATION_PERMISSION_DENIED,
      "Unable to read background location permission.",
      error
    );
  }

  if (
    settings &&
    settings.authSetting &&
    settings.authSetting[
      "scope.userLocationBackground"
    ] === true
  ) {
    return true;
  }

  try {
    await authorizeBackgroundLocation();
    return true;
  } catch (error) {
    throw createCodedError(
      ERROR_CODES.BACKGROUND_LOCATION_PERMISSION_DENIED,
      "Background location permission was denied.",
      error
    );
  }
}

function isBackgroundLocationAuthError(error) {
  const message =
    error && typeof error.errMsg === "string"
      ? error.errMsg.toLowerCase()
      : "";

  return (
    message.includes("auth deny") ||
    message.includes("unauthorized") ||
    message.includes("permission")
  );
}

async function startBackgroundLocation(session) {
  if (typeof wx.startLocationUpdateBackground !== "function") {
    throw createCodedError(
      ERROR_CODES.BACKGROUND_LOCATION_UNAVAILABLE,
      "Background location is not available."
    );
  }

  await ensureBackgroundLocationPermission();
  if (stopping || activeSession !== session) {
    throw createCodedError(ERROR_CODES.INVALID_SESSION, "Tracking start was cancelled.");
  }

  return new Promise((resolve, reject) => {
    wx.startLocationUpdateBackground({
      type: "gcj02",

      success: () => {
        resolve();
      },

      fail: error => {
        reject(
          createCodedError(
            isBackgroundLocationAuthError(error)
              ? ERROR_CODES.BACKGROUND_LOCATION_PERMISSION_DENIED
              : ERROR_CODES.BACKGROUND_LOCATION_FAILED,
            "Unable to start background location.",
            error
          )
        );
      }
    });
  });
}

function stopBackgroundLocation() {
  if (typeof wx.stopLocationUpdate !== "function") {
    return Promise.reject(createCodedError(
      ERROR_CODES.BACKGROUND_LOCATION_UNAVAILABLE, "Unable to stop background location."
    ));
  }

  return new Promise((resolve, reject) => {
    wx.stopLocationUpdate({
      success: () => {
        resolve();
      },

      fail: error => {
        reject(
          createCodedError(
            ERROR_CODES.BACKGROUND_LOCATION_FAILED,
            "Unable to stop background location.",
            error
          )
        );
      }
    });
  });
}

function normalizeTimestampMs(value, fallbackMs) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }

  // Accept either Unix seconds or milliseconds from platform callbacks.
  return value < 1e12
    ? Math.floor(value * 1000)
    : Math.floor(value);
}

function normalizeLocation(location, fallbackTimestampMs = Date.now()) {
  if (!isValidGeoPoint(location)) {
    return null;
  }

  const sourceTimestamp =
    Number.isFinite(location.timestampMs)
      ? location.timestampMs
      : Number.isFinite(location.timestamp)
        ? location.timestamp
        : Number.isFinite(location.time)
          ? location.time
          : fallbackTimestampMs;

  const accuracy = Number.isFinite(location.accuracy)
    ? location.accuracy
    : Number.isFinite(location.horizontalAccuracy)
      ? location.horizontalAccuracy
      : null;

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    timestampMs: normalizeTimestampMs(
      sourceTimestamp,
      fallbackTimestampMs
    ),
    accuracy,
    speed:
      Number.isFinite(location.speed) && location.speed >= 0
        ? location.speed
        : null,
    direction:
      Number.isFinite(location.direction) &&
      location.direction >= 0 &&
      location.direction <= 360
        ? location.direction
        : null,
    altitude: Number.isFinite(location.altitude)
      ? location.altitude
      : null
  };
}

function shouldUploadLocation(location, nowMs = Date.now()) {
  if (!isValidGeoPoint(location)) {
    return false;
  }

  if (uploadInFlight) {
    return false;
  }

  if (
    lastUploadAttemptAtMs > 0 &&
    nowMs - lastUploadAttemptAtMs < MIN_UPLOAD_INTERVAL_MS
  ) {
    return false;
  }

  return true;
}

async function uploadLocation(location, nowMs = Date.now(), force = false) {
  const session = activeSession;

  if (!ensureActiveSessionFresh() || (!force && finalizing) ||
      (!force && !shouldUploadLocation(location, nowMs))) {
    return false;
  }

  const currentPoint = normalizeLocation(location, nowMs);

  if (!currentPoint) {
    return false;
  }

  const retrying = Boolean(
    pendingUpload &&
    pendingUpload.attempts <= MAX_PENDING_RETRY_ATTEMPTS
  );

  const point = retrying
    ? pendingUpload.point
    : currentPoint;

  lastUploadAttemptAtMs = nowMs;
  uploadInFlight = true;

  try {
    await bounded(callCloudFunction(
      "trackProvider",
      {
        action: "uploadTrace",
        routeId: session.routeId,
        walkStartTimeMs: session.startTimeMs,
        point
      },
      {
        fallbackCode: "TRACK_UPLOAD_FAILED",
        fallbackMessage: "Unable to upload walking location."
      }
    ));

    if (activeSession !== session || stopping) return false;
    delete session.pendingPoint;
    saveTrackingSession(session);
    if (retrying) {
      pendingUpload = null;
    }

    return true;
  } catch (error) {
    if (activeSession !== session || stopping) return false;
    if (retrying) {
      delete session.pendingPoint;
      markPartial(session);
      // One buffered retry is enough. Drop the stale point after that
      // so a temporary outage cannot create an unbounded retry loop.
      pendingUpload = null;
    } else {
      session.pendingPoint = true;
      saveTrackingSession(session);
      pendingUpload = {
        point,
        attempts: 1
      };
    }

    console.warn("[Walking Tracker] Location upload failed.", {
      code: error && error.code ? error.code : "TRACK_UPLOAD_FAILED"
    });

    return false;
  } finally {
    if (activeSession === session) uploadInFlight = false;
  }
}

function captureInitialLocation() {
  if (
    !activeSession ||
    typeof wx.getLocation !== "function"
  ) {
    return;
  }

  const session = activeSession;
  wx.getLocation({
    type: "gcj02",

    success: location => {
      if (session !== activeSession || finalizing || stopping || uploadInFlight) return;
      currentUpload = uploadLocation(location);
      currentUpload.catch(error => {
        console.warn(
          "[Walking Tracker] Initial location upload failed.",
          {
            code:
              error && error.code
                ? error.code
                : "TRACK_UPLOAD_FAILED"
          }
        );
      });
    },

    fail: error => {
      console.warn(
        "[Walking Tracker] Unable to capture initial location.",
        {
          code: "TRACK_INITIAL_LOCATION_FAILED"
        }
      );
    }
  });
}

function attachLocationListener() {
  if (locationHandler) {
    return;
  }

  if (typeof wx.onLocationChange !== "function") {
    throw createCodedError(
      ERROR_CODES.BACKGROUND_LOCATION_UNAVAILABLE,
      "Location change listener is not available."
    );
  }

  const session = activeSession;
  locationHandler = location => {
    if (session !== activeSession || finalizing || stopping) return;
    if (uploadInFlight) { ensureActiveSessionFresh(); return; }
    currentUpload = uploadLocation(location);
    currentUpload.catch(error => {
      console.warn("[Walking Tracker] Unexpected location upload error.", {
        code: error && error.code ? error.code : "TRACK_UPLOAD_FAILED"
      });
    });
  };

  wx.onLocationChange(locationHandler);
}

function detachLocationListener() {
  if (!locationHandler) {
    return;
  }

  if (typeof wx.offLocationChange === "function") {
    try {
      wx.offLocationChange(locationHandler);
    } catch (error) {
      console.warn("[Walking Tracker] Unable to detach location listener.");
    }
  }

  locationHandler = null;
}

function startTracking(options) {
  if (startPromise) return startPromise.then(() => startTracking(options));
  const operation = startTrackingSession(options);
  startPromise = operation;
  operation.finally(() => {
    if (startPromise === operation) startPromise = null;
  }).catch(() => {});
  return operation;
}

async function startTrackingSession({ routeId, startTimeMs, trajectoryPartial = false }) {
  const requestedSession = createTrackingSession(routeId, startTimeMs);
  if (isStaleTrackingSession(requestedSession)) {
    throw createCodedError(ERROR_CODES.INVALID_SESSION, "Tracking session expired.");
  }
  const stored = wx.getStorageSync(TRACKING_STORAGE_KEY);
  if (stopPromise) await stopPromise;
  if (stopping || (activeSession && isStaleTrackingSession(activeSession)) ||
      (stored && (stored.status === "stopPending" || isStaleTrackingSession(stored)))) {
    await stopTracking();
  }
  if (activeSession) {
    if (isSameTrackingSession(activeSession, requestedSession)) {
      return { session: activeSession, resumed: true };
    }
    throw createCodedError(ERROR_CODES.SESSION_CONFLICT, "Another tracking session is active.");
  }
  const storedSession = getTrackingSession();
  if (storedSession && !isSameTrackingSession(storedSession, requestedSession)) {
    throw createCodedError(ERROR_CODES.SESSION_CONFLICT, "A different tracking session is stored.");
  }
  const session = storedSession || requestedSession;
  const walk = wx.getStorageSync("activeWalkSession");
  if (trajectoryPartial || session.pendingPoint ||
      (walk && walk.routeId === routeId && walk.startTimeMs === startTimeMs && walk.trajectoryPartial)) {
    session.trajectoryPartial = true;
  }
  delete session.pendingPoint;
  stopping = false;
  finalizing = false;
  finalPromise = null;
  finalizedSession = null;
  activeSession = session;
  try {
    await startBackgroundLocation(session);
    if (stopping || activeSession !== session || isStaleTrackingSession(session)) {
      activeSession = session;
      await stopTracking().catch(() => { cleanupInBackground(); });
      return null;
    }
    lastUploadAttemptAtMs = 0;
    uploadInFlight = false;
    pendingUpload = null;
    if (!finalizing) attachLocationListener();
    saveTrackingSession(session);
    expiryTimer = setTimeout(() => {
      markPartial(session);
      cleanupInBackground();
    }, Math.max(0, session.startTimeMs + MAX_TRACKING_SESSION_AGE_MS - Date.now()));
    if (!finalizing) captureInitialLocation();
  } catch (error) {
    await stopTracking().catch(() => {});
    throw error;
  }
  return { session, resumed: Boolean(storedSession) };
}

async function resumeTracking() {
  const session = getTrackingSession();

  if (!session) {
    return null;
  }

  return startTracking({
    routeId: session.routeId,
    startTimeMs: session.startTimeMs
  });
}

function stopTracking() {
  if (stopPromise) return stopPromise;
  const session = activeSession || wx.getStorageSync(TRACKING_STORAGE_KEY) || null;
  stopping = true;
  clearTimeout(expiryTimer);
  detachLocationListener();
  if (session) {
    if (pendingUpload || uploadInFlight) session.trajectoryPartial = true;
    try {
      wx.setStorageSync(TRACKING_STORAGE_KEY, { ...session, status: "stopPending" });
    } catch (error) {
      console.warn("[Walking Tracker] Unable to persist pending stop; retaining in-memory state.");
    }
  }
  const operation = bounded(stopBackgroundLocation()).then(() => {
    clearTrackingSession();
    activeSession = null;
    stopping = false;
    pendingUpload = null;
    uploadInFlight = false;
    currentUpload = null;
    lastUploadAttemptAtMs = 0;
    return session;
  });
  stopPromise = operation;
  operation.finally(() => {
    if (stopPromise === operation) stopPromise = null;
  }).catch(() => {});
  return operation;
}

function finalizeTracking(requestedSession = null) {
  const matches = session => !requestedSession || (session &&
    session.routeId === requestedSession.routeId && session.startTimeMs === requestedSession.startTimeMs);
  if (finalPromise && matches(finalizedSession)) return finalPromise;
  const session = activeSession;
  if (requestedSession && !matches(session)) {
    return Promise.resolve({ trajectoryPartial: true });
  }
  finalizedSession = session;
  finalizing = true;
  detachLocationListener();
  const flush = async () => {
    if (!session || !ensureActiveSessionFresh()) return;
    if (startPromise) await bounded(startPromise);
    if (currentUpload) await currentUpload;
    if (activeSession !== session || !ensureActiveSessionFresh() || stopping) return;
    // Buffered retry precedes the fresh final sample. Final uploads explicitly
    // bypass the ordinary 15-second cadence, within one total 5-second budget.
    if (pendingUpload) await uploadLocation(pendingUpload.point, Date.now(), true);
    if (activeSession !== session || !ensureActiveSessionFresh() || stopping) return;
    const location = await new Promise((resolve, reject) => {
      if (typeof wx.getLocation !== "function") return reject(new Error("Location unavailable"));
      wx.getLocation({ type: "gcj02", success: resolve, fail: reject });
    });
    if (stopping || activeSession !== session) return;
    if (!normalizeLocation(location)) throw new Error("Invalid final location");
    if (!await uploadLocation(location, Date.now(), true)) markPartial(session);
  };
  finalPromise = bounded(flush(), FINAL_FLUSH_TIMEOUT_MS)
    .catch(() => { if (session) markPartial(session); })
    .then(async () => {
      if (activeSession === session) {
        await stopTracking().catch(() => { cleanupInBackground(); });
      }
      return { trajectoryPartial: Boolean(!session || session.trajectoryPartial) };
    });
  return finalPromise;
}

function stopTrackingForSession(session) {
  const tracked = activeSession || wx.getStorageSync(TRACKING_STORAGE_KEY);
  if (tracked && tracked.routeId === session.routeId && tracked.startTimeMs === session.startTimeMs) {
    if (isStaleTrackingSession(tracked)) markPartial(tracked);
    cleanupInBackground();
  }
}

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function isRetryableEmptyTrace(result) {
  return Boolean(
    result &&
    result.success === true &&
    result.trace &&
    result.trace.retryable === true &&
    Array.isArray(result.trace.points) &&
    result.trace.points.length === 0
  );
}

async function searchTrace({ startTimeMs, endTimeMs, trajectoryPartial = false }) {
  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(endTimeMs) ||
    startTimeMs <= 0 ||
    endTimeMs <= startTimeMs
  ) {
    throw createCodedError(
      ERROR_CODES.INVALID_SESSION,
      "Invalid walking trajectory time range."
    );
  }

  const search = () =>
    callCloudFunction(
      "trackProvider",
      {
        action: "searchTrace",
        startTimeMs,
        endTimeMs,
        ...(trajectoryPartial ? { trajectoryPartial: true } : {})
      },
      {
        fallbackCode: "TRACK_SEARCH_FAILED",
        fallbackMessage: "Unable to query walking trajectory."
      }
    );

  let result = await search();

  for (const delayMs of TRACE_SEARCH_RETRY_DELAYS_MS) {
    if (!isRetryableEmptyTrace(result)) {
      return result;
    }

    await wait(delayMs);
    result = await search();
  }

  return result;
}

function isTracking(session = null) {
  return ensureActiveSessionFresh() && !finalizing && (!session ||
    (activeSession.routeId === session.routeId && activeSession.startTimeMs === session.startTimeMs));
}

module.exports = {
  TRACKING_STORAGE_KEY,
  TRACKING_VERSION,
  MIN_UPLOAD_INTERVAL_MS,
  MAX_PENDING_RETRY_ATTEMPTS,
  MAX_TRACKING_SESSION_AGE_MS,
  ERROR_CODES,
  isValidTrackingSession,
  getTrackingSession,
  ensureBackgroundLocationPermission,
  startTracking,
  resumeTracking,
  stopTracking,
  finalizeTracking,
  stopTrackingForSession,
  searchTrace,
  shouldUploadLocation,
  isTracking
};