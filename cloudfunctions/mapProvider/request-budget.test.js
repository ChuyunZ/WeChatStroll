const { createQuota, DAY, CREATION_LIMITS } = require('./quota')
const { createTestStore } = require('./test-store')
const owner = 'a'.repeat(64)
let store, quota, clock, sequence
const id = () => `budget_request_${++sequence}`
const ledger = () => store.documents.get('day_1')
async function open(who = owner) {
  const auth = await quota.begin(who, id(), 'input')
  await quota.ready(auth, 'scope')
  return { ...auth, scopeHash: 'scope' }
}
beforeEach(() => {
  sequence = 0
  clock = DAY + 60000
  store = createTestStore()
  store.documents.set('calendar', { activeFromMs: 0, offsetMinutes: 0, latestDay: 0 })
  quota = createQuota({ store, offsetMinutes: 0, activeFromMs: 0, now: () => clock })
})

test.each([10, 100, 1000])('exhausted HTTP quota: %i unique AND repeated denied claims create no records or ledger writes', async count => {
  const auth = await open()
  for (let i = 0; i < 270; i++) {
    await quota.claim(auth, id(), 'edge')
    await quota.debit(auth, 'walking')
  }
  const before = JSON.stringify([...store.documents])
  const commit = jest.fn()
  store.beforeCommit = commit
  const repeated = id()
  for (let i = 0; i < count; i++) for (const request of [id(), repeated]) {
    await expect(quota.claim(auth, request, 'edge')).rejects.toMatchObject({ code: 'MAP_USER_QUOTA_EXHAUSTED' })
  }
  expect(JSON.stringify([...store.documents])).toBe(before)
  expect(commit).not.toHaveBeenCalled()
})

test('claims with no HTTP are bounded across sessions, close and random IDs; duplicate accepted requests stay unknown', async () => {
  const a = await open()
  const b = await open()
  const first = id()
  await quota.claim(a, first, 'edge')
  for (let i = 1; i < CREATION_LIMITS.user.walking; i++) await quota.claim(i % 2 ? a : b, id(), 'edge')
  await quota.close(a)
  await expect(open()).rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  const count = store.documents.size
  for (let i = 0; i < 1000; i++) await expect(quota.claim(b, id(), 'edge')).rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  await expect(quota.claim(b, first, 'edge')).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
  expect(store.documents.size).toBe(count)
  expect(ledger().used.walking).toBe(0)
  expect(ledger().creations.requests.walking).toBe(540)
})

test('refunds restore only never-sent HTTP capacity, not attempt creation budget', async () => {
  const auth = await open()
  for (let i = 0; i < CREATION_LIMITS.user.walking; i++) {
    const permit = await quota.debit(auth, 'walking')
    await quota.refund(auth, permit)
    await quota.refund(auth, permit)
  }
  expect(ledger().used.walking).toBe(0)
  expect(ledger().creations.attempts.walking).toBe(540)
  const before = JSON.stringify([...store.documents])
  for (let i = 0; i < 100; i++) await expect(quota.debit(auth, 'walking')).rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  await expect(quota.claim(auth, id(), 'edge')).rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  expect(JSON.stringify([...store.documents])).toBe(before)
})

test('unused discovery close/reopen cannot reset request budget', async () => {
  for (let i = 0; i < CREATION_LIMITS.user.explore; i++) await quota.close(await open())
  const before = store.documents.size
  await expect(open()).rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  expect(store.documents.size).toBe(before)
  expect(ledger().used).toEqual({ explore: 0, walking: 0 })
})

test.each(['requests', 'attempts'])('independent instances contend for the final %s creation slot atomically', async kind => {
  const auth = await open()
  // Reconciled near-limit counters: avoid thousands of irrelevant setup transactions.
  ledger().creations[kind].walking = 539
  ledger().creations.users[owner][kind].walking = 539
  const outcomes = await Promise.allSettled(Array.from({ length: 24 }, () => {
    const instance = createQuota({ store, offsetMinutes: 0, activeFromMs: 0, now: () => clock })
    return kind === 'requests' ? instance.claim(auth, id(), 'edge') : instance.debit(auth, 'walking')
  }))
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(r => r.status === 'rejected').every(r => r.reason.code === 'MAP_REQUEST_LIMITED')).toBe(true)
  expect(ledger().creations[kind].walking).toBe(540)
  expect(store.conflicts).toBeGreaterThan(0)
})

test.each(['requests', 'attempts'])('global %s cap spans owners and cannot be bypassed by a fresh user', async kind => {
  const auth = await open()
  const c = ledger().creations
  for (let i = 1; i <= 20; i++) c.users[i.toString(16).padStart(64, '0')] = {
    requests: { explore: 0, walking: kind === 'requests' ? 540 : 0 },
    attempts: { explore: 0, walking: kind === 'attempts' ? 540 : 0 }
  }
  c[kind].walking = 10800
  const before = JSON.stringify([...store.documents])
  await expect(kind === 'requests' ? quota.claim(auth, id(), 'edge') : quota.debit(auth, 'walking'))
    .rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  expect(JSON.stringify([...store.documents])).toBe(before)
})

test('lost claim acknowledgement consumes exactly one slot; replay never creates another', async () => {
  const auth = await open()
  const request = id()
  store.afterCommit = () => { throw new Error('ack lost') }
  await expect(quota.claim(auth, request, 'edge')).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  store.afterCommit = null
  await expect(quota.claim(auth, request, 'edge')).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
  expect(ledger().creations.requests.walking).toBe(1)
  expect(ledger().used.walking).toBe(0)
})

test('concurrent final physical debit has one winner, then global exhaustion rejects 1000 IDs without writes', async () => {
  const auth = await open()
  for (let i = 0; i < 269; i++) await quota.debit(auth, 'walking')
  const results = await Promise.allSettled(Array.from({ length: 24 }, () => quota.debit(auth, 'walking')))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'MAP_USER_QUOTA_EXHAUSTED')).toBe(true)
  expect(ledger().used.walking).toBe(270)
  const other = await open('b'.repeat(64))
  // Model the remainder used by other owners after this owner's base was spent.
  for (let i = 0; i < 90; i++) await quota.debit(other, 'walking')
  ledger().used.walking = 5400
  const before = JSON.stringify([...store.documents])
  store.beforeCommit = jest.fn()
  for (let i = 0; i < 1000; i++) await expect(quota.claim(other, id(), 'edge')).rejects.toMatchObject({ code: 'MAP_GLOBAL_QUOTA_EXHAUSTED' })
  expect(store.beforeCommit).not.toHaveBeenCalled()
  expect(JSON.stringify([...store.documents])).toBe(before)
})

test('expired session and missing creation counters fail closed; new day gets independent budgets', async () => {
  const auth = await open()
  clock += 3 * 60 * 60 * 1000
  const before = store.documents.size
  await expect(quota.claim(auth, id(), 'edge')).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  expect(store.documents.size).toBe(before)
  delete ledger().creations
  await expect(open()).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  clock = DAY * 2 + 60000
  await open()
  expect(store.documents.get('day_2').creations.requests.explore).toBe(1)
})
