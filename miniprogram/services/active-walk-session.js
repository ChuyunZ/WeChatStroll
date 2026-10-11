const ACTIVE_WALK_STORAGE_KEY = "activeWalkSession";
const PENDING_WALK_RESULT_STORAGE_KEY = "pendingWalkResult";
const ACTIVE_WALK_SESSION_VERSION = 2;
const MAX_ACTIVE_WALK_AGE_MS = 12 * 60 * 60 * 1000;
// Terminal results are optional Feedback metadata, never planned-route caches.
const PENDING_FIELDS = [
  "walkId", "routeId", "startTime", "endTime", "actualDurationSeconds",
  "completionStatus", "trajectoryEnabled", "trajectoryPartial", "trajectoryEndTimeMs"
];
const { isValidPreferences } = require("./walk-records");
const { isValidGeoPoint } = require("../utils/geo");

function isValidCompletionRequest(session) {
  const request = session.completionRequest;
  return request === undefined || Boolean(request && request.walkId === session.walkId &&
    ["completed", "ended_early"].includes(request.completionStatus) &&
    Number.isSafeInteger(request.endTimeMs) && request.endTimeMs >= session.startTimeMs &&
    typeof request.trajectoryPartial === "boolean");
}

function isValidRouteSnapshot(route) {
  return (
    route &&
    typeof route === "object" &&
    !Array.isArray(route) &&
    typeof route.routeId === "string" &&
    route.routeId.trim() !== ""
  );
}

function isValidActiveWalkSession(session) {
  return (
    session &&
    typeof session === "object" &&
    !Array.isArray(session) &&
    session.version === ACTIVE_WALK_SESSION_VERSION &&
    session.status === "active" &&
    typeof session.walkId === "string" && session.walkId.trim() !== "" &&
    isValidPreferences(session.preferences) &&
    typeof session.routeId === "string" &&
    session.routeId.trim() !== "" &&
    isValidRouteSnapshot(session.route) &&
    session.route.routeId === session.routeId &&
    Number.isSafeInteger(session.startTimeMs) &&
    session.startTimeMs > 0 &&
    isValidCompletionRequest(session) &&
    (
      session.trackingEnabled === undefined ||
      typeof session.trackingEnabled === "boolean"
    )
  );
}

// A matching local terminal handoff can request a server check, but can
// never authorize deleting the active lock by itself.
function hasMatchingTerminalHandoff(session) {
  try {
    const pending = getPendingWalkResult();
    return Boolean(pending &&
      pending.walkId === session.walkId &&
      pending.routeId === session.routeId &&
      Date.parse(pending.startTime) === session.startTimeMs);
  } catch (_) {
    return false;
  }
}

function getActiveWalkSession() {
  const session = wx.getStorageSync(ACTIVE_WALK_STORAGE_KEY);

  if (!session) {
    return null;
  }

  if (!isValidActiveWalkSession(session)) {
    require("./walking-tracker").stopTrackingForSession(session);
    wx.removeStorageSync(ACTIVE_WALK_STORAGE_KEY);
    return null;
  }

  // A pending Feedback handoff is device metadata, not authoritative proof
  // of completion. CloudBase reconciliation must verify the Walk state before
  // deleting a structurally valid route lock, including on cold launch.
  return session;
}

function createActiveWalkSession(
  route,
  startTimeMs = Date.now(),
  { trackingEnabled = false, walkId, preferences = {} } = {}
) {
  const existingSession = getActiveWalkSession();

  if (existingSession) {
    return {
      session: existingSession,
      created: false
    };
  }

  if (!isValidRouteSnapshot(route)) {
    throw new Error("Invalid route snapshot.");
  }

  if (!Number.isFinite(startTimeMs) || startTimeMs <= 0) {
    throw new Error("Invalid walk start time.");
  }

  if (typeof walkId !== "string" || !walkId.trim()) throw new Error("Missing durable walk identity.");
  if (!isValidPreferences(preferences)) throw new Error("Invalid questionnaire snapshot.");

  const session = {
    walkId,
    preferences,
    version: ACTIVE_WALK_SESSION_VERSION,
    status: "active",
    routeId: route.routeId,
    route,
    startTimeMs,
    trackingEnabled: trackingEnabled === true
  };

  wx.setStorageSync(ACTIVE_WALK_STORAGE_KEY, session);

  return {
    session,
    created: true
  };
}

