const { createTestStore } = require('./test-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { loadLimits } = require('./config')

const success = { data: { status: '1' } }
const limited = infocode => ({ data: { status: '0', infocode } })
const scopes = [{ id: 'amap:key', minIntervalMs: 0 }, { id: 'amap:walking', minIntervalMs: 100 }]

function client(store, request = jest.fn(async () => success), overrides = {}) {
  const limits = loadLimits({})
  limits.walkingRoute = { ...limits.walkingRoute, minIntervalMs: 100,
    maxQueueWaitMs: 5000, cooldownBaseMs: 300, ...overrides.walkingRoute }
  limits.nearbyPois = { ...limits.nearbyPois, minIntervalMs: 200,
    maxQueueWaitMs: 5000, cooldownBaseMs: 300, ...overrides.nearbyPois }
  Object.assign(limits, { clockGuardMs: 0, transactionJitterMs: 10 }, overrides.common)
  const log = jest.fn()
  const limiter = createLimiter({ store, ...limits, random: () => 0.5, log })
  return { limiter, log, request, provider: createProvider({ limiter, limits, request, log }) }
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100000) })
afterEach(() => jest.useRealTimers())

test('three users, twelve independent instances share one aggregate service rate and initialize missing rows', async () => {
  const store = createTestStore()
  const starts = []
  const clients = Array.from({ length: 12 }, (_, index) => client(store, async () => {
    starts.push({ user: index % 3, time: Date.now() })
    return success
  }))
  const pending = Promise.all(clients.map(instance => instance.provider('walkingRoute')('unused', {})))
  await jest.runAllTimersAsync()
  expect(await pending).toHaveLength(12)
  expect(starts.map(item => item.time)).toEqual(Array.from({ length: 12 }, (_, i) => 100000 + i * 100))
  expect(new Set(starts.map(item => item.user)).size).toBe(3)
  expect(store.conflicts).toBeGreaterThan(0)
  expect([...store.documents.keys()].sort()).toEqual(['amap:key', 'amap:walking'])
  expect(JSON.stringify([...store.documents])).not.toMatch(/coordinates|key=|url|payload/)
})

test('walking and POI have independent pacing; unpaced key imposes no start delay', async () => {
  const store = createTestStore()
  const starts = { walkingRoute: [], nearbyPois: [] }
  const pending = Promise.all(Object.keys(starts).flatMap(operation => Array.from({ length: 3 }, () =>
    client(store, async () => { starts[operation].push(Date.now()); return success })
      .provider(operation)('unused', {}))))
  await jest.runAllTimersAsync()
  await pending
  expect(starts.walkingRoute).toEqual([100000, 100100, 100200])
  expect(starts.nearbyPois[0]).toBeLessThan(100100)
  expect(starts.nearbyPois[1] - starts.nearbyPois[0]).toBe(200)
  expect(starts.nearbyPois[2] - starts.nearbyPois[1]).toBe(200)
})

test.each(['10019', '10020', '10021', '10022', '10023', 10021])(
  '%s publishes the intended shared scope before exhausting the provider budget', async infocode => {
    const store = createTestStore()
    const instance = client(store, jest.fn(async () => limited(infocode)), { walkingRoute: { maxProviderAttempts: 1 } })
    await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
    const id = String(infocode) === '10023' ? 'amap:key' : 'amap:walking'
    expect(store.documents.get(id).cooldownUntilMs).toBe(100300)
    expect(instance.request).toHaveBeenCalledTimes(1)
    const walk = client(store)
    const poi = client(store)
    const walkPending = walk.provider('walkingRoute')('unused', {})
    const poiPending = poi.provider('nearbyPois')('unused', {})
    await jest.advanceTimersByTimeAsync(299)
    expect(walk.request).not.toHaveBeenCalled()
    expect(poi.request).toHaveBeenCalledTimes(id === 'amap:key' ? 0 : 1)
    await jest.runAllTimersAsync()
    await Promise.all([walkPending, poiPending])
    expect(walk.request).toHaveBeenCalledTimes(1)
    expect(poi.request).toHaveBeenCalledTimes(1)
  })

test('waiting callers recheck a newly published cooldown instead of using old future reservations', async () => {
  const store = createTestStore()
  await client(store).limiter.execute(scopes, Date.now() + 5000, 'walkingRoute', async () => success)
  const waiting = client(store)
  const pending = waiting.provider('walkingRoute')('unused', {})
  await jest.advanceTimersByTimeAsync(50)
  await client(store).limiter.cooldown('amap:walking', 500, 'walkingRoute')
  await jest.advanceTimersByTimeAsync(499)
  expect(waiting.request).not.toHaveBeenCalled()
  await jest.runAllTimersAsync()
  await pending
  expect(waiting.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'provider_start', startedAtMs: 100550 }))
})

