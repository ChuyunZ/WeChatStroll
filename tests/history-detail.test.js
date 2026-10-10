const fs = require('fs');
const { historyItem } = require('./helpers/profile-fixture');
const { POSITIVE_TAGS, NEGATIVE_TAGS } = require('../miniprogram/utils/feedback-validation');
let page, walk, feedback, trace;
const point = { latitude: 31, longitude: 121, timestampMs: Date.parse('2026-10-09T00:00:01.000Z') };
const resultTrace = (points = [point], partial = false) => ({ points, partial, available: !!points.length,
  retryable: !points.length, mileageMeters: null, durationSeconds: null });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function respond({ name, data }) {
  if (name === 'walkStore') { expect(data).toEqual({ action: 'getWalk', walkId: 'walk-000' }); return { result: { success: true, walk } }; }
  if (name === 'feedbackStore') { expect(data).toEqual({ action: 'getFeedback', walkId: 'walk-000' }); return { result: { success: true, feedback } }; }
  expect(name).toBe('trackProvider'); expect(data).toEqual({ action: 'searchWalkTrace', walkId: 'walk-000' });
  return { result: { success: true, trace } };
}
const calls = name => wx.cloud.callFunction.mock.calls.filter(([arg]) => arg.name === name);
const enter = () => { page.onLoad({ walkId: 'walk-000' }); return page.onShow(); };
beforeEach(() => {
  jest.resetModules();
  walk = { ...historyItem(0, { trajectoryEnabled: true }), schemaVersion: 1, completionStatus: 'completed', routeId: 'route-1',
    preferences: { durationMinutes: 45, routeType: 'loop', crowdPreference: 'low', environmentPreferences: [] } };
  delete walk.rating;
  feedback = { walkId: 'walk-000', routeId: 'route-1', schemaVersion: 1, createdAt: '2026-10-09T01:00:00.000Z',
    rating: 4, observedCrowdLevel: 'low', wouldRecommend: true, positiveTags: [], negativeTags: [], comment: null };
  trace = resultTrace();
  global.wx = { cloud: { callFunction: jest.fn(async args => respond(args)) }, setStorage: jest.fn(), setStorageSync: jest.fn(),
    getLocation: jest.fn(), startLocationUpdateBackground: jest.fn() };
  global.Page = definition => { page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData: jest.fn(function (values) { Object.assign(this.data, values); }) }; };
  require('../miniprogram/pages/history-detail/history-detail');
});
afterEach(() => { jest.useRealTimers(); delete global.wx; delete global.Page; });
test.each(['completed', 'ended_early'])('real service validates and displays %s without loading GPS', async status => {
  walk.status = walk.completionStatus = status;
  await enter();
  expect(page.data.walkState).toBe('ready'); expect(page.data.walk.elapsedText).toBe('30 分钟');
  expect(page.data.walk.plannedText).toBe('计划 45 分钟');
  expect(page.data.walk.statusText).toBe(status === 'completed' ? '已完成' : '提前结束');
  const date = new Date(walk.startTime);
  expect(page.data.walk.dateText).toContain(`${date.getHours()}`.padStart(2, '0') + ':00');
  expect(page.data.feedbackState).toBe('ready'); expect(calls('trackProvider')).toHaveLength(0);
  await page.onShow(); expect(calls('walkStore')).toHaveLength(1);
});
test.each([['loop', '环线散步'], ['out_and_back', '往返散步'], ['point_to_point', '单程散步']])('route type %s is translated', async (type, label) => {
  walk.routeType = walk.preferences.routeType = type; await enter(); expect(page.data.walk.routeText).toBe(label);
});
test('zero elapsed time is shown truthfully', async () => {
  walk.endTime = walk.startTime; walk.actualDurationSeconds = 0; walk.trajectoryEndTimeMs = Date.parse(walk.endTime);
  await enter(); expect(page.data.walk.elapsedText).toBe('0 秒');
});
test.each([{}, { schemaVersion: 2 }, { requestedDurationMinutes: null }, { routeType: 'unknown' }, { walkId: 'foreign' }, { actualDurationSeconds: -1 }])('malformed Walk fails safely: %j', changes => {
  walk = Object.keys(changes).length ? { ...walk, ...changes } : {};
  return enter().then(() => { expect(page.data.walkState).toBe('error'); expect(page.data.walk).toBeNull(); expect(page.data.feedbackState).toBe('ready'); });
});
test.each([undefined, '', '../walk', 'w&owner=x'])('invalid route identity %j makes no requests', async walkId => {
  page.onLoad({ walkId }); await page.onShow(); await page.loadTrace();
  expect(page.data.walkState).toBe('unavailable'); expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});
