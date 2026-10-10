const { mockRoutes } = require('../miniprogram/data/mock-routes');
const route = mockRoutes[0];
const preferences = { durationMinutes: 30, routeType: 'loop',
  crowdPreference: 'medium', environmentPreferences: ['公园'] };
let sessions, storage, records, tracking;
const local = (at = Date.now() - 60000, walkId = 'walk-old') => ({
  version: 2, status: 'active', walkId, routeId: route.routeId,
  route, startTimeMs: at, preferences, trackingEnabled: true
});
const terminal = walk => ({
  walkId: walk.walkId, routeId: walk.routeId, status: 'completed',
  completionStatus: 'completed', startTime: new Date(walk.startTimeMs).toISOString(),
  endTime: new Date(walk.startTimeMs + 1000).toISOString(),
  actualDurationSeconds: 1, trajectoryEnabled: true,
  trajectoryPartial: false, trajectoryEndTimeMs: walk.startTimeMs + 1000
});
beforeEach(() => {
  jest.resetModules(); jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-11T04:00:00.000Z'));
  storage = {};
  records = { isValidPreferences: () => true, getWalk: jest.fn(),
    getActiveWalk: jest.fn().mockResolvedValue(null) };
  tracking = { stopTrackingForSession: jest.fn() };
  jest.doMock('../miniprogram/services/walk-records', () => records);
  jest.doMock('../miniprogram/services/walking-tracker', () => tracking);
  global.wx = {
    getStorageSync: jest.fn(key => storage[key]),
    setStorageSync: jest.fn((key, value) => { storage[key] = value; }),
    removeStorageSync: jest.fn(key => { delete storage[key]; })
  };
  sessions = require('../miniprogram/services/active-walk-session');
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); delete global.wx; });

test('terminal handoff stores no route or POI data', () => {
  const walk = local();
  const result = sessions.savePendingWalkResult({ ...terminal(walk), route,
    pointsOfInterest: route.pointsOfInterest, polyline: route.polyline });
  expect(result).toEqual(storage.pendingWalkResult);
  for (const key of ['route', 'pointsOfInterest', 'polyline'])
    expect(result).not.toHaveProperty(key);
});
test('legacy terminal snapshot is sanitized on read, idempotently', () => {
  const walk = local();
  storage.pendingWalkResult = { ...terminal(walk), route, polyline: route.polyline };
  expect(sessions.getPendingWalkResult()).not.toHaveProperty('route');
  expect(storage.pendingWalkResult).not.toHaveProperty('polyline');
  expect(sessions.getPendingWalkResult()).toMatchObject({ walkId: walk.walkId });
  expect(wx.setStorageSync).toHaveBeenCalledTimes(1);
});
test('failed legacy storage rewrite returns safe metadata and retries next time', () => {
  const walk = local(); storage.pendingWalkResult = { ...terminal(walk), route };
  wx.setStorageSync.mockImplementationOnce(() => { throw new Error('unavailable'); });
  expect(sessions.getPendingWalkResult()).not.toHaveProperty('route');
  expect(storage.pendingWalkResult).toHaveProperty('route');
  sessions.getPendingWalkResult();
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
});
test('server-active walk remains locked after local 12-hour threshold', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  records.getWalk.mockResolvedValue({ walkId: walk.walkId, routeId: walk.routeId,
    status: 'active', startTime: new Date(walk.startTimeMs).toISOString() });
  expect(await sessions.cleanupStaleActiveWalk()).toBe(true);
  expect(storage.activeWalkSession).toBe(walk);
  expect(tracking.stopTrackingForSession).not.toHaveBeenCalled();
});
test('server abandonment clears stale route with no Feedback record', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  records.getWalk.mockResolvedValue({ status: 'abandoned' });
  expect(await sessions.cleanupStaleActiveWalk()).toBe(true);
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(tracking.stopTrackingForSession).toHaveBeenCalledWith(walk);
});
test('terminal cloud status removes full route but recovers optional Feedback metadata', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  records.getWalk.mockResolvedValue(terminal(walk));
  expect(await sessions.cleanupStaleActiveWalk()).toBe(true);
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toEqual(terminal(walk));
});
test('cloud outage leaves original stale Walk recoverable', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  records.getWalk.mockRejectedValue(new Error('offline'));
  await expect(sessions.cleanupStaleActiveWalk()).rejects.toThrow('offline');
  expect(storage.activeWalkSession).toBe(walk);
  expect(tracking.stopTrackingForSession).not.toHaveBeenCalled();
});
test('young session does not trigger launch cleanup', async () => {
  storage.activeWalkSession = local();
  expect(await sessions.cleanupStaleActiveWalk()).toBe(false);
  expect(records.getWalk).not.toHaveBeenCalled();
});
test('late cloud response cannot erase newer active Walk identity', async () => {
  const old = local(); storage.activeWalkSession = old;
  let resolve;
  records.getWalk.mockImplementation(() => new Promise(done => { resolve = done; }));
  const request = sessions.reconcileActiveWalk();
  const next = local(Date.now() - 1000, 'walk-new');
  storage.activeWalkSession = next;
  resolve(terminal(old));
  await expect(request).rejects.toMatchObject({ code: 'WALK_STATE_CHANGED' });
  expect(storage.activeWalkSession).toBe(next);
  expect(storage.pendingWalkResult).toBeUndefined();
});
test('old terminal reconcile does not overwrite unrelated newer Feedback', async () => {
  const walk = local(), next = local(Date.now() - 1000, 'walk-new');
  storage.activeWalkSession = walk; storage.pendingWalkResult = terminal(next);
  records.getWalk.mockResolvedValue(terminal(walk));
  expect(await sessions.reconcileActiveWalk()).toBeNull();
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult.walkId).toBe('walk-new');
});
test('cold launch checks old session and cleans up after cloud reply', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  records.getWalk.mockResolvedValue({ status: 'abandoned' });
  wx.cloud = { init: jest.fn() };
  global.App = jest.fn(d => d.onLaunch());
  try { require('../miniprogram/app'); await Promise.resolve(); await Promise.resolve();
    expect(wx.cloud.init).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkSession).toBeUndefined();
  } finally { delete global.App; }
});
