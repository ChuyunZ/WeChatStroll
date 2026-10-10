const fs = require('fs');
const { searchWalkTrace } = require('../miniprogram/services/history-trace');
const { MAX_TRACE_POINTS } = require('../miniprogram/utils/history-trace-schema');
const point = { latitude: 31, longitude: 121, timestampMs: 1760000000000 };
const full = () => ({ points: [{ ...point }], mileageMeters: 10, durationSeconds: 2, available: true, retryable: false, partial: false });
const empty = () => ({ points: [], mileageMeters: null, durationSeconds: null, available: false, retryable: true, partial: false });
function respond(trace) { return { result: { success: true, trace } }; }
beforeEach(() => {
  jest.useFakeTimers();
  global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue(respond(full())) },
    setStorage: jest.fn(), setStorageSync: jest.fn(), getLocation: jest.fn(), startLocationUpdateBackground: jest.fn() };
});
afterEach(() => { jest.useRealTimers(); delete global.wx; });
test('client and cloud validators are identical', () => {
  expect(fs.readFileSync('cloudfunctions/trackProvider/trace-schema.js', 'utf8')).toBe(fs.readFileSync('miniprogram/utils/history-trace-schema.js', 'utf8'));
});
test('local retryEmpty=false sends exactly one empty query with unchanged authorization fields', async () => {
  wx.cloud.callFunction.mockResolvedValue(respond(empty()));
  expect(await searchWalkTrace({ walkId: 'w' }, { retryEmpty: false })).toEqual(empty());
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  expect(wx.cloud.callFunction.mock.calls[0][0].data).toEqual({ action: 'searchWalkTrace', walkId: 'w' });
});
test.each(['TRACK_SEARCH_RATE_LIMITED', 'TRACK_RATE_LIMIT_STORE_FAILED'])('quota error %s is preserved and never auto-retried', async code => {
  wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: { code, message: 'private database' } } });
  await expect(searchWalkTrace({ walkId: 'w' }, { retryEmpty: true })).rejects.toMatchObject({ code });
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test('sends only action and walkId and returns a detached normalized trajectory', async () => {
  const trace = full(); wx.cloud.callFunction.mockResolvedValue(respond(trace));
  const result = await searchWalkTrace({ walkId: 'walk-1' });
  expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'trackProvider', data: { action: 'searchWalkTrace', walkId: 'walk-1' } });
  expect(result).toEqual(trace); result.points[0].latitude = 1; expect(trace.points[0].latitude).toBe(31);
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  expect(wx.setStorage).not.toHaveBeenCalled(); expect(wx.setStorageSync).not.toHaveBeenCalled();
  expect(wx.getLocation).not.toHaveBeenCalled(); expect(wx.startLocationUpdateBackground).not.toHaveBeenCalled();
});
test('accepts the actual authorized handler response after filtering, including null aggregates', async () => {
  const { createTrackHandler } = require('../cloudfunctions/trackProvider/handler');
  const { testWalk, START_MS, END_MS } = require('../cloudfunctions/trackProvider/test-walk');
  const handler = createTrackHandler({ config: { entitySecret: 'synthetic-secret' },
    historyLimiter: { reserve: jest.fn().mockResolvedValue() },
    getOpenId: () => 'openid-one', getNowMs: () => END_MS + 1000,
    walkStore: { getWalk: async () => testWalk() },
    client: { ensureEntity: jest.fn(), searchTrace: jest.fn().mockResolvedValue({
      points: [{ lat: 31, lng: 121, loctime: START_MS / 1000 - 1 },
        { lat: 31, lng: 121, loctime: START_MS / 1000 + 1, accuracy: '8' }],
      mileageMeters: 100, durationSeconds: 30 }) } });
  wx.cloud.callFunction.mockImplementation(async ({ data }) => ({ result: await handler(data) }));
  expect(await searchWalkTrace({ walkId: 'walk-1' })).toEqual({
    points: [{ latitude: 31, longitude: 121, timestampMs: START_MS + 1000, accuracy: 8 }],
    mileageMeters: null, durationSeconds: null, available: true, retryable: false, partial: true
  });
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
  expect(wx.setStorageSync).not.toHaveBeenCalled();
});
test.each([undefined, null, {}, [], { walkId: '' }, { walkId: '../walk' }, { walkId: 5 }, { walkId: 'x'.repeat(201) },
  { walkId: 'walk-1', startTimeMs: 100 }, { walkId: 'walk-1', ownerKey: 'owner' }, { walkId: 'walk-1', trajectoryPartial: true }])('invalid request %j fails locally', async input => {
  await expect(searchWalkTrace(input)).rejects.toMatchObject({ code: 'INVALID_WALK_TRACE_REQUEST' }); expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});
