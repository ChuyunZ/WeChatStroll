const { createQuota, DAY, emptyCreations } = require('./quota')
const { createTestStore } = require('./test-store')

const owner = 'a'.repeat(64)
const other = 'b'.repeat(64)
const initial = () => ({
  used: { explore: 0, walking: 0 }, users: {}, sessions: {}, creations: emptyCreations()
})
function harness({ time = DAY + 61000, marker = 0, activeFromMs = 0, offsetMinutes = 0 } = {}) {
  const store = createTestStore()
  let clock = time
  store.documents.set('calendar', { activeFromMs, offsetMinutes, latestDay: marker })
  const quota = createQuota({ store, activeFromMs, offsetMinutes, now: () => clock })
  return { store, quota, setTime: value => { clock = value } }
}
test('status previews a fresh later day without creating or modifying any records', async () => {
  const { store, quota } = harness()
  const original = JSON.stringify([...store.documents])
  expect(await quota.status(owner)).toEqual({
    remainingPlanningSessions: 3, resetAtMs: 2 * DAY
  })
  expect(JSON.stringify([...store.documents])).toBe(original)
})
test('status counts active holds, physical attempts and creation limits conservatively', async () => {
  const { store, quota } = harness()
  store.documents.set('day_1', initial())
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(3)
  const auth = await quota.begin(owner, 'status_test_request_1', 'input')
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(2)
  expect((await quota.status(other)).remainingPlanningSessions).toBe(3)
  for (let i = 0; i < 3; i++) await quota.debit(auth, 'explore')
  await quota.ready(auth, 'scope')
  auth.scopeHash = 'scope'
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(2)
  await quota.debit(auth, 'walking')
  const original = JSON.stringify([...store.documents])
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(2)
  expect(JSON.stringify([...store.documents])).toBe(original)
  await quota.close(auth)
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(2)
})
test('another user globally consuming base holds lowers the shared remaining figure', async () => {
  const { store, quota } = harness()
  store.documents.set('day_1', initial())
  const data = store.documents.get('day_1')
  data.used = { explore: 177, walking: 5310 }
  data.users[other] = { explore: 9, walking: 270 } // Real accounting must be valid for every owner.
  // Spare total of one full session, with no user-specific hold for this owner.
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(1)
})
test('status fails closed for mismatched, lost or previously initialized ledgers', async () => {
  const { store, quota } = harness({ marker: 1 })
  await expect(quota.status(owner)).rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
  store.documents.set('day_1', initial())
  const calendar = store.documents.get('calendar')
  calendar.offsetMinutes = -60
  await expect(quota.status(owner)).rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
  calendar.offsetMinutes = 0
  store.documents.get('day_1').creations.requests.walking = 1
  await expect(quota.status(owner)).rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  await expect(quota.status('raw-openid')).rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
})
test('status refuses a new session during the last 60 seconds of an internal quota day', async () => {
  const { store, quota, setTime } = harness({ time: 2 * DAY - 30000, marker: 1 })
  store.documents.set('day_1', initial())
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(0)
  setTime(2 * DAY)
  expect((await quota.status(owner)).remainingPlanningSessions).toBe(3)
  expect(store.documents.get('calendar').latestDay).toBe(1)
  expect(store.documents.has('day_2')).toBe(false)
})
