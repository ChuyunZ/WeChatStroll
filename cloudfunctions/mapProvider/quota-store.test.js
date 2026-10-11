const { createQuotaStore, transact, COLLECTION } = require('./quota-store')
test('adapter commits all operations together using the independent collection', async () => {
  const doc = { get: jest.fn(async () => ({ data: { used: 1 } })), set: jest.fn(async () => {}) }
  const tx = { collection: jest.fn(() => ({ doc: jest.fn(() => doc) })),
    commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}) }
  const store = createQuotaStore({ startTransaction: async () => tx })
  expect(await transact(store, async t => { const value = await t.get('test'); await t.set('test', { used: value.used + 1 }); return 2 })).toBe(2)
  expect(tx.collection).toHaveBeenCalledWith(COLLECTION)
  expect(doc.set).toHaveBeenCalledWith({ data: { used: 2 } })
  expect(tx.commit).toHaveBeenCalledTimes(1)
  expect(tx.rollback).not.toHaveBeenCalled()
})
test('uncertain commit is not retried even if rollback fails', async () => {
  const tx = { commit: jest.fn(async () => { throw new Error('lost ack') }),
    rollback: jest.fn(async () => { throw new Error('already committed') }) }
  const db = { startTransaction: jest.fn(async () => tx) }
  await expect(transact(createQuotaStore(db), async () => true)).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(db.startTransaction).toHaveBeenCalledTimes(1)
  expect(tx.rollback).toHaveBeenCalledTimes(1)
})
