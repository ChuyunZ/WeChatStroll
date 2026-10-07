const { createStore, conflict } = require('./store');
function fixture() {
  const queries = [];
  const doc = { get: jest.fn().mockResolvedValue({ data: null }), set: jest.fn().mockResolvedValue({}) };
  const tx = { collection: jest.fn(() => ({ doc: jest.fn(() => doc) })), commit: jest.fn(), rollback: jest.fn() };
  const db = {
    command: { in: jest.fn(ids => ({ $in: ids })) }, startTransaction: jest.fn().mockResolvedValue(tx),
    collection: jest.fn(name => {
      const query = { name, doc: jest.fn(() => doc), get: jest.fn().mockResolvedValue({ data: [] }) };
      for (const method of ['where', 'orderBy', 'limit', 'field']) query[method] = jest.fn(() => query);
      queries.push(query);
      return query;
    })
  };
  return { db, tx, doc, queries, store: createStore(db) };
}
test('first-time profile get reads server-derived document identity', async () => {
  const f = fixture();
  expect(await f.store.getProfile('owner')).toBeNull();
  expect(f.db.collection).toHaveBeenCalledWith('preference_profiles');
  expect(f.queries[0].doc).toHaveBeenCalledWith('owner');
});
test('bounded ownership/status queries project only application metadata; feedback loads only selected IDs', async () => {
  const f = fixture();
  const original = f.db.collection.getMockImplementation();
  f.db.collection.mockImplementation(name => {
    const query = original(name);
    query.get.mockImplementation(async () => ({ data: name === 'walks'
      ? Array.from({ length: 20 }, (_, i) => ({ _id: `walk-${i}`, walkId: `walk-${i}`, ownerKey: 'owner',
        status: query.where.mock.calls[0][0].status, endTime: '2026-10-07T00:00:00.000Z' }))
      : [{ _id: 'walk-1', walkId: 'walk-1', ownerKey: 'owner' },
        { _id: 'walk-2', walkId: 'walk-2', ownerKey: 'other' },
        { _id: 'unknown', walkId: 'unknown', ownerKey: 'owner' },
        { _id: 'wrong-id', walkId: 'walk-3', ownerKey: 'owner' }] }));
    return query;
  });
  const history = await f.store.loadHistory('owner');
  expect(new Set(history.walks.map(w => w.walkId)).size).toBe(20);
  expect(history.feedback).toEqual([{ _id: 'walk-1', walkId: 'walk-1', ownerKey: 'owner' }]);
  expect(f.queries.map(q => q.name)).toEqual(['walks', 'walks', 'feedback']);
  f.queries.slice(0, 2).forEach((query, i) => {
    expect(query.where).toHaveBeenCalledWith({ ownerKey: 'owner', status: ['completed', 'ended_early'][i] });
    expect(query.orderBy.mock.calls).toEqual([['endTime', 'desc'], ['walkId', 'asc']]);
  });
  f.queries.forEach(query => {
    expect(query.limit).toHaveBeenCalledWith(20);
    const projection = Object.keys(query.field.mock.calls[0][0]);
    expect(projection).not.toEqual(expect.arrayContaining(['comment']));
    expect(projection.join(' ')).not.toMatch(/polyline|providerMeta|gps|routeId|trajectory/);
  });
  expect(f.queries[2].where).toHaveBeenCalledWith({ ownerKey: 'owner', walkId: { $in: expect.any(Array) } });
  expect(f.db.command.in.mock.calls[0][0]).toHaveLength(20);
});
test('no eligible walks skips feedback query', async () => {
  const f = fixture();
  expect(await f.store.loadHistory('owner')).toEqual({ walks: [], feedback: [] });
  expect(f.queries).toHaveLength(2);
});
test('CAS creates profile atomically; unchanged fingerprint preserves timestamp/revision without write', async () => {
  const f = fixture();
  const profile = { schemaVersion: 1, source: { fingerprint: 'same' }, lastUpdatedAt: 'first' };
  const saved = await f.store.compareAndSet('owner', 0, profile);
  expect(saved).toEqual({ retry: false, record: { ownerKey: 'owner', revision: 1, ...profile } });
  expect(f.doc.set).toHaveBeenCalledWith({ data: saved.record });
  expect(f.doc.set.mock.invocationCallOrder[0]).toBeLessThan(f.tx.commit.mock.invocationCallOrder[0]);
  f.doc.get.mockResolvedValue({ data: saved.record });
  f.doc.set.mockClear();
  expect(await f.store.compareAndSet('owner', 1, { ...profile, lastUpdatedAt: 'later' })).toEqual(saved);
  expect(f.doc.set).not.toHaveBeenCalled();
});
test('stale revision rolls back without writing; changed profile increments revision', async () => {
  const f = fixture();
  f.doc.get.mockResolvedValue({ data: { ownerKey: 'owner', revision: 2, source: { fingerprint: 'new' } } });
  expect(await f.store.compareAndSet('owner', 1, { source: { fingerprint: 'old' } })).toEqual({ retry: true });
  expect(f.doc.set).not.toHaveBeenCalled();
  expect(f.tx.commit).not.toHaveBeenCalled();
  expect(f.tx.rollback).toHaveBeenCalledTimes(1);
  expect((await f.store.compareAndSet('owner', 2, { source: { fingerprint: 'newer' } })).record.revision).toBe(3);
});
test.each(['get', 'set', 'commit'])('%s failure rolls back, preserves error, and never returns success', async method => {
  const f = fixture(), error = new Error('secret');
  (method === 'commit' ? f.tx.commit : f.doc[method]).mockRejectedValue(error);
  f.tx.rollback.mockRejectedValue(new Error('rollback'));
  await expect(f.store.compareAndSet('owner', 0, { source: { fingerprint: 'new' } })).rejects.toBe(error);
  expect(f.tx.rollback).toHaveBeenCalled();
});
test('empty history clears old snapshot with revision tombstone, then later evidence can recreate it', async () => {
  const f = fixture();
  f.doc.get.mockResolvedValue({ data: { ownerKey: 'owner', revision: 3, source: { fingerprint: 'old' } } });
  const empty = await f.store.compareAndSet('owner', 3, null);
  expect(empty.record).toEqual({ ownerKey: 'owner', revision: 4, profile: null });
  f.doc.get.mockResolvedValue({ data: empty.record });
  f.doc.set.mockClear();
  expect(await f.store.compareAndSet('owner', 4, null)).toEqual(empty);
  expect(f.doc.set).not.toHaveBeenCalled();
  expect((await f.store.compareAndSet('owner', 4, { source: { fingerprint: 'new' } })).record.revision).toBe(5);
});
test.each([{ code: 'DATABASE_TRANSACTION_CONFLICT' }, { message: 'database transaction conflict' }, { errMsg: 'write conflict' }])('recognizes conflict %j', error => {
  expect(conflict(error)).toBeTruthy();
  expect(conflict(new Error('permission denied'))).toBe(false);
});
