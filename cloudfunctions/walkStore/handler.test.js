const { createWalkHandler } = require('./handler');
const { createTestStore } = require('../mapProvider/test-store');
const preferences = { durationMinutes: 30, routeType: 'loop', crowdPreference: 'low', environmentPreferences: ['公园'] };
const start = { action: 'startWalk', routeId: 'route-1', preferences, trajectoryEnabled: true };
const now = Date.parse('2026-10-06T10:00:00Z');
function fixture() {
  const store = createTestStore();
  const handler = user => createWalkHandler({ store, getOpenId: () => user, now: () => now, sleep: async () => {} });
  return { store, handler, call: handler('user-a') };
}
test('authenticated create allowlists safe metadata; no client ownership or geometry is stored', async () => {
  const f = fixture();
  const response = await f.call({ ...start, openid: 'victim', route: { polyline: [1] }, providerMeta: {},
    selectedWaypointIds: ['provider-poi'], preferences: { ...preferences, location: { latitude: 1 } } });
  expect(response).toMatchObject({ success: true, walk: { status: 'active', schemaVersion: 1, preferences } });
  const saved = f.store.documents.get(`walks/${response.walk.walkId}`);
  expect(saved.ownerKey).toMatch(/^[a-f0-9]{64}$/);
  expect(response.walk.ownerKey).toBeUndefined();
  expect(Object.keys(saved).sort()).toEqual(['walkId','ownerKey','status','routeId','preferences',
    'requestedDurationMinutes','routeType','startTime','endTime','actualDurationSeconds','completionStatus',
    'trajectoryEnabled','trajectoryPartial','trajectoryEndTimeMs','schemaVersion','createdAt','updatedAt'].sort());
  expect(saved.preferences).toEqual(preferences);
});
test.each([1, 14, 121, 720])('rejects out-of-product duration %s', async durationMinutes => {
  const f = fixture();
  const response = await f.call({
    ...start,
    preferences: { ...preferences, durationMinutes }
  });
  expect(response).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
  expect(f.store.documents.size).toBe(0);
});
test.each([15, 120])('accepts product duration boundary %s', async durationMinutes => {
  const f = fixture();
  const response = await f.call({
    ...start,
    preferences: { ...preferences, durationMinutes }
  });
  expect(response).toMatchObject({
    success: true,
    walk: { preferences: { durationMinutes } }
  });
});

test('unauthenticated and unsupported calls fail without writing', async () => {
  const f = fixture();
  expect(await f.handler('')({ ...start, openid: 'forged' })).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
  expect(await f.call({ action: 'delete' })).toMatchObject({ success: false, error: { code: 'INVALID_ACTION' } });
  expect(f.store.documents.size).toBe(0);
});
test('concurrent instances and response-lost retry return exactly one active walk', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.call(start), f.handler('user-a')({ ...start, routeId: 'different' })]);
  expect(a.walk.walkId).toBe(b.walk.walkId);
  expect(f.store.conflicts).toBeGreaterThan(0);
  expect((await f.call(start)).walk).toEqual(a.walk);
  expect([...f.store.documents.keys()].filter(key => key.startsWith('walks/'))).toHaveLength(1);
});
test('commit acknowledgement loss is retryable without another walk', async () => {
  const f = fixture();
  f.store.afterCommit = () => { f.store.afterCommit = null; throw new Error('response lost'); };
  expect((await f.call(start)).success).toBe(false);
  expect((await f.call(start)).success).toBe(true);
  expect([...f.store.documents.keys()].filter(key => key.startsWith('walks/'))).toHaveLength(1);
});
test('users have independent locks and cannot read or finalize another user record', async () => {
  const f = fixture();
  expect((await f.call({ action: 'getActiveWalk' })).walk).toBeNull();
  const a = (await f.call(start)).walk;
  const b = (await f.handler('user-b')(start)).walk;
  expect(b.walkId).not.toBe(a.walkId);
  expect((await f.call({ action: 'getActiveWalk' })).walk.walkId).toBe(a.walkId);
  expect((await f.call({ action: 'getWalk', walkId: a.walkId })).walk).toEqual(a);
  for (const action of ['getWalk', 'completeWalk']) {
    expect(await f.handler('user-b')({ action, walkId: a.walkId, completionStatus: 'completed', endTimeMs: now }))
      .toMatchObject({ success: false, error: { code: 'WALK_NOT_FOUND' } });
  }
});
test.each(['completed', 'ended_early'])('%s updates the same record, releases lock, and is irreversible', async status => {
  const f = fixture();
  const { walk } = await f.call(start);
  const request = { action: 'completeWalk', walkId: walk.walkId, completionStatus: status, endTimeMs: now + 1000, trajectoryPartial: true };
  const [a, b] = await Promise.all([f.call(request), f.call(request)]);
  expect(a).toEqual(b);
  expect(a.walk).toMatchObject({ walkId: walk.walkId, status, actualDurationSeconds: 1 });
  expect((await f.call({ ...request, endTimeMs: now + 2000 })).walk).toEqual(a.walk);
  expect((await f.call({ action: 'getActiveWalk' })).walk).toBeNull();
  expect(await f.call({ ...request, completionStatus: status === 'completed' ? 'ended_early' : 'completed' }))
    .toMatchObject({ success: false, error: { code: 'WALK_STATE_CONFLICT' } });
  expect((await f.call(start)).walk.walkId).not.toBe(walk.walkId);
  expect((await f.call({ action: 'getWalk', walkId: walk.walkId })).walk.status).toBe(status);
});
test('database errors never claim success; conflicts have a four-attempt bound', async () => {
  const f = fixture();
  f.store.forcedConflicts = 2;
  expect((await f.call(start)).success).toBe(true);
  expect(f.store.transactions).toBe(3);
  f.store.forcedConflicts = 10;
  expect((await f.call(start)).success).toBe(false);
  expect(f.store.transactions).toBe(7);
  f.store.failure = new Error('private database details');
  expect(await f.call(start)).toEqual({ success: false, error: {
    code: 'WALK_STORE_FAILED', message: 'Walk storage is temporarily unavailable.'
  } });
  expect(f.store.transactions).toBe(8);
});
test.each([NaN, 'yesterday', -1, now - 1, now + 60001])('rejects impossible completion time %s', async endTimeMs => {
  const f = fixture(); const { walk } = await f.call(start);
  expect((await f.call({ action: 'completeWalk', walkId: walk.walkId, completionStatus: 'completed', endTimeMs, trajectoryPartial: false })).success).toBe(false);
  expect((await f.call({ action: 'getActiveWalk' })).walk.status).toBe('active');
});
