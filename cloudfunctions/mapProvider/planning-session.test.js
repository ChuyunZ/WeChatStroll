const { createPlanningSecurity } = require('./planning-session')
const { createQuota, DAY, emptyCreations } = require('./quota')
const { createTokens, ownerOf, hash } = require('./planning-token')
const { createTestStore } = require('./test-store')
const env = { MAP_PLANNING_SECRET: 'synthetic-secret-with-at-least-32-bytes',
  MAP_QUOTA_OFFSET_MINUTES: '0', MAP_QUOTA_ACTIVE_FROM_MS: '0' }
const context = { OPENID: 'private-user', APPID: 'app' }
const owner = ownerOf(context)
const origin = { latitude: 31.23, longitude: 121.47 }
const poi = { latitude: 31.231, longitude: 121.471 }
const result = { success: true, poisByCategory: { park: [{ ...poi, poiId: 'private-poi', name: 'private-title' }] } }
const rid = n => `request_identifier_${n}`
let store, clock, security, quota
beforeEach(() => {
  store = createTestStore()
  store.documents.set('calendar', { activeFromMs: 0, offsetMinutes: 0, latestDay: 0 })
  clock = DAY + 60000
  security = createPlanningSecurity({ store, env, now: () => clock })
  quota = createQuota({ store, offsetMinutes: 0, activeFromMs: 0, now: () => clock })
})
async function discovery(n = 1, ctx = context) {
  const event = { ...origin, requestId: rid(n) }
  const opened = await security.open(event, ctx)
  for (let i = 0; i < 3; i++) await opened.admission.prepare()
  return { opened, response: await security.complete(opened.auth, event, result) }
}
const walking = (response, id = rid('walking')) => ({ requestId: id, planningToken: response.planningToken,
  start: origin, destination: poi })

