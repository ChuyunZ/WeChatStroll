const { createQuotaGate } = require('./quota');
const { createStore, isConflict } = require('./quota-store');
// Snapshot-isolated in-memory transactions emulate cross-instance concurrent commits.
function fakeStore() {
  const rows = new Map(), versions = new Map();
  const store = {
    rows,
    async transaction(work) {
      const snapshot = new Map([...rows].map(([key, value]) => [key, { ...value }]));
      const snapVersions = new Map(versions), read = new Set(), writes = new Map();
      const result = await work({
        async get(key) { read.add(key); return snapshot.get(key) || null; },
        async set(key, value) { writes.set(key, { ...value }); }
      });
      if ([...read].some(key => versions.get(key) !== snapVersions.get(key))) {
        throw Object.assign(new Error('write conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
      }
      for (const [key, value] of writes) {
        rows.set(key, value); versions.set(key, (versions.get(key) || 0) + 1);
      }
      return result;
    }
  };
  return store;
}
const noSleep = async () => {};
test('per-user and global counters enforce limits across independent gates', async () => {
  const store = fakeStore();
  const make = () => createQuotaGate({ store, now: () => Date.UTC(2026, 9, 9),
    userLimit: 2, globalLimit: 3, sleep: noSleep });
  const a = make(), b = make();
  expect((await a('alice')).allowed).toBe(true);
  expect((await b('alice')).allowed).toBe(true);
  expect(await a('alice')).toEqual({ allowed: false, reason: 'exhausted' });
  expect((await b('bob')).allowed).toBe(true);
  expect(await a('charlie')).toEqual({ allowed: false, reason: 'exhausted' });
  expect(store.rows.get('global').used).toBe(3);
  expect([...store.rows.keys()].join(' ')).not.toContain('alice');
});
test('UTC day rollover resets both counters in the same fixed documents', async () => {
  const store = fakeStore();
  let time = Date.UTC(2026, 9, 9, 23, 59, 59);
  const gate = createQuotaGate({ store, now: () => time, userLimit: 1, globalLimit: 1, sleep: noSleep });
  expect((await gate('alice')).allowed).toBe(true);
  expect((await gate('alice')).allowed).toBe(false);
  time += 2000;
  expect((await gate('alice')).allowed).toBe(true);
  expect(store.rows.size).toBe(2);
  expect(store.rows.get('global').used).toBe(1);
});
test('simultaneous clients do not exceed quota even with transactional conflicts', async () => {
  const store = fakeStore();
  const make = () => createQuotaGate({ store, now: () => Date.UTC(2026, 9, 9),
    userLimit: 2, globalLimit: 2, sleep: noSleep });
  const gates = Array.from({ length: 12 }, make);
  const outcomes = await Promise.allSettled(gates.map(gate => gate('alice')));
  const permitted = outcomes.filter(x => x.status === 'fulfilled' && x.value.allowed).length;
  expect(permitted).toBeLessThanOrEqual(2);
  expect(permitted).toBeGreaterThan(0);
  expect(store.rows.get('global').used).toBe(permitted);
  const userRow = [...store.rows.entries()].find(([id]) => id.startsWith('user_'))[1];
  expect(userRow.used).toBe(permitted);
});
test('unexpected storage failures and corrupt counters fail closed', async () => {
  const broken = { transaction: async () => { throw new Error('DATABASE_DOWN'); } };
  await expect(createQuotaGate({ store: broken, sleep: noSleep })('alice')).rejects.toThrow('DATABASE_DOWN');
  const store = fakeStore(); store.rows.set('global', { day: '2026-10-09', used: -1 });
  await expect(createQuotaGate({ store, now: () => Date.UTC(2026, 9, 9),
    sleep: noSleep })('alice')).rejects.toThrow('Invalid quota state');
});
test('real CloudBase adapter uses transaction and same dedicated collection', async () => {
  const docs = new Map();
  const tx = { collection: jest.fn(() => ({ doc: id => ({
    get: async () => ({ data: docs.get(id) || null }),
    set: async ({ data }) => { docs.set(id, data); }
  }) })), commit: jest.fn(), rollback: jest.fn() };
  const db = { startTransaction: jest.fn().mockResolvedValue(tx) };
  const gate = createQuotaGate({ store: createStore(db), now: () => Date.UTC(2026, 9, 9), sleep: noSleep });
  expect((await gate('alice')).allowed).toBe(true);
  expect(tx.collection).toHaveBeenCalledWith('route_copy_quotas');
  expect(tx.commit).toHaveBeenCalledTimes(1);
  expect(tx.rollback).not.toHaveBeenCalled();
});
test('transaction conflict predicate excludes ambiguous network errors', () => {
  expect(isConflict({ code: 'DATABASE_TRANSACTION_CONFLICT' })).toBe(true);
  expect(isConflict({ errMsg: 'database transaction conflict' })).toBe(true);
  expect(isConflict({ message: 'connection reset' })).toBe(false);
});
