const { createWalkHandler } = require('../cloudfunctions/walkStore/handler');
const { createTestStore } = require('../cloudfunctions/mapProvider/test-store');
const { mockRoutes } = require('../miniprogram/data/mock-routes');
const preferences = { durationMinutes: 30, routeType: 'loop', crowdPreference: 'medium', environmentPreferences: ['公园'] };
const route = mockRoutes[0];
let records, sessions, storage, store, handle, tracker;
beforeEach(() => {
  jest.resetModules();
  store = createTestStore(); storage = {};
  handle = createWalkHandler({ store, getOpenId: () => 'user', sleep: async () => {} });
  tracker = { stopTrackingForSession: jest.fn() };
  jest.doMock('../miniprogram/services/walking-tracker', () => tracker);
  global.wx = {
    cloud: { callFunction: jest.fn(async ({ data }) => ({ result: await handle(data) })) },
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; }
  };
  records = require('../miniprogram/services/walk-records');
  sessions = require('../miniprogram/services/active-walk-session');
});
afterEach(() => { delete global.wx; jest.dontMock('../miniprogram/services/walking-tracker'); });
const start = () => records.startWalk({ routeId: route.routeId, preferences, trajectoryEnabled: true });
test('malformed questionnaire geometry is rejected before any cloud request', async () => {
  await expect(records.startWalk({ routeId: route.routeId,
    preferences: { ...preferences, environmentPreferences: [route.startPoint] }, trajectoryEnabled: false })).rejects.toThrow();
  expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});
test.each(['park', 'water', 'shoppingStreet'])('client rejects internal provider token %s before cloud request', async environmentPreference => {
  await expect(records.startWalk({
    routeId: route.routeId,
    preferences: {
      ...preferences,
      environmentPreferences: [environmentPreference]
    },
    trajectoryEnabled: false
  })).rejects.toThrow();
  expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});

test.each([1, 14, 121, 720])('client rejects out-of-product duration %s before cloud request', async durationMinutes => {
  await expect(records.startWalk({
    routeId: route.routeId,
    preferences: { ...preferences, durationMinutes },
    trajectoryEnabled: false
  })).rejects.toThrow();
  expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});
test.each([15, 120])('client accepts product duration boundary %s', async durationMinutes => {
  const walk = await records.startWalk({
    routeId: route.routeId,
    preferences: { ...preferences, durationMinutes },
    trajectoryEnabled: false
  });
  expect(walk.preferences.durationMinutes).toBe(durationMinutes);
});

test('service sends only safe metadata and validates real backend responses', async () => {
  const walk = await records.startWalk({ routeId: route.routeId, route, polyline: route.polyline,
    selectedWaypointIds: ['poi'], preferences: { ...preferences, location: route.startPoint }, trajectoryEnabled: true });
  expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'walkStore', data: {
    action: 'startWalk', routeId: route.routeId, preferences, trajectoryEnabled: true
  } });
  expect((await records.getWalk(walk.walkId)).walkId).toBe(walk.walkId);
  await records.completeWalk({ walkId: walk.walkId, completionStatus: 'completed', endTimeMs: Date.now(), trajectoryPartial: true, route });
  expect(wx.cloud.callFunction.mock.calls.at(-1)[0].data).not.toHaveProperty('route');
});
test.each([{}, { walk: null }, { walk: { walkId: 'x' } }])('rejects malformed success %j', async response => {
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, ...response } });
  await expect(start()).rejects.toThrow();
});
test('valid-looking response with wrong identity or completion state is rejected', async () => {
  const walk = await start();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, walk } });
  await expect(records.getWalk('different')).rejects.toThrow();
  await expect(records.completeWalk({ walkId: walk.walkId, completionStatus: 'completed' })).rejects.toThrow();
});
test('client accepts abandoned lifecycle reads and maps stale completion to WALK_ABANDONED', async () => {
  const walk = await start();
  const abandoned = {
    ...walk,
    status: 'abandoned',
    completionStatus: 'abandoned',
    endTime: null,
    actualDurationSeconds: null,
    trajectoryPartial: true,
    trajectoryEndTimeMs: null
  };
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, walk: abandoned } });
  await expect(records.getWalk(walk.walkId)).resolves.toMatchObject({
    walkId: walk.walkId,
    status: 'abandoned'
  });
  await expect(records.completeWalk({
    walkId: walk.walkId,
    completionStatus: 'completed',
    endTimeMs: Date.now(),
    trajectoryPartial: true
  })).rejects.toMatchObject({ code: 'WALK_ABANDONED' });
});