test('no identity or forged event identity cannot authorize discovery; missing configuration fails closed', async () => {
  await expect(security.open({ ...origin, requestId: rid(1), OPENID: 'forged', ownerKey: owner }, {}))
    .rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
  expect([...store.documents.keys()]).toEqual(['calendar'])
  expect(() => createPlanningSecurity({ store, env: {} })).toThrow()
})
test('binds origin/POI scope, identity, session and expiry without storing provider data', async () => {
  const { response } = await discovery()
  await expect(security.walking(walking(response), { ...context, OPENID: 'other' })).rejects.toMatchObject({ code: 'MAP_SESSION_INVALID' })
  await expect(security.walking({ ...walking(response), destination: { latitude: 1, longitude: 2 } }, context))
    .rejects.toMatchObject({ code: 'MAP_SESSION_INVALID' })
  await expect(security.walking({ ...walking(response), planningToken: response.planningToken + 'x' }, context)).rejects.toThrow()
  const admitted = await security.walking(walking(response), context)
  await admitted.admission.prepare()
  expect(JSON.stringify([...store.documents])).not.toMatch(/private-user|private-poi|private-title|31\.23|121\.47|polyline|synthetic-secret/)
  clock += 2 * 60 * 60 * 1000
  await expect(security.walking(walking(response, rid(3)), context)).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
})
test('Walking without Explore fails; valid signature alone is insufficient without a stored session', async () => {
  await expect(security.walking({ start: origin, destination: poi }, context)).rejects.toThrow()
  const token = createTokens(env.MAP_PLANNING_SECRET).sign({ kind: 'planning', owner, sid: 'missing', day: 1,
    expires: clock + 60000, origin: '31.230000,121.470000', points: ['31.230000,121.470000', '31.231000,121.471000'] })
  await expect(security.walking(walking({ planningToken: token }), context)).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
})
test('lost discovery/walking responses and parameter replay never reexecute, including new instances', async () => {
  const { response } = await discovery()
  await expect(security.open({ ...origin, requestId: rid(1) }, context)).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
  await security.walking(walking(response), context)
  const other = createPlanningSecurity({ store, env, now: () => clock })
  await expect(other.walking(walking(response), context)).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
  await expect(other.walking({ ...walking(response), start: poi, destination: origin }, context)).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
})
test('coupled reservation rejects Explore before use if Walking capacity is unavailable', async () => {
  store.documents.set('day_1', { used: { explore: 0, walking: 5311 }, users: {}, sessions: {}, creations: emptyCreations() })
  await expect(security.open({ ...origin, requestId: rid(1) }, context)).rejects.toMatchObject({ code: 'MAP_GLOBAL_QUOTA_EXHAUSTED' })
  expect(store.documents.get('day_1').used.explore).toBe(0)
})
test('90 is a base hold, 94 and 188 physical attempts are supported; user hard limit still holds', async () => {
  const { response } = await discovery()
  const admitted = await security.walking(walking(response), context)
  for (let i = 0; i < 270; i++) await admitted.admission.prepare()
  expect(store.documents.get('day_1').used).toEqual({ explore: 3, walking: 270 })
  await expect(admitted.admission.prepare()).rejects.toMatchObject({ code: 'MAP_USER_QUOTA_EXHAUSTED' })
  await expect(security.open({ ...origin, requestId: rid(2) }, context)).rejects.toMatchObject({ code: 'MAP_USER_QUOTA_EXHAUSTED' })
})
test('reservations protect active users; competing users cannot seize the final base hold', async () => {
  store.documents.set('day_1', { used: { explore: 0, walking: 5310 }, users: {}, sessions: {}, creations: emptyCreations() })
  const results = await Promise.allSettled([1, 2, 3].map(n => security.open({ ...origin, requestId: rid(n) }, { ...context, OPENID: `user-${n}` })))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'MAP_GLOBAL_QUOTA_EXHAUSTED')).toBe(true)
  const a = results.find(r => r.status === 'fulfilled').value.auth
  await quota.ready(a, 'scope')
  a.scopeHash = 'scope'
  for (let i = 0; i < 90; i++) await quota.debit(a, 'walking')
  await expect(quota.debit(a, 'walking')).rejects.toMatchObject({ code: 'MAP_GLOBAL_QUOTA_EXHAUSTED' })
})
test('close and expiry release only unused holds; duplicate close cannot refund consumed calls', async () => {
  const { opened, response } = await discovery()
  const admission = (await security.walking(walking(response), context)).admission
  const permit = await admission.prepare()
  await quota.close(opened.auth)
  await quota.close(opened.auth)
  expect(store.documents.get('day_1').used.walking).toBe(1)
  // Proven never-sent permit can be refunded once, even after close.
  await admission.cancel(permit)
  await admission.cancel(permit)
  expect(store.documents.get('day_1').used.walking).toBe(0)
  await discovery(2)
  clock += 2 * 60 * 60 * 1000
  await quota.sweep()
  expect(store.documents.get('day_1').sessions).toEqual({})
  expect(store.documents.get('day_1').used.explore).toBe(6)
})
test('cross-day requests cannot spend old reservations; next day initializes independently', async () => {
  const { response } = await discovery()
  const admitted = await security.walking(walking(response), context)
  clock = 2 * DAY + 60000
  await expect(admitted.admission.prepare()).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  await discovery(2)
  expect(store.documents.get('day_2').used.explore).toBe(3)
})
test('activation day requires reconciled seed and explicit timezone; day-boundary admission is closed', async () => {
  clock = 60000
  await expect(discovery()).rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
  clock = 2 * DAY - 30000
  await expect(discovery()).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  expect(() => createQuota({ store, activeFromMs: 0 })).toThrow()
})
test('known transaction conflicts retry; uncertain commits never grant HTTP permission', async () => {
  store.forcedConflicts = 2
  const { response } = await discovery()
  const admitted = await security.walking(walking(response), context)
  store.afterCommit = () => { throw new Error('lost acknowledgement') }
  await expect(admitted.admission.prepare()).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(store.documents.get('day_1').used.walking).toBe(1)
  store.afterCommit = null
  await expect(security.walking(walking(response), context)).rejects.toMatchObject({ code: 'MAP_EXECUTION_UNKNOWN' })
  store.failure = new Error('offline')
  await expect(admitted.admission.prepare()).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
})
test('delegation validates signed payload, owner and expiry without trusting forwarded identity fields', async () => {
  const event = { action: 'nearbyPois', ...origin, requestId: rid(1) }
  const tokens = createTokens(env.MAP_PLANNING_SECRET)
  const signed = { ...event, _mapDelegation: tokens.sign({ kind: 'forward', owner,
    inputHash: hash(JSON.stringify(event)), expires: clock + 65000 }) }
  await expect(security.open({ ...signed, latitude: 12 }, {})).rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
  await expect(security.open(signed, { ...context, OPENID: 'wrong' })).rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
  expect((await security.open({ ...signed, userInfo: { openId: 'injected' }, OPENID: 'forged' }, {})).auth.owner).toBe(owner)
  clock += 65001
  await expect(security.open(signed, {})).rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
})

