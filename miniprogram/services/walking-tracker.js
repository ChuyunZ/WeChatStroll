const { callCloudFunction } = require("./cloud-function-client");
const { isValidGeoPoint } = require("../utils/geo");
const { createCodedError } = require("../utils/errors");

const TRACKING_STORAGE_KEY = "activeWalkTracking";
const TRACKING_VERSION = 1;
const MIN_UPLOAD_INTERVAL_MS = 15000;

const ERROR_CODES = {
  INVALID_SESSION: "INVALID_TRACKING_SESSION",
  SESSION_CONFLICT: "TRACKING_SESSION_CONFLICT",
  BACKGROUND_LOCATION_UNAVAILABLE: "BACKGROUND_LOCATION_UNAVAILABLE",
  BACKGROUND_LOCATION_FAILED: "BACKGROUND_LOCATION_FAILED"
};

let activeSession = null;
let locationHandler = null;
let lastUploadAttemptAtMs = 0;
let uploadInFlight = false;

function isValidTrackingSession(session) {
  return (
    session &&
    typeof session === "object" &&
    !Array.isArray(session) &&
    session.version === TRACKING_VERSION &&
    session.status === "active" &&
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

function getTrackingSession() {
  const session = wx.getStorageSync(TRACKING_STORAGE_KEY);

  if (!session) {
    return null;
  }

  if (!isValidTrackingSession(session)) {
    wx.removeStorageSync(TRACKING_STORAGE_KEY);
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

async function ensureTrackEntity() {
  return callCloudFunction(
    "trackProvider",
    {
      action: "ensureEntity"
    },
    {
      fallbackCode: "TRACK_ENTITY_FAILED",
      fallbackMessage:
        "Unable to prepare walking trajectory storage."
    }
  );
}

function startBackgroundLocation() {
  if (typeof wx.startLocationUpdateBackground !== "function") {
    return Promise.reject(
      createCodedError(
        ERROR_CODES.BACKGROUND_LOCATION_UNAVAILABLE,
        "Background location is not available."
      )
    );
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
            ERROR_CODES.BACKGROUND_LOCATION_FAILED,
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
    return Promise.resolve();
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

function sourceTimestampMs(location, fallbackMs = Date.now()) {
  const candidates = [
    location && location.time,
    location && location.timestampMs,
    location && location.timestamp
  ];

  const timestamp = candidates.find(
    value => Number.isFinite(value) && value > 0
  );

  return timestamp || fallbackMs;
}

function normalizeLocation(location, timestampMs = Date.now()) {
  if (!isValidGeoPoint(location)) {
    return null;
  }

  const accuracy = Number.isFinite(location.accuracy)
    ? location.accuracy
    : Number.isFinite(location.horizontalAccuracy)
      ? location.horizontalAccuracy
      : null;

  const direction = Number.isFinite(location.direction)
    ? location.direction
    : Number.isFinite(location.heading)
      ? location.heading
      : null;

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    timestampMs: sourceTimestampMs(location, timestampMs),
    accuracy,
    speed:
      Number.isFinite(location.speed) && location.speed >= 0
        ? location.speed
        : 0,
    direction,
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

async function uploadLocation(location, nowMs = Date.now()) {
  const session = activeSession;

  if (!session || !shouldUploadLocation(location, nowMs)) {
    return false;
  }

  const point = normalizeLocation(location, nowMs);

  if (!point) {
    return false;
  }

  lastUploadAttemptAtMs = nowMs;
  uploadInFlight = true;

  try {
    await callCloudFunction(
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
    );

    return true;
  } catch (error) {
    console.warn("[Walking Tracker] Location upload failed.", {
      code:
        error && error.code
          ? error.code
          : "TRACK_UPLOAD_FAILED"
    });

    return false;
  } finally {
    uploadInFlight = false;
  }
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

  locationHandler = location => {
    uploadLocation(location).catch(error => {
      console.warn(
        "[Walking Tracker] Unexpected location upload error.",
        {
          code:
            error && error.code
              ? error.code
              : "TRACK_UPLOAD_FAILED"
        }
      );
    });
  };

  wx.onLocationChange(locationHandler);
}

function detachLocationListener() {
  if (!locationHandler) {
    return;
  }

  if (typeof wx.offLocationChange === "function") {
    wx.offLocationChange(locationHandler);
  }

  locationHandler = null;
}

async function startTracking({ routeId, startTimeMs }) {
  const requestedSession = createTrackingSession(
    routeId,
    startTimeMs
  );

  if (activeSession) {
    if (
      isSameTrackingSession(
        activeSession,
        requestedSession
      )
    ) {
      return {
        session: activeSession,
        resumed: true
      };
    }

    throw createCodedError(
      ERROR_CODES.SESSION_CONFLICT,
      "Another walking tracking session is already active."
    );
  }

  const storedSession = getTrackingSession();

  if (
    storedSession &&
    !isSameTrackingSession(
      storedSession,
      requestedSession
    )
  ) {
    throw createCodedError(
      ERROR_CODES.SESSION_CONFLICT,
      "A different walking tracking session is already stored."
    );
  }

  const session = storedSession || requestedSession;

  // Resolve the authenticated user's opaque Track Cloud entity before
  // enabling continuous location collection.
  await ensureTrackEntity();
  await startBackgroundLocation();

  try {
    activeSession = session;
    lastUploadAttemptAtMs = 0;
    uploadInFlight = false;

    attachLocationListener();
    saveTrackingSession(session);
  } catch (error) {
    activeSession = null;
    detachLocationListener();

    try {
      await stopBackgroundLocation();
    } catch (stopError) {
      console.warn(
        "[Walking Tracker] Unable to stop location after setup failure.",
        {
          code:
            stopError && stopError.code
              ? stopError.code
              : ERROR_CODES.BACKGROUND_LOCATION_FAILED
        }
      );
    }

    throw error;
  }

  return {
    session,
    resumed: Boolean(storedSession)
  };
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

async function stopTracking() {
  const session = activeSession || getTrackingSession();

  detachLocationListener();

  activeSession = null;
  lastUploadAttemptAtMs = 0;
  uploadInFlight = false;

  clearTrackingSession();

  try {
    await stopBackgroundLocation();
  } catch (error) {
    console.warn(
      "[Walking Tracker] Unable to stop background location.",
      {
        code:
          error && error.code
            ? error.code
            : ERROR_CODES.BACKGROUND_LOCATION_FAILED
      }
    );

    throw error;
  }

  return session;
}

async function searchTrace({ startTimeMs, endTimeMs }) {
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

  return callCloudFunction(
    "trackProvider",
    {
      action: "searchTrace",
      startTimeMs,
      endTimeMs
    },
    {
      fallbackCode: "TRACK_SEARCH_FAILED",
      fallbackMessage: "Unable to query walking trajectory."
    }
  );
}

function isTracking() {
  return Boolean(activeSession);
}

module.exports = {
  TRACKING_STORAGE_KEY,
  TRACKING_VERSION,
  MIN_UPLOAD_INTERVAL_MS,
  ERROR_CODES,
  isValidTrackingSession,
  getTrackingSession,
  startTracking,
  resumeTracking,
  stopTracking,
  searchTrace,
  shouldUploadLocation,
  isTracking
};