test('v2 session requires durable identity; v1 never becomes durable implicitly', async () => {
  expect(() => sessions.createActiveWalkSession(route)).toThrow();
  storage.activeWalkSession = { version: 1, status: 'active', routeId: route.routeId, route, startTimeMs: Date.now() };
  expect(sessions.getActiveWalkSession()).toBeNull();
  expect(tracker.stopTrackingForSession).toHaveBeenCalledTimes(1);
  const walk = await start();
  const session = sessions.restoreCloudWalk(walk, route);
  expect(session).toMatchObject({ version: 2, walkId: walk.walkId, preferences });
  expect(sessions.isValidActiveWalkSession(session)).toBeTruthy();
  expect(sessions.isValidActiveWalkSession({ ...session, walkId: '' })).toBeFalsy();
  expect(sessions.isValidActiveWalkSession({ ...session, preferences: {} })).toBeFalsy();
  expect(sessions.isValidActiveWalkSession({ ...session, completionRequest: {
    walkId: 'different', completionStatus: 'completed', endTimeMs: Date.now(), trajectoryPartial: true
  } })).toBeFalsy();
  expect(sessions.clearActiveWalkSession(route.routeId, 'different')).toBe(false);
  expect(storage.activeWalkSession.walkId).toBe(walk.walkId);
});
test('local plus matching cloud resumes original identity and locked route', async () => {
  const walk = await start();
  const local = sessions.restoreCloudWalk(walk, route);
  expect(await sessions.reconcileActiveWalk(mockRoutes[1])).toEqual(local);
});
test.each(['completed', 'ended_early'])('cloud %s clears stale active session and tracking, recovers Feedback payload', async completionStatus => {
  const walk = await start();
  const local = sessions.restoreCloudWalk(walk, route);
  await records.completeWalk({ walkId: walk.walkId, completionStatus, endTimeMs: Date.now(), trajectoryPartial: true });
  expect(await sessions.reconcileActiveWalk()).toBeNull();
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toMatchObject({ walkId: walk.walkId, completionStatus });
  expect(storage.pendingWalkResult).not.toHaveProperty('route');
  expect(tracker.stopTrackingForSession).toHaveBeenCalledWith(local);
});
test('cloud abandonment clears local tracking without creating a Feedback payload', async () => {
  const walk = await start();
  const local = sessions.restoreCloudWalk(walk, route);
  const saved = store.documents.get(`walks/${walk.walkId}`);
  saved.startTime = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  await expect(sessions.reconcileActiveWalk()).rejects.toMatchObject({ code: 'WALK_ABANDONED' });
  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(tracker.stopTrackingForSession).toHaveBeenCalledWith(local);
});

test('missing local geometry blocks another route, matching local route can restore cloud active', async () => {
  const walk = await start();
  await expect(sessions.reconcileActiveWalk()).rejects.toMatchObject({ code: 'WALK_ROUTE_UNAVAILABLE' });
  await expect(sessions.reconcileActiveWalk({ ...route, routeId: 'different' })).rejects.toMatchObject({ code: 'WALK_ROUTE_UNAVAILABLE' });
  expect((await sessions.reconcileActiveWalk(route)).walkId).toBe(walk.walkId);
  expect([...store.documents.keys()].filter(id => id.startsWith('walks/'))).toHaveLength(1);
});
test('lost start response retries to the same durable record', async () => {
  store.afterCommit = () => { store.afterCommit = null; throw new Error('lost acknowledgement'); };
  await expect(start()).rejects.toMatchObject({ code: 'WALK_STORE_FAILED' });
  const retry = await start();
  expect((await records.getActiveWalk()).walkId).toBe(retry.walkId);
  expect([...store.documents.keys()].filter(id => id.startsWith('walks/'))).toHaveLength(1);
});
test('database completion failure preserves active state; lost completion response reconciles terminal', async () => {
  const walk = await start(); sessions.restoreCloudWalk(walk, route);
  const request = { walkId: walk.walkId, completionStatus: 'completed', endTimeMs: Date.now(), trajectoryPartial: true };
  store.failure = new Error('unavailable');
  await expect(records.completeWalk(request)).rejects.toThrow();
  expect(storage.activeWalkSession.walkId).toBe(walk.walkId);
  store.failure = null;
  store.afterCommit = () => { store.afterCommit = null; throw new Error('lost'); };
  await expect(records.completeWalk(request)).rejects.toThrow();
  expect(await sessions.reconcileActiveWalk()).toBeNull();
  expect(storage.pendingWalkResult.completionStatus).toBe('completed');
});

test('final trajectory metadata is durably written back after completion', async () => {
  const walk = await start();
  const confirmedAt = Date.now();
  const terminal = await records.completeWalk({
    walkId: walk.walkId,
    completionStatus: 'completed',
    endTimeMs: confirmedAt,
    trajectoryPartial: true
  });
  const finalBoundary = confirmedAt + 5000;
  const updated = await records.updateTrajectoryMetadata({
    walkId: walk.walkId,
    trajectoryPartial: false,
    trajectoryEndTimeMs: finalBoundary
  });
  expect(wx.cloud.callFunction.mock.calls.at(-1)[0]).toEqual({
    name: 'walkStore',
    data: {
      action: 'updateTrajectoryMetadata',
      walkId: walk.walkId,
      trajectoryPartial: false,
      trajectoryEndTimeMs: finalBoundary
    }
  });
  expect(updated).toMatchObject({
    status: 'completed',
    endTime: terminal.endTime,
    actualDurationSeconds: terminal.actualDurationSeconds,
    trajectoryPartial: false,
    trajectoryEndTimeMs: finalBoundary
  });
});

test('pending completion results require the durable walkId identity', async () => {
  const valid = {
    walkId: 'walk-1',
    routeId: route.routeId,
    route,
    startTime: new Date(Date.now() - 1000).toISOString(),
    endTime: new Date().toISOString(),
    actualDurationSeconds: 1,
    completionStatus: 'completed'
  };
  expect(sessions.isValidPendingWalkResult(valid)).toBe(true);
  expect(sessions.isValidPendingWalkResult({ ...valid, walkId: '' })).toBe(false);
  const { walkId, ...missingWalkId } = valid;
  expect(sessions.isValidPendingWalkResult(missingWalkId)).toBe(false);
  expect(() => sessions.savePendingWalkResult(missingWalkId)).toThrow('Invalid pending walk result.');
  storage.pendingWalkResult = missingWalkId;
  expect(sessions.getPendingWalkResult()).toBeNull();
  expect(storage.pendingWalkResult).toBeUndefined();
});
