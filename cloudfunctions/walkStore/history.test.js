const { createStore } = require('./store');
const { createWalkHandler } = require('./handler');
const { historyDb, walk, ownerKey } = require('../../tests/helpers/history-db');
function fixture(walks, feedback, openid = 'user') {
  const state = historyDb(walks, feedback);
  state.handle = createWalkHandler({ store: createStore(state.db), getOpenId: () => openid });
  state.list = options => state.handle({ action: 'listHistory', ...options });
  return state;
}
test.each([[], [walk(0)], [walk(1)], [walk(0), walk(1)]].map(walks => [walks]))('first page counts terminal statuses independently: %j', async walks => {
  const f = fixture([...walks, walk(90, { status: 'active' }), walk(91, { status: 'abandoned' }), walk(92, { ownerKey: 'other' })]);
  const result = await f.list();
  expect(result).toMatchObject({ success: true, nextCursor: null, totals: {
    completedWalkCount: walks.filter(w => w.status === 'completed').length,
    endedEarlyWalkCount: walks.filter(w => w.status === 'ended_early').length
  } });
  expect(result.items.map(w => w.walkId)).toEqual(walks.map(w => w.walkId));
  expect(result.items.every(w => w.rating === null)).toBe(true);
  expect(f.calls.filter(q => q.name === 'feedback')).toHaveLength(walks.length ? 1 : 0);
});
test.each(['completed', 'ended_early', 'mixed'])('all pages beyond 20, ties and exact-limit final page: %s', async mode => {
  const walks = Array.from({ length: 36 }, (_, i) => walk(i, mode === 'mixed' ? {} : { status: mode })).reverse();
  const f = fixture(walks);
  let cursor = null;
  const ids = [];
  do {
    const result = await f.list({ limit: 6, cursor });
    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(6);
    expect(result.totals).toEqual(cursor ? null : {
      completedWalkCount: mode === 'completed' ? 36 : mode === 'mixed' ? 18 : 0,
      endedEarlyWalkCount: mode === 'ended_early' ? 36 : mode === 'mixed' ? 18 : 0
    });
    ids.push(...result.items.map(w => w.walkId));
    cursor = result.nextCursor;
  } while (cursor);
  expect(ids).toEqual(Array.from({ length: 36 }, (_, i) => walk(i).walkId));
  expect(new Set(ids).size).toBe(36);
  expect(f.calls.filter(q => q.method === 'count')).toHaveLength(2);
  f.calls.forEach(q => {
    expect(q.where.ownerKey).toBe(ownerKey);
    if (q.method === 'get') expect(q.limit).toBeLessThanOrEqual(7);
  });
});
test('merges unequal status populations across time ranges and ignores newer insertions on continuation', async () => {
  const f = fixture(Array.from({ length: 25 }, (_, i) => walk(i, { status: i === 5 ? 'ended_early' : 'completed',
    endTime: `2026-10-09T00:${String(30 + Math.floor(i / 3)).padStart(2, '0')}:00.000Z`,
    actualDurationSeconds: (30 + Math.floor(i / 3)) * 60,
    trajectoryEndTimeMs: Date.parse(`2026-10-09T00:${String(30 + Math.floor(i / 3)).padStart(2, '0')}:00.000Z`) })));
  const first = await f.list({ limit: 4 });
  f.data.walks.push(walk(99, { endTime: '2026-10-10T00:00:00.000Z', actualDurationSeconds: 86400,
    trajectoryEndTimeMs: Date.parse('2026-10-10T00:00:00.000Z') }));
  const all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await f.list({ limit: 4, cursor });
    expect(page.success).toBe(true);
    all.push(...page.items); cursor = page.nextCursor;
  }
  const expected = f.data.walks.filter(w => w.walkId !== 'walk-099').sort((a, b) =>
    b.endTime.localeCompare(a.endTime) || a.walkId.localeCompare(b.walkId));
  expect(all.map(w => w.walkId)).toEqual(expected.map(w => w.walkId));
  expect((await f.list()).items[0].walkId).toBe('walk-099');
});
test('feedback is joined once per page; only safe fields are returned and projected', async () => {
  const f = fixture([walk(0, { gps: [1], ownerOpenId: 'secret', polyline: [1], provider: {} }), walk(1)],
    [{ _id: 'walk-001', walkId: 'walk-001', ownerKey, rating: 5, comment: 'secret', positiveTags: ['quiet'] }]);
  const result = await f.list({ ownerKey: 'other', OPENID: 'other', openid: 'other' });
  expect(result.items.map(w => w.rating)).toEqual([null, 5]);
  expect(JSON.stringify(result)).not.toMatch(/owner|secret|gps|polyline|provider|comment|positiveTags/);
  const feedbackQuery = f.calls.filter(q => q.name === 'feedback');
  expect(feedbackQuery).toHaveLength(1);
  expect(feedbackQuery[0].where.walkId.value).toEqual(['walk-000', 'walk-001']);
  f.calls.filter(q => q.method === 'get').forEach(q => {
    expect(Object.keys(q.field).join(' ')).not.toMatch(/gps|polyline|provider|comment|preferences|routeId|poi/i);
  });
});
test.each([{ ownerKey: 'other' }, { _id: 'wrong' }, { walkId: 'unknown' }, { rating: 0 }, { rating: 6 }, { rating: 1.5 }])(
  'invalid feedback fails the entire page: %j', async change => {
    const f = fixture([walk(0)]);
    f.intercept = q => q.name === 'feedback' ? { data: [{ _id: 'walk-000', walkId: 'walk-000', ownerKey, rating: 5, ...change }] } : undefined;
    expect(await f.list()).toEqual({ success: false, error: { code: 'WALK_STORE_FAILED', message: 'Walk storage is temporarily unavailable.' } });
  });