test('missing/foreign Walk is unavailable and cannot load GPS', async () => {
  wx.cloud.callFunction.mockImplementation(async args => args.name === 'walkStore'
    ? { result: { success: false, error: { code: 'WALK_NOT_FOUND', message: 'private' } } } : respond(args));
  await enter(); await page.loadTrace(); expect(page.data.walkState).toBe('unavailable'); expect(calls('trackProvider')).toHaveLength(0);
  expect(JSON.stringify(page.data)).not.toContain('private');
});
test.each(['walkStore', 'feedbackStore'])('failure and retry of %s are independent', async failed => {
  wx.cloud.callFunction.mockImplementation(async args => { if (args.name === failed) throw new Error('secret'); return respond(args); });
  await enter();
  expect(page.data.walkState).toBe(failed === 'walkStore' ? 'error' : 'ready');
  expect(page.data.feedbackState).toBe(failed === 'feedbackStore' ? 'error' : 'ready');
  wx.cloud.callFunction.mockImplementation(async args => respond(args));
  await (failed === 'walkStore' ? page.retryWalk() : page.retryFeedback());
  expect(page.data.walkState).toBe('ready'); expect(page.data.feedbackState).toBe('ready'); expect(calls('trackProvider')).toHaveLength(0);
});
test.each([1, 2, 3, 4, 5])('feedback rating %i is read-only', async rating => {
  feedback.rating = rating; await enter(); expect(page.data.feedback.ratingText).toBe(`${rating} / 5`);
  expect(page.submitFeedback).toBeUndefined();
});
test.each([['low', '人少'], ['medium', '适中'], ['high', '人多']])('crowd %s translates', async (level, text) => {
  feedback.observedCrowdLevel = level; await enter(); expect(page.data.feedback.crowdText).toBe(text);
});
test.each([true, false])('recommend=%s and optional fields', async recommend => {
  feedback.wouldRecommend = recommend; feedback.positiveTags = POSITIVE_TAGS; feedback.negativeTags = NEGATIVE_TAGS; feedback.comment = ' 真正的体验\n第二行 ';
  await enter(); expect(page.data.feedback.recommendText).toBe(recommend ? '会' : '不会');
  expect(page.data.feedback.positiveTags.map(tag => tag.text)).toEqual(['风景不错', '很安静', '路线舒服', '时长刚好']);
  expect(page.data.feedback.negativeTags.map(tag => tag.text)).toEqual(['太拥挤', '太安静', '距离太长', '距离太短', '时间太长', '时间太短', '不太好走', '途经地点没意思']);
  expect(page.data.feedback.comment).toBe('真正的体验\n第二行');
});
test('absent comment and empty tags are not invented; null feedback is empty', async () => {
  delete feedback.comment; await enter(); expect(page.data.feedback).toMatchObject({ comment: null, positiveTags: [], negativeTags: [] });
  feedback = null; await page.loadFeedback(); expect(page.data.feedbackState).toBe('empty'); expect(page.data.feedback).toBeNull();
});
test('GPS consent false never queries even when directly invoked', async () => {
  walk.trajectoryEnabled = false; await enter(); await page.loadTrace();
  expect(page.data.gpsState).toBe('disabled'); expect(calls('trackProvider')).toHaveLength(0);
});
test('explicit GPS query, double tap guard, singleton map and no persistence or location', async () => {
  await enter(); const pending = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => pending.promise);
  const query = page.loadTrace(); await page.loadTrace(); expect(calls('trackProvider')).toHaveLength(1);
  pending.resolve({ result: { success: true, trace } }); await query;
  expect(page.data.gpsState).toBe('ready'); expect(page.data.map.markers).toHaveLength(1); expect(page.data.map.polyline).toEqual([]);
  for (const name of ['setStorage', 'setStorageSync', 'getLocation', 'startLocationUpdateBackground']) expect(wx[name]).not.toHaveBeenCalled();
});
test('GPS error is safe and isolated; manual retry succeeds', async () => {
  await enter(); const basic = page.data.walk, review = page.data.feedback;
  wx.cloud.callFunction.mockRejectedValueOnce(new Error('provider secret')); await page.loadTrace();
  expect(page.data.gpsState).toBe('error'); expect(page.data.walk).toBe(basic); expect(page.data.feedback).toBe(review);
  await page.loadTrace(); expect(page.data.gpsState).toBe('ready'); expect(JSON.stringify(page.data)).not.toContain('secret');
});
test.each([0, 1, 3])('partial trace with %i points stays neutral and empty retry is bounded', async count => {
  jest.useFakeTimers(); await enter();
  trace = resultTrace(Array.from({ length: count }, (_, i) => ({ ...point, latitude: 31 + i * .00001, timestampMs: point.timestampMs + i * 15000 })), true);
  const query = page.loadTrace(); await jest.advanceTimersByTimeAsync(1500); await query;
  expect(page.data.tracePartial).toBe(true); expect(page.data.gpsState).toBe(count ? 'ready' : 'empty');
  expect(calls('trackProvider')).toHaveLength(count ? 1 : 3);
  if (!count) { trace = resultTrace(); await page.loadTrace(); expect(page.data.gpsState).toBe('ready'); }
});
test.each(['onHide', 'onUnload'])('late trace after %s never updates or retains GPS', async lifecycle => {
  await enter(); const pending = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => pending.promise);
  const query = page.loadTrace(); page[lifecycle](); page.setData.mockClear();
  pending.resolve({ result: { success: true, trace } }); await query;
  expect(page.setData).not.toHaveBeenCalled(); expect(page.data.map).toBeNull();
  await page.onShow(); expect(calls('trackProvider')).toHaveLength(1);
});
test('old walk/feedback responses cannot overwrite a resumed generation', async () => {
  const a = deferred(), b = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  const old = enter(); page.onHide(); await page.onShow(); const current = { ...page.data }; page.setData.mockClear();
  a.resolve({ result: { success: true, walk } }); b.reject(new Error('late')); await old;
  expect(page.data).toEqual(current); expect(page.setData).not.toHaveBeenCalled();
});
test('unload releases a displayed map and notifies opener', async () => {
  await enter(); await page.loadTrace(); const emit = jest.fn(); page.getOpenerEventChannel = () => ({ emit });
  page.onUnload(); expect(page.data.map).toBeNull(); expect(emit).toHaveBeenCalledWith('historyDetailClosed');
});
test('native bindings expose only read-only fields and explicit trace loading', () => {
  const wxml = fs.readFileSync('miniprogram/pages/history-detail/history-detail.wxml', 'utf8');
  expect(wxml).toContain('查看实际轨迹'); expect(wxml).toContain('show-location="{{false}}"');
  expect(wxml).toContain('部分采样可能未展示'); expect(wxml).not.toMatch(/GPS 记录丢失|完整轨迹|textarea|submitFeedback|planned.*polyline/);
  expect(JSON.parse(fs.readFileSync('miniprogram/app.json')).pages).toContain('pages/history-detail/history-detail');
});
test('feedback may stay pending while Walk and an explicitly requested map settle', async () => {
  const pending = deferred(); wx.cloud.callFunction.mockImplementation(args => args.name === 'feedbackStore' ? pending.promise : Promise.resolve(respond(args)));
  const entering = enter(); await new Promise(setImmediate);
  expect(page.data.walkState).toBe('ready'); expect(page.data.feedbackState).toBe('loading'); expect(calls('trackProvider')).toHaveLength(0);
  await page.loadTrace(); expect(page.data.gpsState).toBe('ready');
  pending.reject(new Error('offline')); await entering;
  expect(page.data.feedbackState).toBe('error'); expect(page.data.gpsState).toBe('ready');
});
test.each([null, { ...resultTrace(), partial: 'true' }, resultTrace([{ ...point, longitude: 999 }])])('malformed GPS %j fails without corrupting other areas', async value => {
  await enter(); trace = value; await page.loadTrace();
  expect(page.data.gpsState).toBe('error'); expect(page.data.map).toBeNull();
  expect(page.data.walkState).toBe('ready'); expect(page.data.feedbackState).toBe('ready'); expect(calls('trackProvider')).toHaveLength(1);
});
test('an older GPS query cannot overwrite a newer result after hide/show', async () => {
  await enter(); const pending = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => pending.promise);
  const old = page.loadTrace(); page.onHide(); await page.onShow(); expect(page.data.gpsState).toBe('idle');
  await page.loadTrace(); const current = page.data.map; page.setData.mockClear();
  pending.resolve({ result: { success: true, trace: resultTrace([{ ...point, latitude: 32 }], true) } }); await old;
  expect(page.data.map).toBe(current); expect(page.data.tracePartial).toBe(false); expect(page.setData).not.toHaveBeenCalled();
});
test('changed identity invalidates outstanding detail results', async () => {
  const pending = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => pending.promise);
  const old = enter(); page.onHide(); page.onLoad({ walkId: 'different-walk' }); page._active = true; page.setData.mockClear();
  pending.resolve({ result: { success: true, walk } }); await old;
  expect(page.setData).not.toHaveBeenCalled();
});
test('unload discards pending metadata and supports opening without an EventChannel', async () => {
  const a = deferred(), b = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  const old = enter(); page.getOpenerEventChannel = () => ({}); page.onUnload(); page.setData.mockClear();
  a.resolve({ result: { success: true, walk } }); b.resolve({ result: { success: true, feedback } }); await old;
  expect(page.setData).not.toHaveBeenCalled(); expect(page.data.walk).toBeNull(); expect(page.data.feedback).toBeNull();
});
test('late cleanup and recorded partial are independent explanations', async () => {
  walk.trajectoryEndTimeMs += 3314; walk.trajectoryPartial = false; await enter();
  expect(page.data.walk).toMatchObject({ lateCleanup: true, recordedPartial: false });
  expect(calls('trackProvider')).toHaveLength(0);
});
