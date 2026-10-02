const ACTIVE_WALK_STORAGE_KEY = "activeWalkSession";
const PENDING_WALK_RESULT_STORAGE_KEY = "pendingWalkResult";
const ACTIVE_WALK_SESSION_VERSION = 1;

function isValidRouteSnapshot(route) {
  return (
    route &&
    typeof route === "object" &&
    !Array.isArray(route) &&
    typeof route.routeId === "string" &&
    route.routeId.trim() !== ""
  );
}

function hasValidTrackingPreference(session) {
  return (
    session.trackingEnabled === undefined ||
    typeof session.trackingEnabled === "boolean"
  );
}

function isValidActiveWalkSession(session) {
  return (
    session &&
    typeof session === "object" &&
    !Array.isArray(session) &&
    session.version === ACTIVE_WALK_SESSION_VERSION &&
    session.status === "active" &&
    typeof session.routeId === "string" &&
    session.routeId.trim() !== "" &&
    isValidRouteSnapshot(session.route) &&
    session.route.routeId === session.routeId &&
    Number.isFinite(session.startTimeMs) &&
    session.startTimeMs > 0 &&
    hasValidTrackingPreference(session)
  );
}

function getActiveWalkSession() {
  const session = wx.getStorageSync(ACTIVE_WALK_STORAGE_KEY);

  if (!session) {
    return null;
  }

  if (!isValidActiveWalkSession(session)) {
    wx.removeStorageSync(ACTIVE_WALK_STORAGE_KEY);
    return null;
  }

  return session;
}

function createActiveWalkSession(
  route,
  startTimeMs = Date.now(),
  { trackingEnabled = false } = {}
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

  const session = {
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

function clearActiveWalkSession(routeId = null) {
  const activeSession = getActiveWalkSession();

  if (!activeSession) {
    return true;
  }

  if (routeId && activeSession.routeId !== routeId) {
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
    ["completed", "ended_early"].includes(
      result.completionStatus
    ) &&
    (
      result.trajectoryEnabled === undefined ||
      typeof result.trajectoryEnabled === "boolean"
    )
  );
}

function savePendingWalkResult(result) {
  if (!isValidPendingWalkResult(result)) {
    throw new Error("Invalid pending walk result.");
  }

  wx.setStorageSync(
    PENDING_WALK_RESULT_STORAGE_KEY,
    result
  );
  return result;
}

function getPendingWalkResult() {
  const result = wx.getStorageSync(
    PENDING_WALK_RESULT_STORAGE_KEY
  );

  if (!result) {
    return null;
  }

  if (!isValidPendingWalkResult(result)) {
    wx.removeStorageSync(
      PENDING_WALK_RESULT_STORAGE_KEY
    );
    return null;
  }

  return result;
}

function clearPendingWalkResult() {
  wx.removeStorageSync(
    PENDING_WALK_RESULT_STORAGE_KEY
  );
}

module.exports = {
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