test.each([{ ownerKey: 'other' }, { _id: 'wrong' }, { walkId: '../bad' }, { status: 'active' },
  { startTime: '2026-02-30T00:00:00.000Z' }, { endTime: 'bad' }, { actualDurationSeconds: -1 },
  { actualDurationSeconds: 1801 }, { actualDurationSeconds: '1800' }, { requestedDurationMinutes: 121 },
  { routeType: 'unknown' }, { trajectoryEnabled: 1 }, { trajectoryPartial: true }, { trajectoryEndTimeMs: null }])(
  'invalid database walk never leaks: %j', async change => {
    const f = fixture();
    f.intercept = q => q.name === 'walks' && q.method === 'get' && q.where.status === 'completed'
      ? { data: [walk(0, change)] } : undefined;
    expect((await f.list()).error.code).toBe('WALK_STORE_FAILED');
  });
test.each(['walks', 'feedback', 'count'])('%s failure cannot become a partial success', async target => {
  const f = fixture([walk(0)]);
  f.intercept = q => {
    if ((target === 'count' && q.method === 'count') || (q.name === target && q.method === 'get')) throw new Error('secret provider error');
  };
  const result = await f.list();
  expect(result.error.code).toBe('WALK_STORE_FAILED');
  expect(JSON.stringify(result)).not.toContain('secret');
});
test.each([-1, 1.5, '10', null, Number.MAX_SAFE_INTEGER + 1])('invalid count %j rejects the page', async total => {
  const f = fixture();
  f.intercept = q => q.method === 'count' ? { total } : undefined;
  expect((await f.list()).error.code).toBe('WALK_STORE_FAILED');
});
test.each(['walks', 'feedback'])('duplicate %s identities fail closed', async name => {
  const f = fixture([walk(0)]);
  f.intercept = q => {
    if (q.name !== name || q.method !== 'get' || (name === 'walks' && q.where.status !== 'completed')) return;
    const record = name === 'walks' ? walk(0) : { _id: 'walk-000', walkId: 'walk-000', ownerKey, rating: 4 };
    return { data: [record, record] };
  };
  expect((await f.list()).error.code).toBe('WALK_STORE_FAILED');
});
test.each([0, 21, -1, 1.5, '10', null])('invalid limit %j does not query', async limit => {
  const f = fixture();
  expect((await f.list({ limit })).error.code).toBe('INVALID_INPUT');
  expect(f.calls).toHaveLength(0);
});
test.each([{}, '', { version: 0, walkId: 'walk-000', endTime: walk(0).endTime },
  { version: 1, walkId: '../bad', endTime: walk(0).endTime },
  { version: 1, walkId: 'walk-000', endTime: 'invalid' }])('malformed/old cursor %j does not query', async cursor => {
  const f = fixture();
  expect((await f.list({ cursor })).error.code).toBe('INVALID_HISTORY_CURSOR');
  expect(f.calls).toHaveLength(0);
});
test.each(['missing', 'owner', 'time', 'status'])('stale or forged cursor anchor: %s', async mutation => {
  const f = fixture([walk(0), walk(1)]);
  const first = await f.list({ limit: 1 });
  if (mutation === 'missing') f.data.walks.shift();
  if (mutation === 'owner') f.data.walks[0].ownerKey = 'other';
  if (mutation === 'time') first.nextCursor.endTime = '2026-10-09T00:31:00.000Z';
  if (mutation === 'status') f.data.walks[0].status = 'abandoned';
  expect((await f.list({ cursor: first.nextCursor })).error.code).toBe('INVALID_HISTORY_CURSOR');
});
test('authentication comes only from context; default and maximum limits are bounded', async () => {
  const missing = fixture([], [], '');
  expect((await missing.list({ OPENID: 'user', ownerKey })).error.code).toBe('UNAUTHENTICATED');
  expect(missing.calls).toHaveLength(0);
  const f = fixture(Array.from({ length: 50 }, (_, i) => walk(i)));
  expect((await f.list()).items).toHaveLength(10);
  expect((await f.list({ limit: 20 })).items).toHaveLength(20);
  expect(f.calls.filter(q => q.method === 'get').every(q => q.limit <= 21)).toBe(true);
});
