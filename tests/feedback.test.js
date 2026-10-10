const pending = { walkId: 'walk-1', routeId: 'route-1', route: { routeId: 'route-1', durationMinutes: 99, polyline: [1] }, startTime: '2026-10-07T01:00:00Z', endTime: '2026-10-07T01:12:00Z', actualDurationSeconds: 720, completionStatus: 'completed' };
let page, records, storage, sessions;
const event = (value, group) => ({ currentTarget: { dataset: { value, group } } });
beforeEach(() => {
  jest.resetModules(); storage = { pendingWalkResult: { ...pending } };
  records = { getFeedback: jest.fn().mockResolvedValue(null), submitFeedback: jest.fn().mockResolvedValue({ created: true, feedback: { walkId: 'walk-1' } }) };
  jest.doMock('../miniprogram/services/feedback-records', () => records);
  global.wx = { getStorageSync: key => storage[key], removeStorageSync: jest.fn(key => { delete storage[key]; }), showModal: jest.fn(), reLaunch: jest.fn() };
  global.Page = definition => { page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(change) { Object.assign(this.data, change); } }; };
  require('../miniprogram/pages/feedback/feedback');
  sessions = require('../miniprogram/services/active-walk-session');
});
afterEach(() => { delete global.wx; delete global.Page; jest.dontMock('../miniprogram/services/feedback-records'); });
const load = () => page.onLoad({ walkId: 'walk-1' });
function fill() { page.selectRating(event(4)); page.selectCrowd(event('high')); page.selectRecommend(event('no')); page.onComment({ detail: { value: 'my comment' } }); }
test.each(['completed', 'ended_early'])('summarizes %s using actual duration and retains pending on open', async status => {
  storage.pendingWalkResult.completionStatus = status;
  await load();
  expect(page.data.summary).toBe(`${status === 'completed' ? '已完成散步' : '提前结束'} · 12 分钟`);
  expect(storage.pendingWalkResult).toBeTruthy();
  expect(page.data.state).toBe('form');
});
test('required fields, yes/no, tags and comment length', async () => {
  await load(); await page.submitFeedback(); expect(records.submitFeedback).not.toHaveBeenCalled();
  fill(); expect(page.data.canSubmit).toBe(true); expect(page.data.wouldRecommend).toBe(false);
  page.selectRecommend(event('yes')); expect(page.data.wouldRecommend).toBe(true);
  for (const [group, value] of [['positive','quiet'], ['negative','too_crowded']]) {
    page.toggleTag(event(value, group)); expect(page.data[`${group}Tags`]).toEqual([value]);
    page.toggleTag(event(value, group)); expect(page.data[`${group}Tags`]).toEqual([]);
  }
  page.onComment({ detail: { value: 'a'.repeat(501) } }); expect(page.data.comment).toHaveLength(500);
  page.onComment({ detail: { value: '' } }); await page.submitFeedback();
  expect(records.submitFeedback.mock.calls[0][0].comment).toBeNull();
});
test('submission is guarded until resolution; success clears only after confirmation', async () => {
  await load(); fill(); let resolve;
  records.submitFeedback.mockImplementation(() => new Promise(done => { resolve = done; }));
  const first = page.submitFeedback(); await page.submitFeedback(); page.skipFeedback();
  page.selectRating(event(1));
  expect(records.submitFeedback).toHaveBeenCalledTimes(1); expect(wx.showModal).not.toHaveBeenCalled();
  expect(page.data.rating).toBe(4); expect(page.data.submitting).toBe(true); expect(storage.pendingWalkResult).toBeTruthy();
  resolve({ created: true }); await first;
  expect(page.data.state).toBe('success'); expect(storage.pendingWalkResult).toBeUndefined();
});
test('failure retains input and pending; retry succeeds', async () => {
  await load(); fill(); records.submitFeedback.mockRejectedValueOnce(new Error('offline'));
  await page.submitFeedback();
  expect(page.data).toMatchObject({ state: 'form', rating: 4, observedCrowdLevel: 'high', wouldRecommend: false, comment: 'my comment', submitting: false });
  expect(page.data.error).toContain('重试'); expect(storage.pendingWalkResult).toBeTruthy();
  await page.submitFeedback(); expect(page.data.state).toBe('success'); expect(storage.pendingWalkResult).toBeUndefined();
});
test.each([true, false])('existing feedback recovery with pending=%s', async hasPending => {
  if (!hasPending) delete storage.pendingWalkResult;
  records.getFeedback.mockResolvedValue({ walkId: 'walk-1' }); await load();
  expect(page.data.state).toBe('success'); expect(storage.pendingWalkResult).toBeUndefined();
  expect(records.submitFeedback).not.toHaveBeenCalled();
});
test('old flow never clears newer pending even if it changes while saving', async () => {
  await load(); fill(); storage.pendingWalkResult = { ...pending, walkId: 'newer' };
  await page.submitFeedback(); expect(storage.pendingWalkResult.walkId).toBe('newer');
  expect(sessions.clearPendingWalkResult()).toBe(false);
  expect(sessions.clearPendingWalkResult('walk-1')).toBe(false);
  expect(sessions.clearPendingWalkResult('newer')).toBe(true);
});
test.each([false, true])('skip confirm=%s never writes feedback', async confirm => {
  await load(); fill(); page.skipFeedback();
  const modal = wx.showModal.mock.calls[0][0];
  expect(modal.content).toContain('未保存的散步日志');
  await page.submitFeedback(); expect(records.submitFeedback).not.toHaveBeenCalled();
  modal.success({ confirm }); modal.complete();
  expect(records.submitFeedback).not.toHaveBeenCalled();
  if (confirm) { expect(storage.pendingWalkResult).toBeUndefined(); expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/home/home' }); }
  else { expect(storage.pendingWalkResult).toBeTruthy(); expect(page.data.comment).toBe('my comment'); expect(page.data.state).toBe('form'); }
});
test('no pending and no feedback is safe', async () => {
  delete storage.pendingWalkResult; await load(); await page.submitFeedback();
  expect(page.data.state).toBe('empty'); expect(records.submitFeedback).not.toHaveBeenCalled();
  page.returnHome(); expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/home/home' });
});
test.each([undefined, '../bad', 'different'])('malformed/mismatched identity %j cannot submit or clear pending', async walkId => {
  await page.onLoad({ walkId }); await page.submitFeedback(); page.skipFeedback();
  expect(page.data.state).toBe('empty'); expect(records.getFeedback).not.toHaveBeenCalled();
  expect(records.submitFeedback).not.toHaveBeenCalled(); expect(storage.pendingWalkResult).toBeTruthy();
});
test('lookup failure allows retry without consuming pending', async () => {
  records.getFeedback.mockRejectedValueOnce(new Error('offline')); await load();
  expect(page.data.state).toBe('error'); expect(storage.pendingWalkResult).toBeTruthy();
  await page.loadFeedback(); expect(page.data.state).toBe('form');
});
test('lookup failure with matching pending can be explicitly skipped', async () => {
  records.getFeedback.mockRejectedValueOnce(new Error('offline')); await load();
  expect(page.data).toMatchObject({ state: 'error', canSkip: true });
  page.skipFeedback();
  const modal = wx.showModal.mock.calls[0][0];
  modal.success({ confirm: true }); modal.complete();
  expect(records.submitFeedback).not.toHaveBeenCalled();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/home/home' });
});
test('lookup failure without pending does not offer skip', async () => {
  delete storage.pendingWalkResult;
  records.getFeedback.mockRejectedValueOnce(new Error('offline')); await load();
  expect(page.data).toMatchObject({ state: 'error', canSkip: false });
  page.skipFeedback();
  expect(wx.showModal).not.toHaveBeenCalled();
});
test('storage cleanup failure still displays confirmed cloud success', async () => {
  await load(); fill(); wx.removeStorageSync.mockImplementation(() => { throw new Error('storage'); });
  await page.submitFeedback(); expect(page.data.state).toBe('success'); expect(storage.pendingWalkResult).toBeTruthy();
});

test('leaving optional feedback without submitting discards only the matching pending handoff', async () => {
  await load(); fill();
  page.onUnload();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(records.submitFeedback).not.toHaveBeenCalled();
  expect(wx.reLaunch).not.toHaveBeenCalled();
});

test('app backgrounding does not implicitly skip feedback', async () => {
  await load();
  expect(page.onHide).toBeUndefined();
  expect(storage.pendingWalkResult).toBeTruthy();
  expect(records.submitFeedback).not.toHaveBeenCalled();
});

test('feedback unload cannot clear a different newer walk identity', async () => {
  await load();
  storage.pendingWalkResult = { ...pending, walkId: 'walk-later' };
  page.onUnload();
  expect(storage.pendingWalkResult.walkId).toBe('walk-later');
  expect(records.submitFeedback).not.toHaveBeenCalled();
});

test('leaving while submit is in flight retains retry handoff until outcome', async () => {
  await load(); fill();
  let resolve;
  records.submitFeedback.mockImplementation(() => new Promise(done => { resolve = done; }));
  const writing = page.submitFeedback();
  page.onUnload();
  expect(storage.pendingWalkResult).toBeTruthy();
  resolve({ created: true });
  await writing;
  expect(storage.pendingWalkResult).toBeUndefined();
});

test('late feedback lookup cannot show form after unload', async () => {
  let resolve;
  records.getFeedback.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const loading = load();
  page.onUnload();
  resolve(null);
  await loading;
  expect(page.data.state).toBe('loading');
  expect(storage.pendingWalkResult).toBeUndefined();
});

test('skipping without journal warns only about the evaluation', async () => {
  await load();
  page.skipFeedback();
  expect(wx.showModal.mock.calls[0][0].content).toBe('本次散步记录仍会保留，但这次评价不会保存。');
});
