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

