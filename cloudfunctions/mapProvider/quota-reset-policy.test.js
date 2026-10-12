// Policy verification for the operator-chosen 09:00 Asia/Shanghai quota day.
// This is an internal accounting boundary, not a Tencent-confirmed reset time.
const { createQuota, DAY, emptyCreations } = require('./quota')
const { createTestStore } = require('./test-store')
const { buildSeed } = require('../../scripts/issue107-quota-seed.cjs')

const OFFSET_MINUTES = -60 // 09:00 CST = 01:00 UTC; dayOf=floor((now+offset)/DAY)
const utc = iso => Date.parse(iso)
const owner = 'a'.repeat(64)
const requestId = n => `quota_day_boundary_${n}`

test('offline seed starts the chosen 09:00 Beijing day at 01:00 UTC', () => {
  const seed = buildSeed({
    date: '2026-10-12', offsetMinutes: OFFSET_MINUTES,
    used: { explore: 0, walking: 0 }, users: {}, userUsageComplete: true
  })
  expect(seed.documentId).toBe('day_20738')
  expect(new Date(seed.activeFromMs).toISOString()).toBe('2026-10-12T01:00:00.000Z')
  expect(seed.calendar).toEqual({
    activeFromMs: seed.activeFromMs, offsetMinutes: OFFSET_MINUTES, latestDay: 20738
  })
})

test('Explore and Walking share 09:00 reset; old holds and credentials cannot cross it', async () => {
  const store = createTestStore()
  const previousDay = utc('2026-10-11T00:00:00.000Z') / DAY
  const activation = utc('2026-10-11T01:00:00.000Z')
  store.documents.set('calendar', { activeFromMs: activation, offsetMinutes: OFFSET_MINUTES, latestDay: previousDay })
  store.documents.set(`day_${previousDay}`, {
    used: { explore: 0, walking: 0 }, users: {}, sessions: {}, creations: emptyCreations()
  })
  let clock = utc('2026-10-12T00:58:00.000Z') // Beijing 08:58
  const quota = createQuota({ store, offsetMinutes: OFFSET_MINUTES,
    activeFromMs: activation, now: () => clock })

  const old = await quota.begin(owner, requestId('old'), 'input')
  await quota.debit(old, 'explore')
  await quota.ready(old, 'scope')
  old.scopeHash = 'scope'
  await quota.debit(old, 'walking')
  expect(store.documents.get(`day_${previousDay}`).used).toEqual({ explore: 1, walking: 1 })
  expect(old.expires).toBeLessThan(utc('2026-10-12T01:00:00.000Z'))

  clock = utc('2026-10-12T00:59:00.000Z') // Closing minute: new sessions forbidden
  await expect(quota.begin(owner, requestId('last_minute'), 'input'))
    .rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })

  clock = utc('2026-10-12T01:00:00.000Z') // Beijing 09:00
  await expect(quota.debit(old, 'walking'))
    .rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  const fresh = await quota.begin(owner, requestId('new'), 'input')
  const today = previousDay + 1
  expect(fresh.day).toBe(today)
  expect(store.documents.get(`day_${today}`).used).toEqual({ explore: 0, walking: 0 })
  await quota.debit(fresh, 'explore')
  await quota.ready(fresh, 'next-scope')
  fresh.scopeHash = 'next-scope'
  await quota.debit(fresh, 'walking')
  expect(store.documents.get(`day_${today}`).used).toEqual({ explore: 1, walking: 1 })
  expect(store.documents.get(`day_${previousDay}`).used).toEqual({ explore: 1, walking: 1 })
  expect(store.documents.get('calendar').latestDay).toBe(today)
})

test('an activated calendar cannot be silently switched to the chosen offset', async () => {
  const store = createTestStore()
  const activated = utc('2026-10-11T00:00:00.000Z')
  store.documents.set('calendar', {
    activeFromMs: activated, offsetMinutes: 0, latestDay: activated / DAY
  })
  const quota = createQuota({ store, offsetMinutes: OFFSET_MINUTES, activeFromMs: activated,
    now: () => utc('2026-10-12T01:00:00.000Z') })
  await expect(quota.begin(owner, requestId('mismatch'), 'input'))
    .rejects.toMatchObject({ code: 'MAP_QUOTA_NOT_READY' })
  expect([...store.documents.keys()]).toEqual(['calendar'])
})

test('Tencent 121 blocks all scopes on the shared Key until the next 09:00 boundary', async () => {
  const { createLimiter } = require('./limiter')
  const { createProvider } = require('./provider')
  const { loadLimits } = require('./config')
  jest.useFakeTimers()
  try {
    jest.setSystemTime(utc('2026-10-12T00:30:00.000Z')) // Beijing 08:30
    const limits = loadLimits({})
    const store = createTestStore()
    const limiter = createLimiter({ store, ...limits })
    const request = jest.fn().mockResolvedValueOnce({ data: { status: 121 } })
      .mockResolvedValue({ data: { status: 0 } })
    const provider = createProvider({ limiter, limits, request,
      quotaOffsetMinutes: OFFSET_MINUTES })

    const first = provider('walkingRoute')('mock', {}).catch(error => error)
    await jest.runAllTimersAsync()
    expect(await first).toMatchObject({ code: 'PROVIDER_QUOTA_EXHAUSTED' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(store.documents.get('tencent:key').cooldownUntilMs)
      .toBeGreaterThanOrEqual(utc('2026-10-12T01:00:00.000Z'))

    // Even another service cannot bypass a Key-wide daily quota block.
    const blocked = provider('nearbyPois')('mock', {}).catch(error => error)
    await jest.runAllTimersAsync()
    expect(await blocked).toMatchObject({ code: 'PROVIDER_BUSY' })
    expect(request).toHaveBeenCalledTimes(1)

    // A new local quota day permits a fresh probe; it is not a guarantee that
    // Tencent has reset. If Tencent returned 121 again we would re-block.
    jest.setSystemTime(utc('2026-10-12T01:00:00.200Z'))
    const recovered = provider('nearbyPois')('mock', {})
    await jest.runAllTimersAsync()
    await expect(recovered).resolves.toMatchObject({ data: { status: 0 } })
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

test('a second Tencent 121 after local reset renews the next-day shared block', async () => {
  const { createLimiter } = require('./limiter')
  const { createProvider } = require('./provider')
  const { loadLimits } = require('./config')
  jest.useFakeTimers()
  try {
    jest.setSystemTime(utc('2026-10-12T01:00:00.300Z')) // Just after 09:00 Beijing
    const limits = loadLimits({})
    const store = createTestStore()
    const limiter = createLimiter({ store, ...limits })
    const request = jest.fn(async () => ({ data: { status: 121 } }))
    const provider = createProvider({ limiter, limits, request,
      quotaOffsetMinutes: OFFSET_MINUTES })
    const result = provider('nearbyPois')('mock', {}).catch(error => error)
    await jest.runAllTimersAsync()
    expect(await result).toMatchObject({ code: 'PROVIDER_QUOTA_EXHAUSTED' })
    expect(store.documents.get('tencent:key').cooldownUntilMs)
      .toBeGreaterThan(utc('2026-10-13T01:00:00.000Z'))
    const blocked = provider('walkingRoute')('mock', {}).catch(error => error)
    await jest.runAllTimersAsync()
    expect(await blocked).toMatchObject({ code: 'PROVIDER_BUSY' })
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})