test('concurrent duplicate Walking claims have exactly one winner', async () => {
  const { response } = await discovery()
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => security.walking(walking(response), context)))
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(o => o.status === 'rejected').every(o => o.reason.code === 'MAP_EXECUTION_UNKNOWN')).toBe(true)
})
test('60 base reservations consume the full 5400 capacity; no unvalidated 540 buffer is withheld', async () => {
  const admissions = []
  for (let i = 0; i < 60; i++) admissions.push(await security.open({ ...origin, requestId: rid(i) }, { ...context, OPENID: `capacity-${i}` }))
  expect(Object.values(store.documents.get('day_1').sessions).reduce((sum, s) => sum + s.remaining.walking, 0)).toBe(5400)
  await expect(security.open({ ...origin, requestId: rid(61) }, { ...context, OPENID: 'capacity-61' }))
    .rejects.toMatchObject({ code: 'MAP_GLOBAL_QUOTA_EXHAUSTED' })
  const a = admissions[0].auth
  await quota.ready(a, 'scope')
  a.scopeHash = 'scope'
  for (let i = 0; i < 90; i++) await quota.debit(a, 'walking')
  await expect(quota.debit(a, 'walking')).rejects.toMatchObject({ code: 'MAP_GLOBAL_QUOTA_EXHAUSTED' })
  await quota.close(admissions[1].auth)
  for (let i = 0; i < 4; i++) await quota.debit(a, 'walking')
  expect(store.documents.get('day_1').used.walking).toBe(94)
})
test('Explore retries consume the user daily cap and never overwrite another session hold', async () => {
  const opened = await security.open({ ...origin, requestId: rid(1) }, context)
  for (let i = 0; i < 6; i++) await opened.admission.prepare()
  const next = await security.open({ ...origin, requestId: rid(2) }, context)
  await expect(opened.admission.prepare()).rejects.toMatchObject({ code: 'MAP_USER_QUOTA_EXHAUSTED' })
  for (let i = 0; i < 3; i++) await next.admission.prepare()
  expect(store.documents.get('day_1').used.explore).toBe(9)
})
test('refund racing close cannot resurrect a reservation or double refund', async () => {
  const { opened, response } = await discovery()
  const admission = (await security.walking(walking(response), context)).admission
  const permit = await admission.prepare()
  await Promise.all([admission.cancel(permit), quota.close(opened.auth), admission.cancel(permit)])
  expect(store.documents.get('day_1').sessions).toEqual({})
  expect(store.documents.get('day_1').used).toEqual({ explore: 3, walking: 0 })
})

test('a missing previously initialized ledger or calendar never silently resets usage', async () => {
  await discovery()
  store.documents.delete('day_1')
  await expect(discovery(2)).rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
  store.documents.delete('calendar')
  clock += DAY
  await expect(discovery(3)).rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
})

test('1000 repeated signed closes perform no ledger writes or new records after the first release', async () => {
  const { opened, response } = await discovery()
  const admitted = await security.walking(walking(response), context)
  await admitted.admission.prepare()
  const commits = []
  store.afterCommit = ({ writes }) => commits.push([...writes.keys()])
  const close = () => security.close({ planningToken: response.planningToken }, context)
  await expect(close()).resolves.toEqual({ success: true })
  expect(commits).toEqual([['day_1']])
  expect(store.documents.get('day_1').sessions[opened.auth.sid]).toBeUndefined()
  const before = JSON.stringify([...store.documents])
  commits.length = 0
  for (let i = 0; i < 1000; i++) await expect(close()).resolves.toEqual({ success: true })
  expect(commits).toHaveLength(1000) // Reads/transactions still occur; no ingress DoS claim.
  expect(commits.every(ids => ids.length === 0)).toBe(true)
  expect(JSON.stringify([...store.documents])).toBe(before)
  expect(store.documents.get('day_1').used).toEqual({ explore: 3, walking: 1 })
  await expect(admitted.admission.prepare()).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
})

test('concurrent closes and a lost first acknowledgement release once without rewriting the ledger', async () => {
  const { response } = await discovery()
  let writes = 0
  store.afterCommit = ({ writes: changes }) => {
    if (changes.has('day_1')) { writes++; throw new Error('lost close acknowledgement') }
  }
  const close = () => security.close({ planningToken: response.planningToken }, context)
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, close))
  expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1)
  expect(outcomes.find(r => r.status === 'rejected').reason.code).toBe('MAP_QUOTA_UNAVAILABLE')
  expect(writes).toBe(1)
  await expect(close()).resolves.toEqual({ success: true })
  expect(writes).toBe(1)
  expect(store.documents.get('day_1').sessions).toEqual({})
  expect(store.documents.get('day_1').used.explore).toBe(3)
})

test('no-op close still persists genuine expiry pruning once and never changes the next-day ledger', async () => {
  const { opened } = await discovery()
  await quota.close(opened.auth)
  const other = await discovery(2)
  clock = other.opened.auth.expires
  const commits = []
  store.afterCommit = ({ writes }) => commits.push([...writes.keys()])
  await quota.close(opened.auth)
  expect(commits).toEqual([['day_1']])
  expect(store.documents.get('day_1').sessions).toEqual({})
  await quota.close(opened.auth)
  await quota.sweep()
  expect(commits.slice(1)).toEqual([[], []])
  clock = DAY * 2 + 60000
  await discovery(3)
  const before = JSON.stringify([...store.documents])
  commits.length = 0
  await quota.close(opened.auth) // Internal late cleanup; public expired tokens are rejected.
  expect(commits).toEqual([[]])
  expect(JSON.stringify([...store.documents])).toBe(before)
  expect(store.documents.get('calendar').latestDay).toBe(2)
})
