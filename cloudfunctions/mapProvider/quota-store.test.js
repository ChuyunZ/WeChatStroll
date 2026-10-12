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

test('safe diagnostics isolate a failed request read without logging IDs or SDK messages', async () => {
  const log = jest.fn()
  const secret = 'super-private-key-and-location-data'
  const id = 'request_' + 'a'.repeat(64)
  const error = Object.assign(new Error(secret), {
    code: 'DATABASE_DOCUMENT_NOT_EXIST', errMsg: secret
  })
  const tx = {
    collection: () => ({ doc: () => ({
      get: async () => { throw error }
    }) }),
    rollback: jest.fn(async () => {}),
    commit: jest.fn(async () => {})
  }
  const store = createQuotaStore({ startTransaction: async () => tx }, { log })
  await expect(transact(store, t => t.get(id))).rejects.toMatchObject({
    code: 'MAP_QUOTA_UNAVAILABLE'
  })
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith({
    event: 'map_quota_transaction_failed', phase: 'read_request',
    kind: 'sdk_or_unknown', sdkCode: 'DATABASE_DOCUMENT_NOT_EXIST'
  })
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  expect(JSON.stringify(log.mock.calls)).not.toContain(id)
  expect(tx.rollback).toHaveBeenCalledTimes(1)
  expect(tx.commit).not.toHaveBeenCalled()
})

test('start, application validation and ambiguous commit failures are differentiated safely', async () => {
  const log = jest.fn()
  const privateMessage = 'private owner and provider key'
  const startFailure = Object.assign(new Error(privateMessage), { code: 'DATABASE_ACCESS_DENIED' })
  await expect(transact(createQuotaStore({
    startTransaction: async () => { throw startFailure }
  }, { log }), async () => {})).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(log).toHaveBeenLastCalledWith({
    event: 'map_quota_transaction_failed', phase: 'start',
    kind: 'sdk_or_unknown', sdkCode: 'DATABASE_ACCESS_DENIED'
  })
  const tx = {
    collection: () => ({ doc: () => ({ get: async () => ({ data: {} }) }) }),
    commit: jest.fn(async () => { throw new Error(privateMessage) }),
    rollback: jest.fn(async () => { throw new Error(privateMessage) })
  }
  const store = createQuotaStore({ startTransaction: async () => tx }, { log })
  await expect(transact(store, async t => {
    await t.get('day_20738')
    throw Object.assign(new Error(privateMessage), { code: 'MAP_QUOTA_UNAVAILABLE' })
  })).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(log).toHaveBeenLastCalledWith({
    event: 'map_quota_transaction_failed', phase: 'read_day', kind: 'application'
  })
  await expect(transact(store, () => true)).rejects.toMatchObject({
    code: 'MAP_QUOTA_UNAVAILABLE'
  })
  expect(log).toHaveBeenLastCalledWith({
    event: 'map_quota_transaction_failed', phase: 'commit', kind: 'sdk_or_unknown'
  })
  expect(JSON.stringify(log.mock.calls)).not.toContain(privateMessage)
})

test('successful transaction logs no diagnostic events', async () => {
  const log = jest.fn()
  const tx = {
    collection: () => ({ doc: () => ({ get: async () => ({ data: {} }) }) }),
    commit: jest.fn(async () => {}),
    rollback: jest.fn()
  }
  const store = createQuotaStore({ startTransaction: async () => tx }, { log })
  await expect(transact(store, t => t.get('calendar'))).resolves.toEqual({})
  expect(log).not.toHaveBeenCalled()
  expect(tx.rollback).not.toHaveBeenCalled()
})