test('cooldowns never shorten and survive a new coordinator instance', async () => {
  const store = createTestStore()
  await client(store).limiter.cooldown('amap:key', 900, 'walkingRoute')
  await client(store).limiter.cooldown('amap:key', 100, 'nearbyPois')
  expect(store.documents.get('amap:key').cooldownUntilMs).toBe(100900)
})

test('backend retry reacquires; a competitor during cooldown gets no bypass', async () => {
  const store = createTestStore()
  const request = jest.fn().mockResolvedValueOnce(limited('10021')).mockResolvedValue(success)
  const instance = client(store, request)
  const competitor = client(store)
  const pending = instance.provider('walkingRoute')('unused', {})
  await jest.advanceTimersByTimeAsync(0)
  const concurrent = competitor.provider('walkingRoute')('unused', {})
  await jest.advanceTimersByTimeAsync(299)
  expect(request).toHaveBeenCalledTimes(1)
  expect(competitor.request).not.toHaveBeenCalled()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(success)
  await concurrent
  const starts = [...instance.log.mock.calls, ...competitor.log.mock.calls]
    .map(([record]) => record).filter(record => record.event === 'provider_start')
    .map(record => record.startedAtMs).sort((a, b) => a - b)
  expect(starts).toEqual([100000, 100300, 100400])
  expect(request).toHaveBeenCalledTimes(2)
})

test('retry exhaustion publishes final cooldown and terminates', async () => {
  const store = createTestStore()
  const instance = client(store, jest.fn(async () => limited('10021')))
  const assertion = expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  await jest.runAllTimersAsync()
  await assertion
  expect(instance.request).toHaveBeenCalledTimes(2)
  expect(store.documents.get('amap:walking').cooldownUntilMs).toBe(100900)
})

test('queue deadline stops before HTTP and does not reserve a future slot', async () => {
  const store = createTestStore()
  await client(store).limiter.cooldown('amap:key', 6000, 'walkingRoute')
  const before = JSON.stringify([...store.documents])
  const instance = client(store)
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  expect(instance.request).not.toHaveBeenCalled()
  expect(JSON.stringify([...store.documents])).toBe(before)
  expect(instance.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'queue_deadline_exceeded' }))
})

test('retry shares original deadline instead of resetting its queue budget', async () => {
  const instance = client(createTestStore(), jest.fn(async () => limited('10021')), {
    walkingRoute: { maxQueueWaitMs: 200 }
  })
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  expect(instance.request).toHaveBeenCalledTimes(1)
})

test.each(['provider', 'network'])('normal %s failure does not publish cooldown or retry', async type => {
  const store = createTestStore()
  const error = new Error('secret network URL')
  const request = jest.fn(async () => {
    if (type === 'network') throw error
    return limited('10001')
  })
  const instance = client(store, request)
  const pending = instance.provider('walkingRoute')('unused', {})
  if (type === 'network') await expect(pending).rejects.toBe(error)
  else expect(await pending).toEqual(limited('10001'))
  expect(request).toHaveBeenCalledTimes(1)
  expect([...store.documents.values()].every(state => state.cooldownUntilMs === 0)).toBe(true)
  expect(JSON.stringify(instance.log.mock.calls)).not.toContain('secret')
})

test('transaction conflicts have a separate bounded budget and no HTTP on exhaustion', async () => {
  const store = createTestStore()
  store.forcedConflicts = 100
  const instance = client(store)
  const assertion = expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  await jest.runAllTimersAsync()
  await assertion
  expect(store.transactions).toBe(6)
  expect(instance.request).not.toHaveBeenCalled()
  expect(store.documents.size).toBe(0)
  expect(instance.log.mock.calls.filter(([record]) => record.event === 'transaction_conflict')).toHaveLength(6)
})

test('a transient conflict retries without consuming provider attempts', async () => {
  const store = createTestStore()
  store.forcedConflicts = 2
  const instance = client(store, undefined, { walkingRoute: { maxProviderAttempts: 1 } })
  const pending = instance.provider('walkingRoute')('unused', {})
  await jest.runAllTimersAsync()
  expect(await pending).toBe(success)
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(store.transactions).toBe(5)
})

test('database failure fails closed with sanitized recoverable error', async () => {
  const store = createTestStore()
  store.failure = new Error('secret DB internals')
  const instance = client(store)
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({
    code: 'AMAP_RATE_LIMITED', message: 'Provider is temporarily busy'
  })
  expect(instance.request).not.toHaveBeenCalled()
  expect(store.transactions).toBe(1)
  expect(JSON.stringify(instance.log.mock.calls)).not.toContain('secret')
})

