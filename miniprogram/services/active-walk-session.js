const ACTIVE_WALK_STORAGE_KEY = "activeWalkSession";
const PENDING_WALK_RESULT_STORAGE_KEY = "pendingWalkResult";
const ACTIVE_WALK_SESSION_VERSION = 2;
const MAX_ACTIVE_WALK_AGE_MS = 12 * 60 * 60 * 1000;
const { isValidPreferences } = require("./walk-records");
const { isValidGeoPoint } = require("../utils/geo");

function isValidCompletionRequest(session) {
  const request = session.completionRequest;
  return request === undefined || Boolean(request && request.walkId === session.walkId &&
    ["completed", "ended_early"].includes(request.completionStatus) &&
    Number.isSafeInteger(request.endTimeMs) && request.endTimeMs >= session.startTimeMs &&
    request.endTimeMs <= Date.now() + 60000 && typeof request.trajectoryPartial === "boolean");
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
    session.startTimeMs <= Date.now() + 60000 &&
    isValidCompletionRequest(session) &&
    (
      session.trackingEnabled === undefined ||
      typeof session.trackingEnabled === "boolean"
    )
  );
}

function isCompletedActiveWalkSession(session) {
  const pendingResult = getPendingWalkResult();

  if (!pendingResult) {
    return false;
  }

  const pendingStartTimeMs =
    Date.parse(pendingResult.startTime);

  return (
    pendingResult.walkId === session.walkId &&
    pendingResult.routeId === session.routeId &&
    Number.isFinite(pendingStartTimeMs) &&
    pendingStartTimeMs === session.startTimeMs
  );
}

function isStaleActiveWalkSession(
  session,
  nowMs = Date.now()
) {
  return (
    Number.isFinite(nowMs) &&
    nowMs >= session.startTimeMs &&
    nowMs - session.startTimeMs >=
      MAX_ACTIVE_WALK_AGE_MS
  );
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

  if (
    isCompletedActiveWalkSession(session)
  ) {
    require("./walking-tracker").stopTrackingForSession(session);
    wx.removeStorageSync(ACTIVE_WALK_STORAGE_KEY);
    return null;
  }

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
    typeof result.routeId === "string" &&
    result.routeId.trim() !== "" &&
    isValidRouteSnapshot(result.route) &&
    result.route.routeId === result.routeId &&
    typeof result.startTime === "string" &&
    typeof result.endTime === "string" &&
    Number.isFinite(result.actualDurationSeconds) &&
    result.actualDurationSeconds >= 0 &&
    ["completed", "ended_early"].includes(result.completionStatus)
  );
}

function savePendingWalkResult(result) {
  if (!isValidPendingWalkResult(result)) {
    throw new Error("Invalid pending walk result.");
  }

  wx.setStorageSync(PENDING_WALK_RESULT_STORAGE_KEY, result);
  return result;
}

function getPendingWalkResult() {
  const result = wx.getStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);

  if (!result) {
    return null;
  }

  if (!isValidPendingWalkResult(result)) {
    wx.removeStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
    return null;
  }

  return result;
}

function clearPendingWalkResult() {
  wx.removeStorageSync(PENDING_WALK_RESULT_STORAGE_KEY);
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

async function reconcileActiveWalk(route = null) {
  const records = require("./walk-records");
  const local = getActiveWalkSession();
  if (local) {
    const cloud = await records.getWalk(local.walkId);
    if (cloud.status === "active") {
      if (cloud.routeId !== local.routeId || Date.parse(cloud.startTime) !== local.startTimeMs) {
        throw new Error("Local walk does not match cloud identity.");
      }
      return local;
    }
    require("./walking-tracker").stopTrackingForSession(local);
    try { savePendingWalkResult({ ...cloud, route: local.route }); }
    finally { clearActiveWalkSession(local.routeId, local.walkId); }
    return null;
  }
  const cloud = await records.getActiveWalk();
  return cloud ? restoreCloudWalk(cloud, route) : null;
}

module.exports = {
  restoreCloudWalk,
  reconcileActiveWalk,
  ACTIVE_WALK_STORAGE_KEY,
  PENDING_WALK_RESULT_STORAGE_KEY,
  ACTIVE_WALK_SESSION_VERSION,
  MAX_ACTIVE_WALK_AGE_MS,
  isValidActiveWalkSession,
  isStaleActiveWalkSession,
  isValidPendingWalkResult,
  getActiveWalkSession,
  createActiveWalkSession,
  clearActiveWalkSession,
  savePendingWalkResult,
  getPendingWalkResult,
  clearPendingWalkResult
};
