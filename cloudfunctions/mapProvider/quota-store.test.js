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

test('CloudBase-shaped documents round-trip safe nested keys and never write _id', async () => {
  const { createQuota, emptyCreations, DAY } = require('./quota')
  const owner = 'a'.repeat(64)
  const documents = new Map([
    ['calendar', { activeFromMs: 0, offsetMinutes: 0, latestDay: 1 }],
    ['day_1', { used: { explore: 0, walking: 0 }, users: {},
      sessions: {}, creations: emptyCreations() }]
  ])
  const badField = data => {
    if (!data || typeof data !== 'object') return false
    return Object.entries(data).some(([key, value]) =>
      key.length > 32 || (value && typeof value === 'object' && badField(value)))
  }
  let writes = 0
  const db = {
    async startTransaction() {
      const pending = new Map()
      return {
        collection(name) {
          expect(name).toBe(COLLECTION)
          return {
            doc(id) {
              return {
                async get() {
                  const data = pending.has(id) ? pending.get(id) : documents.get(id)
                  return { data: data ? { _id: id, ...JSON.parse(JSON.stringify(data)) } : null }
                },
                async set({ data }) {
                  if (Object.prototype.hasOwnProperty.call(data, '_id') || badField(data)) {
                    throw new Error('CloudBase rejects system ID or overlong object field')
                  }
                  pending.set(id, JSON.parse(JSON.stringify(data)))
                  writes++
                }
              }
            }
          }
        },
        async commit() {
          for (const [id, data] of pending) documents.set(id, data)
        },
        async rollback() { pending.clear() }
      }
    }
  }
  const quota = createQuota({ store: createQuotaStore(db), now: () => DAY + 60000,
    offsetMinutes: 0, activeFromMs: 0 })
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(3)
  const auth = await quota.begin(owner, 'cloudbase_session_123', 'input')
  expect(auth.sid).toHaveLength(48)
  const stored = documents.get('day_1')
  const nestedKeys = [Object.keys(stored.users), Object.keys(stored.sessions),
    Object.keys(stored.creations.users)].flat()
  expect(nestedKeys).toHaveLength(2)
  expect(nestedKeys.every(key => key.length === 32 && /^[us][a-f0-9]{31}$/.test(key))).toBe(true)
  expect(JSON.stringify(stored)).toContain(owner)
  expect(JSON.stringify(stored)).toContain(auth.sid)
  expect(stored.sessions[Object.keys(stored.sessions)[0]].sessionId).toBe(auth.sid)
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(2)
  await quota.close(auth)
  expect(documents.get('day_1').sessions).toEqual({})
  expect(writes).toBeGreaterThan(0)
})

test('fail closed on inconsistent persisted owner map identities', async () => {
  const record = { used: { explore: 0, walking: 0 }, users: {
    ['u' + 'a'.repeat(31)]: { ownerHash: 'b'.repeat(64), explore: 0, walking: 0 }
  }, sessions: {}, creations: { requests: { explore: 0, walking: 0 },
    attempts: { explore: 0, walking: 0 }, users: {} } }
  const tx = {
    collection: () => ({ doc: () => ({ get: async () => ({ data: { _id: 'day_1', ...record } }) }) }),
    rollback: jest.fn(), commit: jest.fn()
  }
  const store = createQuotaStore({ startTransaction: async () => tx })
  await expect(transact(store, t => t.get('day_1')))
    .rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(tx.commit).not.toHaveBeenCalled()
})
