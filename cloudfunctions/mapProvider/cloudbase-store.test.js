const { createCloudBaseStore, isTransactionConflict } = require('./cloudbase-store')

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
    expect(await tx.get('tencent:poi-explore')).toBeNull()
    await tx.set('tencent:poi-explore', state)
    expect(f.transaction.commit).not.toHaveBeenCalled()
    return 'acquired'
  })
  expect(result).toBe('acquired')
  expect(f.transaction.collection).toHaveBeenCalledWith('provider_rate_limits')
  expect(f.collection.doc).toHaveBeenCalledWith('tencent:poi-explore')
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
    await tx.get('tencent:key')
    await tx.set('tencent:key', { nextAllowedAtMs: 0, cooldownUntilMs: 0 })
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

test('recognizes symbolic and wx SDK wrapped conflicts, not generic DB failures', () => {
  for (const error of [{ code: 'DATABASE_TRANSACTION_CONFLICT' },
    { errMsg: 'document.set:fail -501001. database transaction conflict' },
    { errMsg: 'document.set:fail Write conflict' }]) expect(isTransactionConflict(error)).toBe(true)
  for (const error of [null, { code: 'DATABASE_COLLECTION_NOT_EXIST' },
    { errCode: -501001, errMsg: 'network failed' }]) expect(isTransactionConflict(error)).toBe(false)
})