test.each([
  { latitude: null }, { latitude: '31' }, { longitude: 181 }, { latitude: -91 }, { timestampMs: 0 },
  { timestampMs: 1760000000001 }, { timestampMs: Number.MAX_SAFE_INTEGER + 1 }, { accuracy: -1 },
  { speed: NaN }, { direction: 361 }, { altitude: Infinity }, { type: -1 }, { provider: {} }, { ownerKey: 'private' }
])('malformed point %j is rejected without retry', async change => {
  wx.cloud.callFunction.mockResolvedValue(respond({ ...full(), points: [{ ...point, ...change }] }));
  await expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code: 'TRACK_INVALID_RESPONSE' });
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test.each([null, {}, { ...full(), raw: {} }, { ...full(), points: null }, { ...full(), points: [null] },
  { ...full(), mileageMeters: -1 }, { ...full(), durationSeconds: '2' }, { ...full(), partial: undefined },
  { ...full(), available: false }, { ...full(), retryable: true }, { ...empty(), retryable: false },
  { ...full(), points: [point, point] }, { ...full(), points: [{ ...point, timestampMs: point.timestampMs + 1000 }, point] }
])('malformed trace %j fails rather than returning partial data', async trace => {
  wx.cloud.callFunction.mockResolvedValue(respond(trace));
  await expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code: 'TRACK_INVALID_RESPONSE' }); expect(jest.getTimerCount()).toBe(0);
});
test('unknown envelope fields, point limits and invalid success flags fail', async () => {
  for (const result of [{ success: true, trace: full(), ownerKey: 'secret' },
    { success: false, trace: full() }, { success: true, trace: { ...full(), points: Array(1) } },
    { success: true, trace: { ...full(), points: Array(MAX_TRACE_POINTS + 1).fill(point) } }]) {
    wx.cloud.callFunction.mockResolvedValue({ result }); await expect(searchWalkTrace({ walkId: 'w' })).rejects.toThrow();
  }
});
test.each(['WALK_NOT_FOUND', 'TRACK_NOT_ENABLED', 'INVALID_WALK_TRACE_METADATA', 'TRACK_PROVIDER_UNAVAILABLE', 'TRACK_SEARCH_FAILED', 'TRACK_WALK_READ_FAILED'])('preserves public error %s but not upstream details and never retries', async code => {
  wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: { code, message: 'private payload' } } });
  await expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code });
  try { await searchWalkTrace({ walkId: 'w' }); } catch (error) { expect(error.message).not.toContain('private'); expect(error.originalError).toBeUndefined(); }
  expect(jest.getTimerCount()).toBe(0);
});
test('transport and unknown error payloads are sanitized', async () => {
  wx.cloud.callFunction.mockRejectedValue(new Error('GPS or credentials'));
  await expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code: 'TRACK_SEARCH_FAILED', message: 'Unable to query walking trajectory.' });
  wx.cloud.callFunction.mockResolvedValue({ result: { success: false, error: { code: 'private', message: 'secret' } } });
  await expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code: 'TRACK_PROVIDER_FAILED' });
});
test.each([1, 2, 3])('empty retry sequence, success on attempt %i', async successAt => {
  let calls = 0; wx.cloud.callFunction.mockImplementation(async () => respond(++calls >= successAt ? full() : empty()));
  const result = searchWalkTrace({ walkId: 'w' }); await jest.advanceTimersByTimeAsync(0);
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(499); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(Math.min(2, successAt));
  await jest.advanceTimersByTimeAsync(999); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(Math.min(2, successAt));
  await jest.advanceTimersByTimeAsync(1); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(successAt);
  expect(await result).toEqual(full()); expect(jest.getTimerCount()).toBe(0);
});
test('retry exhaustion returns empty/retryable, including partial boundary-only results', async () => {
  const trace = { ...empty(), partial: true }; wx.cloud.callFunction.mockResolvedValue(respond(trace));
  const result = searchWalkTrace({ walkId: 'w' }); await jest.advanceTimersByTimeAsync(1500);
  expect(await result).toEqual(trace); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(3); expect(jest.getTimerCount()).toBe(0);
});
test('failure during an empty-result retry stops the budget immediately', async () => {
  wx.cloud.callFunction.mockResolvedValueOnce(respond(empty())).mockRejectedValueOnce(new Error('network'));
  const result = expect(searchWalkTrace({ walkId: 'w' })).rejects.toMatchObject({ code: 'TRACK_SEARCH_FAILED' });
  await jest.advanceTimersByTimeAsync(1500); await result;
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2); expect(jest.getTimerCount()).toBe(0);
});
