const { createStore: createCloudBaseStore, transact } = require('./store')

function fixture() {
  const document = { get: jest.fn().mockResolvedValue({ data: null }), set: jest.fn().mockResolvedValue({}) }
  const collection = { doc: jest.fn(() => document) }
  const transaction = { collection: jest.fn(() => collection),
    commit: jest.fn().mockResolvedValue({}), rollback: jest.fn().mockResolvedValue({}) }
  const db = { startTransaction: jest.fn().mockResolvedValue(transaction) }
  return { document, collection, transaction, db, store: createCloudBaseStore(db) }
}

test('missing document uses transactional set and commits only after work', async () => {
  const f = fixture()
  const state = { nextAllowedAtMs: 1000, cooldownUntilMs: 0, updatedAtMs: 10 }
  const result = await f.store.transaction(async tx => {
    expect(await tx.get('walks/test')).toBeNull()
    await tx.set('walks/test', state)
    expect(f.transaction.commit).not.toHaveBeenCalled()
    return 'acquired'
  })
  expect(result).toBe('acquired')
  expect(f.transaction.collection).toHaveBeenCalledWith('walks')
  expect(f.collection.doc).toHaveBeenCalledWith('test')
  expect(f.document.set).toHaveBeenCalledWith({ data: state })
  expect(f.transaction.commit).toHaveBeenCalledTimes(1)
  expect(f.transaction.rollback).not.toHaveBeenCalled()
})

test.each(['read', 'write', 'commit'])('%s failure rolls back before propagating, preserving the conflict code', async phase => {
  const f = fixture()
  const error = { code: 'DATABASE_TRANSACTION_CONFLICT' }
  const failing = phase === 'read' ? f.document.get : phase === 'write' ? f.document.set : f.transaction.commit
  failing.mockRejectedValue(error)
  await expect(f.store.transaction(async tx => {
    await tx.get('walks/test')
    await tx.set('walks/test', { nextAllowedAtMs: 0, cooldownUntilMs: 0 })
  })).rejects.toBe(error)
  expect(f.transaction.rollback).toHaveBeenCalledTimes(1)
})

test('rollback error cannot replace the original error; startup failure opens no transaction', async () => {
  const f = fixture()
  const error = new Error('original')
  f.transaction.rollback.mockRejectedValue(new Error('already aborted'))
  await expect(f.store.transaction(async () => { throw error })).rejects.toBe(error)
  f.db.startTransaction.mockRejectedValue(error)
  await expect(f.store.transaction(jest.fn())).rejects.toBe(error)
  expect(f.transaction.rollback).toHaveBeenCalledTimes(1)
})



test('transaction conflicts retry with bounded exponential backoff and jitter', async () => {
  const conflict = new Error('database transaction conflict');
  const transaction = jest.fn()
    .mockRejectedValueOnce(conflict)
    .mockRejectedValueOnce({ message: 'write conflict' })
    .mockRejectedValueOnce({ errMsg: 'DATABASE_TRANSACTION_CONFLICT' })
    .mockResolvedValue('ok');
  const sleep = jest.fn().mockResolvedValue();
  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

  try {
    await expect(transact({ transaction }, jest.fn(), sleep)).resolves.toBe('ok');
  } finally {
    randomSpy.mockRestore();
  }

  expect(transaction).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([15, 30, 60]);
});

test('transaction retry stops after four attempts and never sleeps after the final conflict', async () => {
  const conflict = { code: 'DATABASE_TRANSACTION_CONFLICT' };
  const transaction = jest.fn().mockRejectedValue(conflict);
  const sleep = jest.fn().mockResolvedValue();
  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

  try {
    await expect(transact({ transaction }, jest.fn(), sleep)).rejects.toBe(conflict);
  } finally {
    randomSpy.mockRestore();
  }

  expect(transaction).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 40]);
});

test('non-conflict database failures are not retried', async () => {
  const failure = new Error('permission denied');
  const transaction = jest.fn().mockRejectedValue(failure);
  const sleep = jest.fn();

  await expect(transact({ transaction }, jest.fn(), sleep)).rejects.toBe(failure);

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});


test('database-managed _id never leaks into lifecycle replacement writes', async () => {
  const f = fixture();
  f.document.get.mockResolvedValue({
    data: {
      _id: 'walk-1',
      walkId: 'walk-1',
      ownerKey: 'owner',
      status: 'active'
    }
  });

  await f.store.transaction(async tx => {
    const record = await tx.get('walks/walk-1');
    expect(record).toEqual({
      walkId: 'walk-1',
      ownerKey: 'owner',
      status: 'active'
    });

    await tx.set('walks/walk-1', {
      ...record,
      _id: 'walk-1',
      status: 'completed'
    });
  });

  expect(f.document.set).toHaveBeenCalledWith({
    data: {
      walkId: 'walk-1',
      ownerKey: 'owner',
      status: 'completed'
    }
  });
});
