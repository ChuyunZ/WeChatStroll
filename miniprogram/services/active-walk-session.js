const ACTIVE_WALK_STORAGE_KEY = "activeWalkSession";
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
    session.startTimeMs > 0
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

function createActiveWalkSession(route, startTimeMs = Date.now()) {
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
    startTimeMs
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

module.exports = {
  ACTIVE_WALK_STORAGE_KEY,
  ACTIVE_WALK_SESSION_VERSION,
  isValidActiveWalkSession,
  getActiveWalkSession,
  createActiveWalkSession,
  clearActiveWalkSession
};
