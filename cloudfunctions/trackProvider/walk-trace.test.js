const { createTrackHandler, MAX_TRACE_QUERY_MS } = require('./handler');
const { validateTraceResponse, MAX_TRACE_POINTS } = require('./trace-schema');
const { testWalk, START_MS, END_MS } = require('./test-walk');
function fixture(changes = {}, openid = 'openid-one') {
  const walk = changes === null ? null : testWalk(changes);
  const walkStore = { getWalk: jest.fn().mockResolvedValue(walk) };
  const client = { ensureEntity: jest.fn().mockResolvedValue({}), searchTrace: jest.fn().mockResolvedValue({ points: [], mileageMeters: 0, durationSeconds: 0 }) };
  const log = jest.fn();
  const historyLimiter = { reserve: jest.fn().mockResolvedValue() };
  const handler = createTrackHandler({ config: { entitySecret: 'synthetic-secret' }, client, walkStore,
    getOpenId: () => openid, getNowMs: () => END_MS + MAX_TRACE_QUERY_MS * 2, log, historyLimiter });
  return { handler, client, walkStore, walk, log, historyLimiter };
}
const request = { action: 'searchWalkTrace', walkId: 'walk-1' };
const rawPoint = (timestampMs = START_MS + 1000, extra = {}) => ({ lat: 31, lng: 121, loctime: timestampMs / 1000, ...extra });
function noProvider(f) { expect(f.client.ensureEntity).not.toHaveBeenCalled(); expect(f.client.searchTrace).not.toHaveBeenCalled(); expect(f.historyLimiter.reserve).not.toHaveBeenCalled(); }
test.each([null, '', ' ', 42, {}])('invalid authentication %j never reads data or prepares an entity', async openid => {
  const f = fixture({}, openid); expect((await f.handler(request)).error.code).toBe('UNAUTHENTICATED');
  expect(f.walkStore.getWalk).not.toHaveBeenCalled(); noProvider(f);
});
test.each([undefined, null, '', '../walk', 'x/y', 'x'.repeat(201), {}, 42])('invalid identity %j fails before reads/provider calls', async walkId => {
  const f = fixture(); expect((await f.handler({ ...request, walkId })).error.code).toBe('INVALID_WALK_TRACE_REQUEST');
  expect(f.walkStore.getWalk).not.toHaveBeenCalled(); noProvider(f);
});
test.each(['openid', 'OpenID', 'OPENID', 'ownerKey', 'entityId', 'entity_id', 'startTimeMs', 'endTimeMs', 'trajectoryPartial', 'trajectoryEnabled', 'range', 'userInfo'])('rejects injected %s instead of substituting it', async field => {
  const f = fixture(); expect((await f.handler({ ...request, [field]: 'forged' })).error.code).toBe('INVALID_WALK_TRACE_REQUEST');
  expect(f.walkStore.getWalk).not.toHaveBeenCalled(); noProvider(f);
});
test('unknown and foreign walk are publicly indistinguishable', async () => {
  const absent = fixture(null), foreign = fixture({ ownerKey: 'another-user', schemaVersion: 99 });
  expect(await absent.handler(request)).toEqual(await foreign.handler(request));
  expect((await absent.handler(request)).error.code).toBe('WALK_NOT_FOUND'); noProvider(absent); noProvider(foreign);
});
test.each([
  { _id: 'different' }, { walkId: 'different' }, { _id: undefined }, { schemaVersion: undefined }, { schemaVersion: 2 },
  { status: 'active' }, { status: 'abandoned' }, { status: 'unknown' }, { completionStatus: 'ended_early' },
  { trajectoryEnabled: 'true' }, { trajectoryEnabled: undefined }, { trajectoryPartial: null }, { trajectoryPartial: 1 },
  { startTime: null }, { endTime: null }, { startTime: '2026-02-30T00:00:00.000Z' },
  { startTime: '2026-10-10' }, { endTime: 1760001800000 }, { startTime: new Date(END_MS + 1).toISOString() },
  { trajectoryEndTimeMs: END_MS - 1 }, { trajectoryEndTimeMs: null }, { trajectoryEndTimeMs: '1760001800000' },
  { trajectoryEndTimeMs: Number.MAX_SAFE_INTEGER + 1 }, { trajectoryEndTimeMs: END_MS + MAX_TRACE_QUERY_MS * 2 + 1 },
  { startTime: new Date(END_MS).toISOString(), trajectoryEndTimeMs: END_MS }
])('invalid persisted lifecycle %j cannot access GPS', async changes => {
  const f = fixture(changes); expect((await f.handler(request)).error.code).toBe('INVALID_WALK_TRACE_METADATA'); noProvider(f);
});
test('non-consented terminal walk has a stable error and never initializes Tencent', async () => {
  const f = fixture({ trajectoryEnabled: false }); expect((await f.handler(request)).error.code).toBe('TRACK_NOT_ENABLED'); noProvider(f);
});
test('database failures and untrusted error codes are redacted', async () => {
  const f = fixture(); f.walkStore.getWalk.mockRejectedValue(Object.assign(new Error('database secret'), { code: 'secret credentials' }));
  const result = await f.handler(request); expect(result.error.code).toBe('TRACK_WALK_READ_FAILED'); noProvider(f);
  expect(JSON.stringify([result, f.log.mock.calls])).not.toMatch(/database secret|secret credentials|ownerKey/);
});
test.each(['completed', 'ended_early'])('authorizes %s before entity preparation, excluding cleanup boundary', async status => {
  const f = fixture({ status, completionStatus: status, trajectoryEndTimeMs: END_MS + 5000, trajectoryPartial: true });
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(END_MS - 3000), rawPoint(END_MS + 3000)], mileageMeters: 100, durationSeconds: 12 });
  const result = await f.handler(request);
  expect(f.walkStore.getWalk).toHaveBeenCalledWith('walk-1');
  expect(f.walkStore.getWalk.mock.invocationCallOrder[0]).toBeLessThan(f.client.ensureEntity.mock.invocationCallOrder[0]);
  expect(f.client.searchTrace).toHaveBeenCalledWith(expect.stringMatching(/^usr_[a-f0-9]{32}$/), START_MS / 1000, END_MS / 1000);
  expect(result.trace).toMatchObject({ available: true, partial: true, retryable: false, mileageMeters: null, durationSeconds: null });
  expect(result.trace.points.map(point => point.timestampMs)).toEqual([END_MS - 3000]);
  expect(() => validateTraceResponse(result)).not.toThrow();
});
test.each([0, 1])('24-hour query limit boundary, extra millisecond=%i', async extra => {
  const f = fixture({ endTime: new Date(START_MS + MAX_TRACE_QUERY_MS + extra).toISOString(),
    trajectoryEndTimeMs: START_MS + MAX_TRACE_QUERY_MS + extra });
  const result = await f.handler(request);
  if (extra) { expect(result.error.code).toBe('TRACK_RANGE_TOO_LARGE'); noProvider(f); }
  else expect(result.success).toBe(true);
});
test.each([60000, 60001, 300000])('cleanup extension of %i milliseconds cannot extend the query', async extension => {
  const f = fixture({ trajectoryEndTimeMs: END_MS + extension });
  const result = await f.handler(request);
  expect(result.success).toBe(true);
  expect(f.client.searchTrace.mock.calls[0][2]).toBe(END_MS / 1000);
  expect(result.trace.partial).toBe(true);
});
test('cleanup beyond 24 hours does not invalidate a safe formal interval', async () => {
  const f = fixture({ trajectoryEndTimeMs: START_MS + MAX_TRACE_QUERY_MS + 1 });
  expect((await f.handler(request)).success).toBe(true);
  expect(f.client.searchTrace.mock.calls[0].slice(1)).toEqual([START_MS / 1000, END_MS / 1000]);
});
test('a response-lost completion retry and delayed cleanup produce a readable persisted interval', async () => {
  const { createWalkHandler } = require('../walkStore/handler');
  const { createTestStore } = require('../mapProvider/test-store');
  const store = createTestStore();
  let now = START_MS;
  const lifecycle = createWalkHandler({ store, getOpenId: () => 'openid-one', now: () => now,
    newId: () => 'walk-1', sleep: async () => {} });
  expect((await lifecycle({ action: 'startWalk', routeId: 'route-1', trajectoryEnabled: true,
    preferences: { durationMinutes: 30, routeType: 'loop', crowdPreference: 'low', environmentPreferences: [] } })).success).toBe(true);
  now = END_MS;
  const completion = { action: 'completeWalk', walkId: 'walk-1', completionStatus: 'completed',
    endTimeMs: END_MS, trajectoryPartial: true };
  store.afterCommit = () => { store.afterCommit = null; throw new Error('completion response lost'); };
  expect((await lifecycle(completion)).success).toBe(false);
  now += 300000;
  expect((await lifecycle(completion)).walk.endTime).toBe(new Date(END_MS).toISOString());
  now += 5000;
  expect((await lifecycle({ action: 'updateTrajectoryMetadata', walkId: 'walk-1',
    trajectoryEndTimeMs: now, trajectoryPartial: false })).success).toBe(true);
  // The transactional fake omits CloudBase's generated _id.
  const f = fixture({ ...store.documents.get('walks/walk-1'), _id: 'walk-1' });
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(END_MS - 1000), rawPoint(now - 1000)] });
  const result = await f.handler(request);
  expect(result.success).toBe(true);
  expect(result.trace.points.map(point => point.timestampMs)).toEqual([END_MS - 1000]);
  expect(result.trace.partial).toBe(true);
  expect(f.client.searchTrace.mock.calls[0].slice(1)).toEqual([START_MS / 1000, END_MS / 1000]);
  expect(() => validateTraceResponse(result)).not.toThrow();
});
test('fractional boundary seconds never return samples potentially belonging to adjacent walks', async () => {
  const f = fixture({ startTime: new Date(START_MS + 250).toISOString(),
    endTime: new Date(END_MS + 5500).toISOString(), trajectoryEndTimeMs: END_MS + 9500 });
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(START_MS - 1000), rawPoint(START_MS), rawPoint(START_MS + 1000),
    rawPoint(END_MS + 4000), rawPoint(END_MS + 5000), rawPoint(END_MS + 6000)], mileageMeters: 123, durationSeconds: 1800 });
  const result = await f.handler(request);
  expect(f.client.searchTrace.mock.calls[0].slice(1)).toEqual([START_MS / 1000, END_MS / 1000 + 5]);
  expect(result.trace.points.map(p => p.timestampMs)).toEqual([START_MS + 1000, END_MS + 4000]);
  expect(result.trace).toMatchObject({ partial: true, mileageMeters: null, durationSeconds: null });
});
test('two adjacent authorized ranges exclude their shared boundary bucket without inventing points', async () => {
  const boundary = START_MS + 5500;
  const first = fixture({ endTime: new Date(boundary).toISOString(), trajectoryEndTimeMs: boundary });
  const second = fixture({ startTime: new Date(boundary).toISOString() });
  const samples = [rawPoint(START_MS + 4000), rawPoint(START_MS + 5000), rawPoint(START_MS + 6000)];
  first.client.searchTrace.mockResolvedValue({ points: samples }); second.client.searchTrace.mockResolvedValue({ points: samples });
  expect((await first.handler(request)).trace.points.map(p => p.timestampMs)).toEqual([START_MS + 4000]);
  expect((await second.handler(request)).trace.points.map(p => p.timestampMs)).toEqual([START_MS + 6000]);
});
test('extending Walk A metadata cannot expose later Walk B points from the shared entity', async () => {
  const at = time => Date.parse(`2026-10-06T${time}:00.000Z`);
  const a = testWalk({ _id: 'walk-A', walkId: 'walk-A', startTime: new Date(at('10:00')).toISOString(),
    endTime: new Date(at('10:30')).toISOString(), trajectoryEndTimeMs: at('11:30') });
  const b = testWalk({ _id: 'walk-B', walkId: 'walk-B', startTime: new Date(at('11:00')).toISOString(),
    endTime: new Date(at('11:20')).toISOString(), trajectoryEndTimeMs: at('11:20') });
  const client = { ensureEntity: jest.fn(), searchTrace: jest.fn().mockResolvedValue({
    points: ['10:05', '10:20', '11:05', '11:15'].map(time => rawPoint(at(time))), mileageMeters: 1000, durationSeconds: 3000 }) };
  const handler = createTrackHandler({ config: { entitySecret: 'synthetic-secret' }, client,
    historyLimiter: { reserve: jest.fn().mockResolvedValue() },
    getOpenId: () => 'openid-one', getNowMs: () => at('12:00'),
    walkStore: { getWalk: async id => ({ 'walk-A': a, 'walk-B': b })[id] } });
  const result = await handler({ action: 'searchWalkTrace', walkId: 'walk-A' });
  expect(result.success).toBe(true);
  expect(client.searchTrace.mock.calls[0].slice(1)).toEqual([at('10:00') / 1000, at('10:30') / 1000]);
  expect(result.trace.points.map(point => point.timestampMs)).toEqual([at('10:05'), at('10:20')]);
  expect(result.trace).toMatchObject({ partial: true, mileageMeters: null, durationSeconds: null });
  const next = await handler({ action: 'searchWalkTrace', walkId: 'walk-B' });
  expect(next.trace.points.map(point => point.timestampMs)).toEqual([at('11:05'), at('11:15')]);
  expect(client.searchTrace.mock.calls[1][0]).toBe(client.searchTrace.mock.calls[0][0]);
});
test.each([0, 5000])('formal-interval summaries remain scoped to the query; cleanup extension=%i', async extension => {
  const f = fixture({ trajectoryEndTimeMs: END_MS + extension });
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint()], mileageMeters: 10, durationSeconds: 2 });
  const result = await f.handler(request);
  expect(result.trace).toMatchObject({ available: true, partial: extension > 0, mileageMeters: 10, durationSeconds: 2 });
  expect(f.client.searchTrace.mock.calls[0].slice(1)).toEqual([START_MS / 1000, END_MS / 1000]);
});
test('samples in the exact completion second and later are excluded', async () => {
  const f = fixture();
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(END_MS - 1000), rawPoint(END_MS), rawPoint(END_MS + 1000)] });
  const result = await f.handler(request);
  expect(result.trace.points.map(point => point.timestampMs)).toEqual([END_MS - 1000]);
  expect(result.trace.partial).toBe(true);
});
test.each([[250, 750], [0, 999]])('same-second walk [%i, %i] returns empty without expanding a provider query', async (start, end) => {
  const f = fixture({ startTime: new Date(START_MS + start).toISOString(),
    endTime: new Date(START_MS + end).toISOString(), trajectoryEndTimeMs: START_MS + end });
  expect(await f.handler(request)).toEqual({ success: true, trace: { points: [], mileageMeters: null,
    durationSeconds: null, available: false, retryable: true, partial: true } });
  noProvider(f);
});
test('sorts out-of-order provider points, deduplicates repeated samples and projects optional metadata', async () => {
  const f = fixture();
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(START_MS + 2000), rawPoint(), rawPoint(),
    rawPoint(START_MS + 3000, { accuracy: '8', speed: '1.1', direction: 90, altitude: -1, type: 0, providerSecret: 'private' })] });
  const result = await f.handler(request);
  expect(result.trace.points.map(p => p.timestampMs)).toEqual([START_MS + 1000, START_MS + 2000, START_MS + 3000]);
  expect(result.trace.points[2]).toMatchObject({ accuracy: 8, speed: 1.1, altitude: -1 });
  expect(result.trace.partial).toBe(true); expect(JSON.stringify(result)).not.toContain('private');
  expect(() => validateTraceResponse(result)).not.toThrow();
});
test.each([null, {}, { lat: null }, { lat: '' }, { lat: true }, { lat: 91 }, { lng: -181 }, { loctime: 0 },
  { loctime: 1.1 }, { loctime: Number.MAX_SAFE_INTEGER }, { speed: -1 }, { accuracy: '' }, { direction: 361 }, { type: -1 }])('all invalid samples fail rather than become empty/retryable: %j', change => {
  const f = fixture(); f.client.searchTrace.mockResolvedValue({ points: [change === null ? null : { ...rawPoint(), ...change }] });
  // An empty override leaves the valid synthetic sample; test a structurally empty point instead.
  if (change && !Object.keys(change).length) f.client.searchTrace.mockResolvedValue({ points: [{}] });
  return expect(f.handler(request)).resolves.toMatchObject({ success: false, error: { code: 'TRACK_INVALID_RESPONSE' } });
});
test('empty success remains retryable, while all outside-range points are explicitly partial', async () => {
  const f = fixture(); expect((await f.handler(request)).trace).toMatchObject({ available: false, retryable: true, partial: false });
  f.client.searchTrace.mockResolvedValue({ points: [rawPoint(START_MS - 1000)] });
  expect((await f.handler(request)).trace).toEqual({ points: [], available: false, retryable: true, partial: true, mileageMeters: null, durationSeconds: null });
});
test.each([null, {}, { points: {} }, { points: [], mileageMeters: -1 }, { points: [], durationSeconds: NaN }])('invalid normalized provider structure fails: %j', result => {
  const f = fixture(); f.client.searchTrace.mockResolvedValue(result);
  return expect(f.handler(request)).resolves.toMatchObject({ success: false, error: { code: 'TRACK_INVALID_RESPONSE' } });
});
test('point size limit is checked independently of provider client', async () => {
  const f = fixture(); f.client.searchTrace.mockResolvedValue({ points: Array(MAX_TRACE_POINTS + 1).fill(rawPoint()) });
  expect((await f.handler(request)).error.code).toBe('TRACK_SEARCH_TOO_LARGE');
});
test.each(['TRACK_PROVIDER_UNAVAILABLE', 'TRACK_SEARCH_FAILED', 'TRACK_SEARCH_PAGINATION_FAILED', 'TRACK_SEARCH_TOO_LARGE', 'unknown secret'])('provider failure %s exposes no raw data', async code => {
  const f = fixture(); f.client.searchTrace.mockRejectedValue(Object.assign(new Error('credentials and GPS'), { code, requestId: 'private', response: { gps: [] } }));
  const result = await f.handler(request);
  expect(result.success).toBe(false); expect(result.error.code).toBe(code === 'unknown secret' ? 'TRACK_PROVIDER_FAILED' : code);
  expect(JSON.stringify([result, f.log.mock.calls])).not.toMatch(/credentials|GPS|private|unknown secret|synthetic-secret|openid-one/);
});
test('retired arbitrary-range action cannot bypass walk authorization, including with a walkId', async () => {
  const f = fixture();
  for (const extra of [{}, { walkId: 'walk-1' }]) {
    expect((await f.handler({ action: 'searchTrace', startTimeMs: START_MS, endTimeMs: END_MS, ...extra })).error.code).toBe('TRACK_WALK_REQUIRED');
  }
  noProvider(f); expect(f.walkStore.getWalk).not.toHaveBeenCalled();
});
