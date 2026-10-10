const { createStore } = require('../cloudfunctions/walkStore/store');
const { createWalkHandler } = require('../cloudfunctions/walkStore/handler');
const { historyDb, walk, ownerKey } = require('./helpers/history-db');
const service = require('../miniprogram/services/walk-records');
let state;
beforeEach(() => {
  state = historyDb(Array.from({ length: 25 }, (_, i) => walk(i)), [
    { _id: 'walk-001', walkId: 'walk-001', ownerKey, rating: 4 }
  ]);
  const handle = createWalkHandler({ store: createStore(state.db), getOpenId: () => 'user' });
  global.wx = { cloud: { callFunction: jest.fn(async ({ data }) => ({ result: await handle(data) })) } };
});
afterEach(() => { delete global.wx; });
function response(page) { return { success: true, ...page }; }
function mockResult(result) { wx.cloud.callFunction.mockResolvedValue({ result }); }
test('deployable backend and client schema remain byte-identical', () => {
  const fs = require('fs');
  expect(fs.readFileSync('cloudfunctions/walkStore/history-schema.js', 'utf8'))
    .toBe(fs.readFileSync('miniprogram/utils/history-schema.js', 'utf8'));
});
test('client validates real backend pages and sends only allowlisted request fields', async () => {
  const first = await service.listHistory({ ownerKey: 'other', OPENID: 'other', gps: [1] });
  expect(wx.cloud.callFunction.mock.calls[0][0]).toEqual({ name: 'walkStore', data: { action: 'listHistory', limit: 10, cursor: null } });
  expect(first.items.map(w => w.rating)).toEqual([null, 4, null, null, null, null, null, null, null, null]);
  expect(first.totals).toEqual({ completedWalkCount: 13, endedEarlyWalkCount: 12 });
  const second = await service.listHistory({ cursor: first.nextCursor });
  const last = await service.listHistory({ cursor: second.nextCursor });
  expect(second.totals).toBeNull(); expect(last.nextCursor).toBeNull(); expect(last.items).toHaveLength(5);
  expect(new Set([...first.items, ...second.items, ...last.items].map(w => w.walkId)).size).toBe(25);
});
test('empty history and exact-limit terminal page have null cursor', async () => {
  state.data.walks.splice(0);
  expect(await service.listHistory()).toEqual({ items: [], nextCursor: null, totals: { completedWalkCount: 0, endedEarlyWalkCount: 0 } });
  state.data.walks.push(walk(0));
  expect((await service.listHistory({ limit: 1 })).nextCursor).toBeNull();
});
test.each([null, [], 'bad', { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '10' },
  { cursor: {} }, { cursor: false }, { cursor: { version: 2, endTime: walk(0).endTime, walkId: 'walk-000' } }])(
  'invalid input fails before cloud call: %j', async options => {
    await expect(service.listHistory(options)).rejects.toThrow();
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });
test.each([
  { walkId: '../bad' }, { walkId: 'x'.repeat(201) }, { status: 'active' }, { status: 'abandoned' },
  { startTime: null }, { startTime: 0 }, { startTime: '2026-02-30T00:00:00.000Z' },
  { startTime: '2026-10-09T01:00:00.000Z' }, { endTime: '2026-10-09' }, { endTime: 'invalid' },
  { actualDurationSeconds: -1 }, { actualDurationSeconds: 1.5 }, { actualDurationSeconds: 1801 }, { actualDurationSeconds: '1800' },
  { routeType: 'unknown' }, { requestedDurationMinutes: 14 }, { requestedDurationMinutes: 121 },
  { trajectoryEnabled: 'false' }, { trajectoryPartial: 'false' }, { trajectoryPartial: true },
  { trajectoryEndTimeMs: null }, { trajectoryEndTimeMs: 1 }, { trajectoryEndTimeMs: 253402300800000 },
  { rating: 0 }, { rating: 6 }, { rating: 1.5 }, { rating: '5' },
  { ownerKey: 'secret' }, { gps: [] }, { polyline: [] }, { poi: {} }, { provider: {} }
])('rejects malformed or excessive history item fields: %j', async change => {
  const page = await service.listHistory();
  page.items[0] = { ...page.items[0], ...change };
  mockResult(response(page));
  await expect(service.listHistory()).rejects.toThrow();
});
test.each(['items', 'totals', 'nextCursor'])('missing response field %s is invalid', async key => {
  const page = response(await service.listHistory()); delete page[key]; mockResult(page);
  await expect(service.listHistory()).rejects.toThrow();
});
test.each([null, {}, { completedWalkCount: -1, endedEarlyWalkCount: 0 },
  { completedWalkCount: 1.5, endedEarlyWalkCount: 0 }, { completedWalkCount: '13', endedEarlyWalkCount: 12 },
  { completedWalkCount: 13, endedEarlyWalkCount: Number.MAX_SAFE_INTEGER + 1 },
  { completedWalkCount: 13, endedEarlyWalkCount: 12, total: 25 }])('invalid first-page totals %j', async totals => {
  const page = await service.listHistory(); mockResult(response({ ...page, totals }));
  await expect(service.listHistory()).rejects.toThrow();
});
test.each([{}, '', { version: 0, walkId: 'walk-009', endTime: walk(0).endTime },
  { version: 1, walkId: 'walk-008', endTime: walk(0).endTime },
  { version: 1, walkId: 'walk-009', endTime: '2026-10-08T00:30:00.000Z' }])('invalid continuation %j', async nextCursor => {
  const page = await service.listHistory(); mockResult(response({ ...page, nextCursor }));
  await expect(service.listHistory()).rejects.toThrow();
});
test('rejects unsorted, duplicate, oversized, missing-field and short continued pages', async () => {
  const original = await service.listHistory();
  const changedItems = [
    [...original.items].reverse(),
    [original.items[0], ...original.items.slice(0, -1)],
    [...original.items, original.items[9]],
    original.items.slice(0, 2),
    [],
    null,
    [{ ...original.items[0], rating: undefined }, ...original.items.slice(1)]
  ];
  for (const items of changedItems) {
    mockResult(response({ ...original, items }));
    await expect(service.listHistory()).rejects.toThrow();
  }
});
test('continuation must advance strictly past request cursor and omit totals', async () => {
  const first = await service.listHistory();
  const second = await service.listHistory({ cursor: first.nextCursor });
  mockResult(response({ ...second, totals: first.totals }));
  await expect(service.listHistory({ cursor: first.nextCursor })).rejects.toThrow();
  mockResult(response({ ...first, totals: null }));
  await expect(service.listHistory({ cursor: first.nextCursor })).rejects.toThrow();
  mockResult(response({ ...second, items: [first.items[9], ...second.items.slice(1)] }));
  await expect(service.listHistory({ cursor: first.nextCursor })).rejects.toThrow();
});
test('validated response is detached from transport objects', async () => {
  const page = await service.listHistory(); mockResult(response(page));
  const normalized = await service.listHistory();
  normalized.items[0].rating = 1; normalized.totals.completedWalkCount = 0; normalized.nextCursor.walkId = 'changed';
  expect(page.items[0].rating).toBeNull(); expect(page.totals.completedWalkCount).toBe(13); expect(page.nextCursor.walkId).toBe('walk-009');
});
test('errors propagate without converting failure into empty history or missing ratings', async () => {
  state.intercept = q => { if (q.name === 'feedback') throw new Error('secret'); };
  await expect(service.listHistory()).rejects.toMatchObject({ code: 'WALK_STORE_FAILED', message: 'Walk storage is temporarily unavailable.' });
  wx.cloud.callFunction.mockRejectedValue(new Error('network secret'));
  await expect(service.listHistory()).rejects.toMatchObject({ code: 'WALK_STORE_FAILED', message: 'Unable to load walk history.' });
});
