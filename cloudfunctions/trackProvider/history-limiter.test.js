const crypto = require('crypto');
const { createHistoryLimiter, createQuotaStore, COLLECTION, LIMIT, WINDOW_MS } = require('./history-limiter');
const { createTestStore } = require('../mapProvider/test-store');
const { createTrackHandler } = require('./handler');
const { testWalk, END_MS } = require('./test-walk');
const NOW = END_MS + WINDOW_MS * 2;
const id = user => crypto.createHash('sha256').update(user).digest('hex');
function fixture() {
  const store = createTestStore(); let time = NOW;
  const sleep = jest.fn().mockResolvedValue();
  const limiter = () => createHistoryLimiter({ store, now: () => time, sleep, random: () => 0 });
  return { store, sleep, limiter, setNow: value => { time = value; } };
}
test('first and repeated reservations persist only bounded timestamps under a hashed ID', async () => {
  const f = fixture(); await f.limiter().reserve('user'); await f.limiter().reserve('user');
  expect([...f.store.documents.keys()]).toEqual([id('user')]);
  expect(f.store.documents.get(id('user'))).toEqual({ requestTimesMs: [NOW, NOW], updatedAtMs: NOW });
});
test('20 allowed and 21st rejected, independently for each authenticated user', async () => {
  const f = fixture();
  for (let i = 0; i < LIMIT; i++) await f.limiter().reserve('user');
  await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_SEARCH_RATE_LIMITED' });
  await f.limiter().reserve('another'); expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(20);
  expect(f.store.documents.get(id('another')).requestTimesMs).toHaveLength(1);
});
test('rolling window expires only timestamps at or before its left boundary', async () => {
  const f = fixture();
  f.store.documents.set(id('user'), { requestTimesMs: [NOW - WINDOW_MS, ...Array(19).fill(NOW - WINDOW_MS + 1)], updatedAtMs: NOW - WINDOW_MS + 1 });
  await f.limiter().reserve('user'); expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(20);
  await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_SEARCH_RATE_LIMITED' });
  f.setNow(NOW + 1); await f.limiter().reserve('user');
  expect(f.store.documents.get(id('user')).requestTimesMs).toEqual([NOW, NOW + 1]);
});
test('two independent instances cannot both consume the last slot', async () => {
  const f = fixture(); f.store.documents.set(id('user'), { requestTimesMs: Array(19).fill(NOW), updatedAtMs: NOW });
  const results = await Promise.allSettled([f.limiter().reserve('user'), f.limiter().reserve('user')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('TRACK_SEARCH_RATE_LIMITED');
  expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(20); expect(f.store.conflicts).toBeGreaterThan(0);
});
test('concurrent first requests reserve separately after missing-document conflict', async () => {
  const f = fixture(); await Promise.all([f.limiter().reserve('user'), f.limiter().reserve('user')]);
  expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(2); expect(f.store.conflicts).toBe(1);
});
test('conflicts use bounded backoff; exhaustion does not write or masquerade as quota', async () => {
  const f = fixture(); f.store.forcedConflicts = 3; await f.limiter().reserve('user');
  expect(f.sleep.mock.calls.map(call => call[0])).toEqual([10, 20, 40]);
  expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(1);
  f.store.forcedConflicts = 4; await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
  expect(f.store.transactions).toBe(8); expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(1);
});
test.each([{}, { requestTimesMs: 'bad', updatedAtMs: NOW }, { requestTimesMs: Array(21).fill(NOW), updatedAtMs: NOW },
  { requestTimesMs: [NOW + 1], updatedAtMs: NOW + 1 }, { requestTimesMs: [NOW, NOW - 1], updatedAtMs: NOW - 1 },
  { requestTimesMs: [NaN], updatedAtMs: NOW }, { requestTimesMs: ['1'], updatedAtMs: NOW },
  { requestTimesMs: [NOW], updatedAtMs: NOW, walkId: 'private' }, { requestTimesMs: [NOW], updatedAtMs: Number.MAX_SAFE_INTEGER + 1 },
  { requestTimesMs: [NOW - WINDOW_MS - 1, -1], updatedAtMs: NOW }, { requestTimesMs: Array(1), updatedAtMs: NOW }])('malformed state fails closed before expiry pruning: %j', record => {
  const f = fixture(); f.store.documents.set(id('user'), record);
  return expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
});
test.each([new Error('collection missing: private'), new Error('database unavailable')])('storage failures return fixed safe errors', async error => {
  const f = fixture(); f.store.failure = error;
  await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED', message: 'Walking trajectory query quota is temporarily unavailable.' });
  expect(f.store.transactions).toBe(1); expect(f.sleep).not.toHaveBeenCalled();
});
test('commit acknowledgement loss is fail closed and keeps consumed reservation', async () => {
  const f = fixture(); f.store.afterCommit = () => { throw new Error('ack lost'); };
  await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
  expect(f.store.documents.get(id('user')).requestTimesMs).toHaveLength(1);
});
test('server rollback of clock fails closed rather than deleting future reservations', async () => {
  const f = fixture(); await f.limiter().reserve('user'); f.setNow(NOW - 1);
  await expect(f.limiter().reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
});
test('SDK-wrapped write conflicts retry; invalid transaction results are infrastructure failures', async () => {
  const f = fixture(); const store = { transaction: jest.fn().mockRejectedValueOnce({ errMsg: 'document.set: write conflict' })
    .mockImplementation(work => f.store.transaction(work)) };
  await createHistoryLimiter({ store, now: () => NOW, sleep: f.sleep }).reserve('user');
  expect(f.sleep).toHaveBeenCalledTimes(1);
  await expect(createHistoryLimiter({ store: { transaction: async () => undefined } }).reserve('user'))
    .rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
});
function handlerFixture(f, changes = {}) {
  const client = { ensureEntity: jest.fn().mockResolvedValue({}), searchTrace: jest.fn().mockResolvedValue({ points: [] }), uploadTrace: jest.fn().mockResolvedValue({ uploadedCount: 1 }) };
  const reserve = jest.fn(openid => f.limiter().reserve(openid)), getWalk = jest.fn().mockResolvedValue(testWalk(changes));
  const handler = createTrackHandler({ config: { entitySecret: 'test-secret' }, client, historyLimiter: { reserve },
    walkStore: { getWalk }, getOpenId: () => 'openid-one', getNowMs: () => NOW });
  return { client, reserve, getWalk, handler };
}
const request = { action: 'searchWalkTrace', walkId: 'walk-1' };
test('authorization precedes reservation, commit precedes Entity/search, failures still consume slots', async () => {
  const f = fixture(), h = handlerFixture(f);
  h.client.ensureEntity.mockImplementation(async () => { expect(f.store.documents.get(id('openid-one')).requestTimesMs).toHaveLength(1); });
  h.client.searchTrace.mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'TRACK_SEARCH_FAILED' }));
  expect((await h.handler(request)).error.code).toBe('TRACK_SEARCH_FAILED');
  expect(h.getWalk.mock.invocationCallOrder[0]).toBeLessThan(h.reserve.mock.invocationCallOrder[0]);
  expect(h.reserve).toHaveBeenCalledWith('openid-one');
  expect(h.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.client.ensureEntity.mock.invocationCallOrder[0]);
  await h.handler(request); expect(f.store.documents.get(id('openid-one')).requestTimesMs).toHaveLength(2);
});
test.each(['full', 'missing', 'malformed'])('%s quota never permits any Tencent request', async mode => {
  const f = fixture(), h = handlerFixture(f);
  if (mode === 'full') f.store.documents.set(id('openid-one'), { requestTimesMs: Array(20).fill(NOW), updatedAtMs: NOW });
  if (mode === 'missing') f.store.failure = new Error('collection missing');
  if (mode === 'malformed') f.store.documents.set(id('openid-one'), {});
  expect((await h.handler(request)).error.code).toBe(mode === 'full' ? 'TRACK_SEARCH_RATE_LIMITED' : 'TRACK_RATE_LIMIT_STORE_FAILED');
  expect(h.client.ensureEntity).not.toHaveBeenCalled(); expect(h.client.searchTrace).not.toHaveBeenCalled();
});
test('upload and standalone Entity preparation do not access quota storage', async () => {
  const f = fixture(), h = handlerFixture(f); f.store.failure = new Error('offline');
  expect((await h.handler({ action: 'ensureEntity' })).success).toBe(true);
  expect((await h.handler({ action: 'uploadTrace', routeId: 'r', walkStartTimeMs: END_MS - 1000,
    point: { latitude: 31, longitude: 121, timestampMs: END_MS } })).success).toBe(true);
  expect(h.reserve).not.toHaveBeenCalled(); expect(f.store.transactions).toBe(0);
});
test.each(['TRACK_ENTITY_FAILED', 'TRACK_SEARCH_PAGINATION_FAILED'])('%s still consumes exactly one logical reservation', async code => {
  const f = fixture(), h = handlerFixture(f);
  const method = code === 'TRACK_ENTITY_FAILED' ? 'ensureEntity' : 'searchTrace';
  h.client[method].mockRejectedValue(Object.assign(new Error('private'), { code }));
  expect((await h.handler(request)).error.code).toBe(code);
  expect(h.reserve).toHaveBeenCalledTimes(1); expect(f.store.documents.get(id('openid-one')).requestTimesMs).toHaveLength(1);
});
test('omitting the limiter dependency cannot enable a bypass', async () => {
  const client = { ensureEntity: jest.fn(), searchTrace: jest.fn() };
  const handler = createTrackHandler({ config: {}, client, getOpenId: () => 'openid-one',
    walkStore: { getWalk: async () => testWalk() }, getNowMs: () => NOW });
  expect((await handler(request)).error.code).toBe('TRACK_RATE_LIMIT_STORE_FAILED'); expect(client.ensureEntity).not.toHaveBeenCalled();
});
describe('CloudBase transaction adapter', () => {
  let document, transaction, db;
  beforeEach(() => {
    document = { get: jest.fn().mockResolvedValue({ data: null }), set: jest.fn().mockResolvedValue({}) };
    transaction = { collection: jest.fn(() => ({ doc: jest.fn(() => document) })), commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() };
    db = { startTransaction: jest.fn().mockResolvedValue(transaction) };
  });
  test('reads and writes only the dedicated collection and commits before success', async () => {
    await createHistoryLimiter({ store: createQuotaStore(db), now: () => NOW }).reserve('user');
    expect(transaction.collection.mock.calls.every(([name]) => name === COLLECTION)).toBe(true);
    expect(document.set).toHaveBeenCalledWith({ data: { requestTimesMs: [NOW], updatedAtMs: NOW } });
    expect(document.set.mock.invocationCallOrder[0]).toBeLessThan(transaction.commit.mock.invocationCallOrder[0]);
    expect(transaction.rollback).not.toHaveBeenCalled();
  });
  test.each(['get', 'set', 'commit'])('%s failure rolls back and remains closed', async method => {
    (method === 'commit' ? transaction : document)[method].mockRejectedValue(new Error('secret'));
    await expect(createHistoryLimiter({ store: createQuotaStore(db), now: () => NOW }).reserve('user')).rejects.toMatchObject({ code: 'TRACK_RATE_LIMIT_STORE_FAILED' });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
  });
});
