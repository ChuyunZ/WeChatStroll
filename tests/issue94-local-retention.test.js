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
test('failed legacy rewrite discards the full-route cache but returns sanitized metadata', () => {
  const walk = local(); storage.pendingWalkResult = { ...terminal(walk), route };
  wx.setStorageSync.mockImplementationOnce(() => { throw new Error('unavailable'); });
  expect(sessions.getPendingWalkResult()).toMatchObject({ walkId: walk.walkId });
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(wx.removeStorageSync).toHaveBeenCalledWith('pendingWalkResult');
});
test('legacy cleanup retries when both storage rewrite and removal fail', () => {
  const walk = local(); storage.pendingWalkResult = { ...terminal(walk), route };
  wx.setStorageSync.mockImplementationOnce(() => { throw new Error('unavailable'); });
  wx.removeStorageSync.mockImplementationOnce(() => { throw new Error('unavailable'); });
  expect(sessions.getPendingWalkResult()).not.toHaveProperty('route');
  expect(storage.pendingWalkResult).toHaveProperty('route');
  expect(sessions.getPendingWalkResult()).toMatchObject({ walkId: walk.walkId });
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
});
test('malformed optional trajectory fields and timestamp are rejected', () => {
  const walk = local(), result = terminal(walk);
  expect(sessions.isValidPendingWalkResult({ ...result, trajectoryPartial: 'false' })).toBe(false);
  expect(sessions.isValidPendingWalkResult({ ...result, trajectoryEnabled: 1 })).toBe(false);
  expect(sessions.isValidPendingWalkResult({ ...result, trajectoryEndTimeMs: -1 })).toBe(false);
  expect(sessions.isValidPendingWalkResult({ ...result, startTime: 'broken' })).toBe(false);
  expect(sessions.isValidPendingWalkResult(result)).toBe(true);
});
test('clock skew cannot discard an otherwise valid local route without cloud verification', async () => {
  const future = local(Date.now() + 2 * 60 * 60 * 1000);
  future.completionRequest = { walkId: future.walkId, completionStatus: 'completed',
    endTimeMs: future.startTimeMs + 2000, trajectoryPartial: false };
  storage.activeWalkSession = future;
  expect(sessions.getActiveWalkSession()).toBe(future);
  expect(await sessions.cleanupStaleActiveWalk()).toBe(false);
  records.getWalk.mockResolvedValue({ walkId: future.walkId, routeId: future.routeId,
    status: 'active', startTime: new Date(future.startTimeMs).toISOString() });
  expect(await sessions.reconcileActiveWalk()).toBe(future);
  expect(storage.activeWalkSession).toBe(future);
  expect(wx.removeStorageSync).not.toHaveBeenCalledWith('activeWalkSession');
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
  expect(storage.pendingWalkResult).toMatchObject({
    walkId: walk.walkId, routeId: walk.routeId, completionStatus: 'completed',
    actualDurationSeconds: 1
  });
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
  expect(storage.pendingWalkResult).not.toHaveProperty('status');
});
test.each([['offline', 13], ['active', 13], ['offline', 1], ['active', 1]])(
  'matching pending Feedback cannot erase a Walk before cloud confirmation (%s, age=%i hours)',
  async (cloudState, ageHours) => {
    const walk = local(Date.now() - ageHours * 60 * 60 * 1000);
    storage.activeWalkSession = walk;
    storage.pendingWalkResult = terminal(walk);
    if (cloudState === 'offline') records.getWalk.mockRejectedValue(new Error('offline'));
    else records.getWalk.mockResolvedValue({
      walkId: walk.walkId, routeId: walk.routeId, status: 'active',
      startTime: new Date(walk.startTimeMs).toISOString()
    });

    // A read and the startup age check must not trust local Feedback as a
    // replacement for an authoritative CloudBase terminal response.
    expect(sessions.getActiveWalkSession()).toBe(walk);
    if (cloudState === 'offline') {
      await expect(sessions.cleanupStaleActiveWalk()).rejects.toThrow('offline');
    } else {
      await expect(sessions.cleanupStaleActiveWalk()).resolves.toBe(true);
    }
    expect(records.getWalk).toHaveBeenCalledWith(walk.walkId);
    expect(storage.activeWalkSession).toBe(walk);
    expect(storage.pendingWalkResult.walkId).toBe(walk.walkId);
    expect(tracking.stopTrackingForSession).not.toHaveBeenCalled();
    expect(wx.removeStorageSync).not.toHaveBeenCalledWith('activeWalkSession');
  }
);
test.each([1, 13])('matching pending Feedback is cleared only after cloud confirms terminal (age=%i hours)', async ageHours => {
  const walk = local(Date.now() - ageHours * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  storage.pendingWalkResult = terminal(walk);
  records.getWalk.mockResolvedValue(terminal(walk));
  expect(sessions.getActiveWalkSession()).toBe(walk);
  expect(storage.activeWalkSession).toBe(walk);
  await expect(sessions.cleanupStaleActiveWalk()).resolves.toBe(true);
  expect(records.getWalk).toHaveBeenCalledWith(walk.walkId);
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
  expect(tracking.stopTrackingForSession).toHaveBeenCalledWith(walk);
});
test('foreground recovery checks CloudBase even with a matching pending handoff', async () => {
  const walk = local();
  storage.activeWalkSession = walk;
  storage.pendingWalkResult = terminal(walk);
  records.getWalk.mockResolvedValue({
    walkId: walk.walkId, routeId: walk.routeId, status: 'active',
    startTime: new Date(walk.startTimeMs).toISOString()
  });
  expect(await sessions.reconcileActiveWalk()).toBe(walk);
  expect(storage.activeWalkSession).toBe(walk);
  expect(records.getWalk).toHaveBeenCalledWith(walk.walkId);
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
test('foreground resume awaits cold-launch cleanup for the same old Walk', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  let resolve;
  records.getWalk.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const cold = sessions.cleanupStaleActiveWalk();
  const foreground = sessions.reconcileActiveWalk();
  expect(records.getWalk).toHaveBeenCalledTimes(1);
  resolve(terminal(walk));
  await cold;
  await expect(foreground).resolves.toBeNull();
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
  expect(records.getWalk).toHaveBeenCalledTimes(1);
  expect(records.getActiveWalk).toHaveBeenCalledTimes(1);
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

test('startup still checks aged Walk when corrupted terminal handoff cleanup throws', async () => {
  const walk = local(Date.now() - 13 * 60 * 60 * 1000);
  storage.activeWalkSession = walk;
  storage.pendingWalkResult = { broken: 'legacy' };
  wx.removeStorageSync.mockImplementation(key => {
    if (key === 'pendingWalkResult') throw new Error('storage unavailable');
    delete storage[key];
  });
  records.getWalk.mockResolvedValue({ status: 'abandoned' });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  wx.cloud = { init: jest.fn() };
  global.App = jest.fn(definition => definition.onLaunch());
  try {
    require('../miniprogram/app');
    await Promise.resolve(); await Promise.resolve();
    expect(records.getWalk).toHaveBeenCalledWith(walk.walkId);
    expect(storage.activeWalkSession).toBeUndefined();
    expect(storage.pendingWalkResult).toEqual({ broken: 'legacy' });
  } finally {
    warn.mockRestore(); log.mockRestore(); delete global.App;
  }
});
