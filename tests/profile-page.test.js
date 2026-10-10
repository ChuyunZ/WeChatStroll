const { preferenceProfile, historyItem } = require('./helpers/profile-fixture');
let page, walks, profile, totals;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function historyResult(items, nextCursor = null, counts = { completedWalkCount: 1, endedEarlyWalkCount: 0 }) {
  return { result: { success: true, items, nextCursor, totals: counts } };
}
function respond({ name, data }) {
  if (name === 'preferenceProfileStore') {
    expect(data).toEqual({ action: 'refreshProfile' });
    return { result: { success: true, profile } };
  }
  expect(name).toBe('walkStore'); expect(data.action).toBe('listHistory');
  const offset = data.cursor ? walks.findIndex(w => w.walkId === data.cursor.walkId) + 1 : 0;
  const items = walks.slice(offset, offset + data.limit);
  const last = items[items.length - 1];
  const cursor = offset + data.limit < walks.length ? { version: 1, endTime: last.endTime, walkId: last.walkId } : null;
  return historyResult(items, cursor, data.cursor ? null : totals || {
    completedWalkCount: walks.filter(w => w.status === 'completed').length,
    endedEarlyWalkCount: walks.filter(w => w.status === 'ended_early').length
  });
}
const historyCalls = () => wx.cloud.callFunction.mock.calls.filter(([arg]) => arg.name === 'walkStore');
const profileCalls = () => wx.cloud.callFunction.mock.calls.filter(([arg]) => arg.name === 'preferenceProfileStore');
const enter = () => { page.onLoad(); return page.onShow(); };
beforeEach(() => {
  jest.resetModules(); walks = []; profile = null; totals = null;
  global.wx = { cloud: { callFunction: jest.fn(async args => respond(args)) }, setStorageSync: jest.fn(), setStorage: jest.fn() };
  global.Page = definition => {
    page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
      setData: jest.fn(function (change) { Object.assign(this.data, JSON.parse(JSON.stringify(change))); }) };
  };
  require('../miniprogram/pages/profile/profile');
});
afterEach(() => { delete global.wx; delete global.Page; });
test('new user has independent empty states, true zero counts and no fabricated history', async () => {
  await enter();
  expect(page.data).toMatchObject({ historyState: 'empty', profileState: 'empty', visibleHistory: [], insights: null,
    totals: { completedWalkCount: 0, endedEarlyWalkCount: 0 }, hasMore: false });
  expect(wx.setStorageSync).not.toHaveBeenCalled(); expect(wx.setStorage).not.toHaveBeenCalled();
});
test.each([1, 3, 7])('recent records for %i walks, expand/collapse without extra calls', async n => {
  walks = Array.from({ length: n }, (_, i) => historyItem(i)); await enter();
  expect(page.data.visibleHistory).toHaveLength(Math.min(3, n));
  expect(page.data.canExpand).toBe(n > 3);
  page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(n);
  page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(Math.min(3, n));
  expect(historyCalls()).toHaveLength(1); expect(profileCalls()).toHaveLength(1);
});
test('lifetime totals, status, rating and planned/actual duration come from the correct fields', async () => {
  walks = [historyItem(0), historyItem(1)]; profile = preferenceProfile(20);
  totals = { completedWalkCount: 62, endedEarlyWalkCount: 19 }; await enter();
  expect(page.data.totals).toEqual(totals);
  expect(page.data.insights.evidenceText).toBe('20 次有效散步 · 0 次评价');
  expect(page.data.visibleHistory[0]).toMatchObject({ statusText: '已完成', ratingText: '尚未评价', plannedText: '计划 45 分钟', actualText: '实际经过 30 分钟' });
  expect(page.data.visibleHistory[1]).toMatchObject({ statusText: '提前结束', ratingText: '评分 4 / 5' });
});
test('more than 20 records load in tens, retain totals, stop at final page and never refresh AI on pagination', async () => {
  walks = Array.from({ length: 27 }, (_, i) => historyItem(i)); await enter();
  const firstTotals = page.data.totals;
  await page.loadMore(); expect(historyCalls()).toHaveLength(1); // Collapsed.
  page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(10);
  await page.loadMore(); expect(page.data.visibleHistory).toHaveLength(20);
  await page.loadMore(); expect(page.data.visibleHistory).toHaveLength(27);
  expect(page.data.totals).toEqual(firstTotals); expect(page.data.hasMore).toBe(false);
  expect(new Set(page.data.visibleHistory.map(x => x.walkId)).size).toBe(27);
  await page.loadMore(); expect(historyCalls()).toHaveLength(3); expect(profileCalls()).toHaveLength(1);
  page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(3);
  page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(27);
  expect(historyCalls()[0][0].data).toEqual({ action: 'listHistory', limit: 10, cursor: null });
  expect(historyCalls().slice(1).every(([arg]) => arg.data.limit === 10 && arg.data.cursor)).toBe(true);
});
test('independent pending regions render and first-load double clicks cannot start duplicate requests', async () => {
  const history = deferred(), ai = deferred();
  wx.cloud.callFunction.mockImplementation(({ name }) => name === 'walkStore' ? history.promise : ai.promise);
  const pending = enter();
  expect(page.data.historyState).toBe('loading'); expect(page.data.profileState).toBe('loading'); expect(page.data.totals).toBeNull();
  page.onShow(); page.retryHistory(); page.retryProfile(); page.loadHistory(); page.loadProfile();
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2);
  history.resolve(historyResult([historyItem(0)]));
  await new Promise(setImmediate);
  expect(page.data.historyState).toBe('ready'); expect(page.data.profileState).toBe('loading');
  ai.resolve({ result: { success: true, profile: preferenceProfile() } }); await pending;
  expect(page.data.profileState).toBe('ready');
});
test.each(['walkStore', 'preferenceProfileStore'])('failure and retry are isolated: %s', async failedName => {
  walks = [historyItem(0)]; profile = preferenceProfile();
  wx.cloud.callFunction.mockImplementation(async args => {
    if (args.name === failedName) throw new Error('private provider failure');
    return respond(args);
  });
  await enter();
  expect(page.data.historyState).toBe(failedName === 'walkStore' ? 'error' : 'ready');
  expect(page.data.profileState).toBe(failedName === 'walkStore' ? 'ready' : 'error');
  expect(JSON.stringify(page.data)).not.toContain('private');
  wx.cloud.callFunction.mockImplementation(async args => respond(args));
  await (failedName === 'walkStore' ? page.retryHistory() : page.retryProfile());
  expect(page.data.historyState).toBe('ready'); expect(page.data.profileState).toBe('ready');
  expect(historyCalls()).toHaveLength(failedName === 'walkStore' ? 2 : 1);
  expect(profileCalls()).toHaveLength(failedName === 'walkStore' ? 1 : 2);
});
test('load-more double click is guarded and failure retries the same cursor with existing rows intact', async () => {
  walks = Array.from({ length: 14 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  const before = JSON.parse(JSON.stringify(page.data));
  const more = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => more.promise);
  const request = page.loadMore(); await page.loadMore();
  expect(historyCalls()).toHaveLength(2); expect(page.data.moreState).toBe('loading');
  more.reject(new Error('network')); await request;
  expect(page.data.moreState).toBe('error'); expect(page.data.hasMore).toBe(true);
  expect(page.data.visibleHistory).toEqual(before.visibleHistory); expect(page.data.totals).toEqual(before.totals);
  await page.loadMore();
  expect(historyCalls()[2][0].data.cursor).toEqual(historyCalls()[1][0].data.cursor);
  expect(page.data.visibleHistory).toHaveLength(14); expect(page.data.moreError).toBe('');
});
test('invalid cursor retains rows and offers a fresh first page without refreshing AI', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  wx.cloud.callFunction.mockResolvedValueOnce({ result: { success: false, error: { code: 'INVALID_HISTORY_CURSOR', message: 'private detail' } } });
  await page.loadMore();
  expect(page.data.moreState).toBe('invalid'); expect(page.data.moreError).toContain('发生了变化');
  expect(page.data.visibleHistory).toHaveLength(10); await page.loadMore(); expect(historyCalls()).toHaveLength(2);
  walks = [historyItem(99)];
  await page.reloadHistory();
  expect(historyCalls()[2][0].data.cursor).toBeNull(); expect(profileCalls()).toHaveLength(1);
  expect(page.data).toMatchObject({ expanded: false, moreState: 'idle', hasMore: false });
  expect(page.data.visibleHistory.map(w => w.walkId)).toEqual(['walk-099']);
});
test('returning from hide refreshes both regions exactly once and clears old pagination', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory(); await page.loadMore();
  page.onHide(); walks = [historyItem(99)]; profile = preferenceProfile(1);
  await page.onShow(); await page.onShow();
  expect(historyCalls()).toHaveLength(3); expect(profileCalls()).toHaveLength(2);
  expect(page.data.visibleHistory).toHaveLength(1); expect(page.data.expanded).toBe(false);
  expect(page.data.insights.evidenceText).toContain('1 次有效散步');
});
test.each([false, true])('old first-page and AI responses cannot overwrite a new generation (reject=%s)', async reject => {
  const oldHistory = deferred(), oldProfile = deferred();
  wx.cloud.callFunction.mockImplementationOnce(() => oldHistory.promise).mockImplementationOnce(() => oldProfile.promise);
  const old = enter(); page.onHide(); walks = [historyItem(99)]; profile = preferenceProfile(4); await page.onShow();
  const current = JSON.parse(JSON.stringify(page.data)); page.setData.mockClear();
  if (reject) { oldHistory.reject(new Error('old')); oldProfile.reject(new Error('old')); }
  else { oldHistory.resolve(historyResult([historyItem(0)])); oldProfile.resolve({ result: { success: true, profile: null } }); }
  await old;
  expect(page.data).toEqual(current); expect(page.setData).not.toHaveBeenCalled();
});
test.each(['onHide', 'onUnload'])('pending responses never update a page after %s', async lifecycle => {
  const h = deferred(), p = deferred();
  wx.cloud.callFunction.mockImplementationOnce(() => h.promise).mockImplementationOnce(() => p.promise);
  const pending = enter(); page[lifecycle](); page.setData.mockClear();
  h.resolve(historyResult([historyItem(0)])); p.resolve({ result: { success: true, profile: preferenceProfile() } }); await pending;
  expect(page.setData).not.toHaveBeenCalled();
  if (lifecycle === 'onUnload') { await page.onShow(); expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2); }
});
test('old load-more success cannot append into a fresh first-page generation', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  const more = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => more.promise);
  const pending = page.loadMore(); await page.loadHistory();
  const current = JSON.parse(JSON.stringify(page.data)); page.setData.mockClear();
  more.resolve(historyResult([historyItem(10), historyItem(11)], null, null)); await pending;
  expect(page.data).toEqual(current); expect(page.setData).not.toHaveBeenCalled();
});
test('old rejected pagination cannot reset loading flags of a newer request', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  const oldMore = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => oldMore.promise); const old = page.loadMore();
  page.onHide(); await page.onShow(); page.toggleHistory();
  const newMore = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => newMore.promise); const current = page.loadMore();
  oldMore.reject(new Error('late error')); await old;
  expect(page.data.moreState).toBe('loading'); expect(page._moreBusy).toBe(true);
  newMore.resolve(historyResult([historyItem(10), historyItem(11)], null, null)); await current;
  expect(page.data.visibleHistory).toHaveLength(12);
});
test('collapsing while pagination is in flight keeps only three visible when it resolves', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  const more = deferred(); wx.cloud.callFunction.mockImplementationOnce(() => more.promise); const pending = page.loadMore(); page.toggleHistory();
  more.resolve(historyResult([historyItem(10), historyItem(11)], null, null)); await pending;
  expect(page.data.visibleHistory).toHaveLength(3); page.toggleHistory(); expect(page.data.visibleHistory).toHaveLength(12);
});
test('malformed AI response is rejected by the real service without affecting history', async () => {
  walks = [historyItem(0)]; profile = { ...preferenceProfile(), ownerKey: 'secret' }; await enter();
  expect(page.data.profileState).toBe('error'); expect(page.data.insights).toBeNull(); expect(page.data.historyState).toBe('ready');
  expect(JSON.stringify(page.data)).not.toContain('secret');
});
test('malformed history/private fields are rejected by the real service without affecting AI', async () => {
  walks = [historyItem(0, { ownerKey: 'other-user', comment: 'private' })]; profile = preferenceProfile(); await enter();
  expect(page.data.historyState).toBe('error'); expect(page.data.visibleHistory).toEqual([]); expect(page.data.totals).toBeNull();
  expect(page.data.profileState).toBe('ready'); expect(JSON.stringify(page.data)).not.toMatch(/other-user|private/);
});
test('replayed pagination data is rejected without duplicate appends', async () => {
  walks = Array.from({ length: 12 }, (_, i) => historyItem(i)); await enter(); page.toggleHistory();
  wx.cloud.callFunction.mockResolvedValueOnce(historyResult([historyItem(0)], null, null));
  await page.loadMore(); expect(page.data.moreState).toBe('error'); expect(page.data.visibleHistory).toHaveLength(10);
  await page.loadMore(); expect(new Set(page.data.visibleHistory.map(w => w.walkId)).size).toBe(12);
});
