const { createStore, transact } = require('./store');
function fixture() {
  const doc = { get: jest.fn().mockResolvedValue({ data: null }), set: jest.fn().mockResolvedValue({}) };
  const collection = { doc: jest.fn(() => doc) };
  const tx = { collection: jest.fn(() => collection), commit: jest.fn(), rollback: jest.fn() };
  const db = { startTransaction: jest.fn().mockResolvedValue(tx) };
  return { doc, collection, tx, db, store: createStore(db) };
}
test('missing feedback is read inside transaction; writes strip database ID and commit last', async () => {
  const f = fixture();
  await f.store.transaction(async tx => {
    expect(await tx.get('feedback/walk-1')).toBeNull();
    await tx.set('feedback/walk-1', { _id: 'walk-1', walkId: 'walk-1', rating: 4 });
    expect(f.tx.commit).not.toHaveBeenCalled();
  });
  expect(f.tx.collection).toHaveBeenCalledWith('feedback');
  expect(f.collection.doc).toHaveBeenCalledWith('walk-1');
  expect(f.doc.set).toHaveBeenCalledWith({ data: { walkId: 'walk-1', rating: 4 } });
  expect(f.tx.commit).toHaveBeenCalledTimes(1);
});
test.each(['get', 'set', 'commit'])('%s failure rolls back and preserves original error', async phase => {
  const f = fixture(), error = new Error('database failure');
  (phase === 'commit' ? f.tx.commit : f.doc[phase]).mockRejectedValue(error);
  f.tx.rollback.mockRejectedValue(new Error('already aborted'));
  await expect(f.store.transaction(async tx => {
    await tx.get('feedback/walk-1'); await tx.set('feedback/walk-1', {});
  })).rejects.toBe(error);
  expect(f.tx.rollback).toHaveBeenCalledTimes(1);
});
test('conflicts retry at most four times; non-conflict errors are not retried', async () => {
  const conflict = { code: 'DATABASE_TRANSACTION_CONFLICT' };
  const transaction = jest.fn().mockRejectedValue(conflict), sleep = jest.fn();
  await expect(transact({ transaction }, jest.fn(), sleep)).rejects.toBe(conflict);
  expect(transaction).toHaveBeenCalledTimes(4); expect(sleep).toHaveBeenCalledTimes(3);
  transaction.mockReset().mockRejectedValue(new Error('permission denied'));
  await expect(transact({ transaction }, jest.fn(), sleep)).rejects.toThrow('permission denied');
  expect(transaction).toHaveBeenCalledTimes(1);
});