test('failed cooldown publication never allows another HTTP attempt', async () => {
  const store = createTestStore()
  const instance = client(store, jest.fn(async () => {
    store.failure = new Error('secret')
    return limited('10021')
  }))
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(instance.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'cooldown_failed' }))
})

test('HTTP rejection carrying a QPS code publishes cooldown without leaking credentials or payloads', async () => {
  const instance = client(createTestStore(), jest.fn().mockRejectedValue({
    message: 'secret URL', config: { key: 'secret-key', origin: '121.456,31.123' },
    response: { status: 429, data: { infocode: '10023', payload: 'secret-payload' } }
  }))
  const assertion = expect(instance.provider('walkingRoute')('secret-url', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  await jest.runAllTimersAsync()
  await assertion
  expect(JSON.stringify(instance.log.mock.calls)).not.toMatch(/secret|121.456|31.123/)
  expect(instance.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'rate_limited', infocode: '10023', scope: 'amap:key' }))
})

test('optional key pacing applies across both services', async () => {
  const store = createTestStore()
  const starts = []
  const pending = Promise.all(['walkingRoute', 'nearbyPois'].map(operation =>
    client(store, async () => { starts.push(Date.now()); return success }, {
      common: { keyMinIntervalMs: 400 }
    }).provider(operation)('unused', {})))
  await jest.runAllTimersAsync()
  await pending
  expect(starts).toEqual([100000, 100400])
})

test('configuration is explicit, adjustable and rejects unsafe values', () => {
  expect(loadLimits({}).walkingRoute.minIntervalMs).toBe(1500)
  expect(loadLimits({ AMAP_WALKING_MIN_INTERVAL_MS: '2500' }).walkingRoute.minIntervalMs).toBe(2500)
  for (const value of ['0', '-1', 'NaN', 'Infinity', '', '1.5']) {
    expect(() => loadLimits({ AMAP_WALKING_MIN_INTERVAL_MS: value })).toThrow()
  }
})

test('clock guard tolerates a small difference between independent backend clocks', async () => {
  const store = createTestStore()
  const first = createLimiter({ store, now: () => Date.now() - 25, clockGuardMs: 100 })
  const second = createLimiter({ store, now: () => Date.now() + 25, clockGuardMs: 100 })
  await first.execute(scopes, Date.now() + 5000, 'walkingRoute', async () => success)
  const startedAt = Date.now()
  const pending = second.execute(scopes, Date.now() + 5000, 'walkingRoute', async () => success)
  await jest.runAllTimersAsync()
  await pending
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
})

test('corrupt shared state fails closed rather than silently disabling coordination', async () => {
  const store = createTestStore()
  store.documents.set('amap:key', { nextAllowedAtMs: 'wrong', cooldownUntilMs: 0 })
  const instance = client(store)
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  expect(instance.request).not.toHaveBeenCalled()
})

test('concurrent cooldown publishers keep the longest value after conflict retry', async () => {
  const store = createTestStore()
  const pending = Promise.all([900, 300, 600].map(duration =>
    client(store).limiter.cooldown('amap:key', duration, 'walkingRoute')))
  await jest.runAllTimersAsync()
  await pending
  expect(store.documents.get('amap:key').cooldownUntilMs).toBe(100900)
  expect(store.conflicts).toBeGreaterThan(0)
})

test('queue sleeps and conflict backoff happen only after the transaction closes', async () => {
  const backing = createTestStore()
  backing.forcedConflicts = 1
  let open = false
  const store = { async transaction(work) {
    open = true
    try { return await backing.transaction(work) } finally { open = false }
  } }
  const sleep = jest.fn(async ms => {
    expect(open).toBe(false)
    jest.setSystemTime(Date.now() + ms)
  })
  const limiter = createLimiter({ store, sleep, random: () => 0, clockGuardMs: 0 })
  await limiter.execute(scopes, Date.now() + 5000, 'walkingRoute', async () => success)
  await limiter.execute(scopes, Date.now() + 5000, 'walkingRoute', async () => success)
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1, 100])
})

test('transaction backoff cannot overrun the queue deadline', async () => {
  const store = createTestStore()
  store.forcedConflicts = 100
  const instance = client(store, undefined, { walkingRoute: { maxQueueWaitMs: 1 } })
  await expect(instance.provider('walkingRoute')('unused', {})).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
  expect(store.transactions).toBe(1)
  expect(instance.request).not.toHaveBeenCalled()
})

test('the transport timeout is owned by centralized provider configuration', async () => {
  const instance = client(createTestStore(), undefined, { common: { requestTimeoutMs: 1234 } })
  await instance.provider('walkingRoute')('unused', { timeout: 999999, params: {} })
  expect(instance.request).toHaveBeenCalledWith('unused', { timeout: 1234, params: {} })
})