function clearActiveWalkSession(routeId = null, walkId = null) {
  const activeSession = wx.getStorageSync(ACTIVE_WALK_STORAGE_KEY);

  if (!activeSession) {
    return true;
  }

  if ((routeId && activeSession.routeId !== routeId) || (walkId && activeSession.walkId !== walkId)) {
    return false;
  }

  wx.removeStorageSync(ACTIVE_WALK_STORAGE_KEY);
  return true;
}

function isValidPendingWalkResult(result) {
  return (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.walkId === "string" &&
    result.walkId.trim() !== "" &&
    typeof result.routeId === "string" &&
    result.routeId.trim() !== "" &&
    typeof result.startTime === "string" &&
    typeof result.endTime === "string" &&
    Number.isFinite(Date.parse(result.startTime)) &&
    Number.isFinite(Date.parse(result.endTime)) &&
    Number.isFinite(result.actualDurationSeconds) &&
    result.actualDurationSeconds >= 0 &&
    ["completed", "ended_early"].includes(result.completionStatus) &&
    (result.trajectoryEnabled === undefined || typeof result.trajectoryEnabled === "boolean") &&
    (result.trajectoryPartial === undefined || typeof result.trajectoryPartial === "boolean") &&
    (result.trajectoryEndTimeMs === undefined ||
      (Number.isSafeInteger(result.trajectoryEndTimeMs) &&
       result.trajectoryEndTimeMs >= Date.parse(result.endTime)))
  );
}

function minimalPendingWalkResult(result) {
  const minimal = {};
  for (const key of PENDING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) minimal[key] = result[key];
  }
  return minimal;
}

function savePendingWalkResult(result) {
  if (!isValidPendingWalkResult(result)) {
    throw new Error("Invalid pending walk result.");
  }
  const minimal = minimalPendingWalkResult(result);
  wx.setStorageSync(PENDING_WALK_RESULT_STORAGE_KEY, minimal);
  return minimal;
}

function getPendingWalkResult() {
  const result = wx.getStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
  if (!result) return null;
  if (!isValidPendingWalkResult(result)) {
    wx.removeStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
    return null;
  }

  // Rewrite legacy full-route terminal snapshots when the user next opens the app.
  const minimal = minimalPendingWalkResult(result);
  if (Object.keys(result).some(key => !PENDING_FIELDS.includes(key))) {
    try {
      wx.setStorageSync(PENDING_WALK_RESULT_STORAGE_KEY, minimal);
    } catch (_) {
      // Do not retain a known full-route legacy snapshot just to preserve optional
      // Feedback. If rewriting fails, prefer deleting the old provider data.
      // Return sanitized metadata for the current page even after deletion.
      try {
        wx.removeStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
      } catch (_) {
        // Both storage operations failed; retry sanitization on the next read.
      }
    }
  }
  return minimal;
}

function clearPendingWalkResult(walkId) {
  const pending = wx.getStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
  if (typeof walkId !== "string" || !walkId || (pending && pending.walkId !== walkId)) return false;
  wx.removeStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
  return true;
}

function restoreCloudWalk(walk, route) {
  if (!route || route.routeId !== walk.routeId || !Array.isArray(route.polyline) || route.polyline.length < 2 ||
      !route.polyline.every(isValidGeoPoint) || !Number.isFinite(route.durationMinutes) || route.durationMinutes < 0 ||
      !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0) {
    throw Object.assign(new Error("当前设备缺少正在进行的散步路线，暂时无法恢复或开始新散步"), { code: "WALK_ROUTE_UNAVAILABLE" });
  }
  const result = createActiveWalkSession(route, Date.parse(walk.startTime), {
    walkId: walk.walkId, preferences: walk.preferences, trackingEnabled: walk.trajectoryEnabled
  });
  if (result.session.walkId !== walk.walkId) throw new Error("Local walk changed during recovery.");
  return result.session;
}

// Foreground Home/Walking recovery waits for a cold-launch stale check, so the
// same old Walk cannot race itself into a misleading navigation error.
let startupStaleCheck = null;
async function reconcileActiveWalk(route = null) {
  if (startupStaleCheck) await startupStaleCheck;
  return reconcileActiveWalkImpl(route);
}

async function reconcileActiveWalkImpl(route = null) {
  const records = require("./walk-records");
  const local = getActiveWalkSession();
  if (local) {
    const cloud = await records.getWalk(local.walkId);
    // Ignore stale cloud responses rather than erasing a newer local session.
    const current = getActiveWalkSession();
    if (!current || current.walkId !== local.walkId ||
        current.routeId !== local.routeId || current.startTimeMs !== local.startTimeMs) {
      throw Object.assign(new Error("Active walk changed during reconciliation."), {
        code: "WALK_STATE_CHANGED"
      });
    }
    if (cloud.status === "active") {
      if (cloud.routeId !== local.routeId || Date.parse(cloud.startTime) !== local.startTimeMs) {
        throw new Error("Local walk does not match cloud identity.");
      }
      return local;
    }
    if (!["completed", "ended_early", "abandoned"].includes(cloud.status)) {
      throw new Error("Unexpected CloudBase Walk status.");
    }
    require("./walking-tracker").stopTrackingForSession(local);
    if (cloud.status === "abandoned") {
      clearActiveWalkSession(local.routeId, local.walkId);
      throw Object.assign(
        new Error("上一次散步因长时间未结束，已自动关闭"),
        { code: "WALK_ABANDONED" }
      );
    }
    try {
      const pending = getPendingWalkResult();
      // Do not replace a different, newer user's pending Feedback handoff.
      if (!pending || pending.walkId === local.walkId) savePendingWalkResult(cloud);
    } finally {
      clearActiveWalkSession(local.routeId, local.walkId);
    }
    return null;
  }
  const cloud = await records.getActiveWalk();
  return cloud ? restoreCloudWalk(cloud, route) : null;
}

// Check aged local sessions when the app restarts. Only CloudBase can establish
// actual abandonment: never delete a still-active or unverified Walk by clock.
async function cleanupStaleActiveWalk() {
  const local = getActiveWalkSession();
  if (!local) return false;
  // A matching terminal handoff can mean route deletion failed during an
  // earlier completion. Verify such locks promptly, even if younger than 12h.
  if (Date.now() - local.startTimeMs < MAX_ACTIVE_WALK_AGE_MS &&
      !hasMatchingTerminalHandoff(local)) return false;
  const check = reconcileActiveWalkImpl();
  startupStaleCheck = check;
  try {
    await check;
  } catch (error) {
    if (!error || error.code !== "WALK_ABANDONED") throw error;
  } finally {
    if (startupStaleCheck === check) startupStaleCheck = null;
  }
  return true;
}

module.exports = {
  cleanupStaleActiveWalk,
  MAX_ACTIVE_WALK_AGE_MS,
  restoreCloudWalk,
  reconcileActiveWalk,
  ACTIVE_WALK_STORAGE_KEY,
  PENDING_WALK_RESULT_STORAGE_KEY,
  ACTIVE_WALK_SESSION_VERSION,
  isValidActiveWalkSession,
  isValidPendingWalkResult,
  getActiveWalkSession,
  createActiveWalkSession,
  clearActiveWalkSession,
  savePendingWalkResult,
  getPendingWalkResult,
  clearPendingWalkResult
};
