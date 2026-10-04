const { createTestStore } = require('./test-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { loadLimits } = require('./config')
const ok = { data: { status: 0, data: [] } }

function client(store, request = jest.fn(async () => ok), service = {}) {
  const limits = { ...loadLimits({}), clockGuardMs: 0, transactionJitterMs: 10 }
  limits.nearbyPois = { ...limits.nearbyPois, minIntervalMs: 100, maxQueueWaitMs: 5000,
    cooldownBaseMs: 300, ...service }
  limits.walkingRoute = { ...limits.walkingRoute, cooldownBaseMs: 300, ...service }
  const log = jest.fn()
  const limiter = createLimiter({ store, ...limits, random: () => 0.5, log })
  const execute = jest.spyOn(limiter, 'execute')
  const cooldown = jest.spyOn(limiter, 'cooldown')
  const provider = createProvider({ limiter, limits, request, log })
  return { limiter, execute, cooldown, request, log, call: (operation = 'nearbyPois') => provider(operation)('private-url', { params: { key: 'secret' } }) }
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100000) })
afterEach(() => jest.useRealTimers())

test('independent instances share pacing and transaction conflicts without payload storage', async () => {
  const store = createTestStore()
  const starts = []
  const pending = Promise.all(Array.from({ length: 12 }, () => client(store, async () => {
    starts.push(Date.now()); return ok
  }).call()))
  await jest.runAllTimersAsync()
  expect(await pending).toHaveLength(12)
  expect(starts).toEqual(Array.from({ length: 12 }, (_, i) => 100000 + i * 100))
  expect(store.conflicts).toBeGreaterThan(0)
  expect([...store.documents.keys()].sort()).toEqual(['tencent:key', 'tencent:poi-explore'])
  expect(JSON.stringify([...store.documents])).not.toMatch(/private|secret|url|payload|latitude|user/)
})

test.each(['resolved', 'rejected'])('120 from %s HTTP publishes key cooldown and reacquires within one deadline', async mode => {
  const request = jest.fn(async () => {
    if (mode === 'rejected') throw { response: { data: { status: 120, message: 'secret' } } }
    return { data: { status: 120, message: 'secret' } }
  })
  const store = createTestStore()
  const instance = client(store, request)
  const assertion = expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' })
  await jest.runAllTimersAsync()
  await assertion
  expect(request).toHaveBeenCalledTimes(2)
  expect(instance.execute).toHaveBeenCalledTimes(2)
  expect(instance.execute.mock.calls.map(args => args[1])).toEqual([105000, 105000])
  expect(instance.cooldown.mock.calls).toEqual([
    ['tencent:key', 300, 'nearbyPois'], ['tencent:key', 600, 'nearbyPois']
  ])
  expect(store.documents.get('tencent:key').cooldownUntilMs).toBe(100900)
  expect(store.documents.get('tencent:poi-explore').cooldownUntilMs).toBe(0)
  expect(JSON.stringify(instance.log.mock.calls)).not.toMatch(/secret|private-url/)
})

test('rate-limited request can succeed only after reacquiring scopes', async () => {
  const request = jest.fn().mockResolvedValueOnce({ data: { status: 120 } }).mockResolvedValue(ok)
  const instance = client(createTestStore(), request)
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(instance.execute).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith('private-url', { params: { key: 'secret' }, timeout: 10000 })
})

test.each([121, 110, 111, 112, 113, 190, 199, 311, 500, 510, 520, 530, 531, 600])('status %i is normalized without retries or cooldown', async status => {
  for (const rejected of [false, true]) {
    const request = jest.fn(async () => {
      const response = { data: { status, message: 'secret' } }
      if (rejected) throw { response }
      return response
    })
    const instance = client(createTestStore(), request)
    await expect(instance.call()).rejects.toMatchObject({
      code: status === 121 ? 'PROVIDER_QUOTA_EXHAUSTED' : 'PROVIDER_GATEWAY_FAILED'
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(instance.cooldown).not.toHaveBeenCalled()
  }
})

test('cooldowns are monotonic across independent coordinators', async () => {
  const store = createTestStore()
  await client(store).limiter.cooldown('tencent:key', 1000, 'nearbyPois')
  await client(store).limiter.cooldown('tencent:key', 100, 'nearbyPois')
  expect(store.documents.get('tencent:key').cooldownUntilMs).toBe(101000)
})

test('transient conflicts retry separately; exhausted conflicts fail closed before HTTP', async () => {
  for (const conflicts of [1, 20]) {
    const store = createTestStore()
    store.forcedConflicts = conflicts
    const instance = client(store)
    const assertion = conflicts === 1 ? expect(instance.call()).resolves.toBe(ok)
      : expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_BUSY' })
    await jest.runAllTimersAsync()
    await assertion
    expect(instance.request).toHaveBeenCalledTimes(conflicts === 1 ? 1 : 0)
  }
})

test('database failure and corrupt state fail closed', async () => {
  for (const corrupt of [false, true]) {
    const store = createTestStore()
    if (corrupt) store.documents.set('tencent:key', { nextAllowedAtMs: 'invalid' })
    else store.failure = new Error('secret database details')
    const instance = client(store)
    await expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
    expect(instance.request).not.toHaveBeenCalled()
    expect(JSON.stringify(instance.log.mock.calls)).not.toContain('secret')
  }
})

test('failed cooldown publication forbids another HTTP attempt', async () => {
  const store = createTestStore({ beforeCommit: ({ writes }) => {
    if ([...writes.values()].some(state => state.cooldownUntilMs > 0)) throw new Error('secret')
  } })
  const instance = client(store, jest.fn(async () => ({ data: { status: 120 } })))
  await expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  expect(instance.request).toHaveBeenCalledTimes(1)
})

test.each(['nearbyPois', 'walkingRoute'])('%s transport errors normalize safely without retry or cooldown', async operation => {
  for (const error of [new Error('private network failure'), { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' },
    { response: { status: 500, data: 'private payload' } }, { response: { status: 503, data: { status: 999 } } },
    ...[400, 401, 403, 404, 429].map(status => ({ response: { status, data: 'private gateway payload' } }))]) {
    const instance = client(createTestStore(), jest.fn().mockRejectedValue(error))
    await expect(instance.call(operation)).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
    expect(instance.request).toHaveBeenCalledTimes(1)
    expect(instance.cooldown).not.toHaveBeenCalled()
    expect(JSON.stringify(instance.log.mock.calls)).not.toContain('private')
  }
})

test.each([120, 121])('recognized body status %i takes precedence over HTTP 500', async status => {
  const instance = client(createTestStore(), jest.fn().mockRejectedValue({ response: { status: 500, data: { status } } }))
  const assertion = expect(instance.call()).rejects.toMatchObject({
    code: status === 120 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_QUOTA_EXHAUSTED'
  })
  await jest.runAllTimersAsync()
  await assertion
  expect(instance.request).toHaveBeenCalledTimes(status === 120 ? 2 : 1)
  expect(instance.cooldown).toHaveBeenCalledTimes(status === 120 ? 2 : 0)
})

test('walking and POI use independent service pacing with the same key scope', async () => {
  const store = createTestStore()
  const starts = { nearbyPois: [], walkingRoute: [] }
  const pending = Promise.all(Object.keys(starts).flatMap(operation => Array.from({ length: 2 }, () =>
    client(store, async () => { starts[operation].push(Date.now()); return ok }).call(operation))))
  await jest.runAllTimersAsync()
  await pending
  expect(starts.nearbyPois).toEqual([100000, 100100])
  // Shared key fencing can add transaction-conflict jitter, not POI pacing.
  expect(starts.walkingRoute[0]).toBeLessThan(starts.nearbyPois[1])
  expect(starts.walkingRoute[1] - starts.walkingRoute[0]).toBeGreaterThanOrEqual(200)
  expect([...store.documents.keys()].sort()).toEqual(['tencent:key', 'tencent:poi-explore', 'tencent:walking'])
})

test.each(['nearbyPois', 'walkingRoute'])('120 from %s delays the other operation through shared key cooldown', async limitedOperation => {
  const store = createTestStore()
  const limited = client(store, jest.fn(async () => ({ data: { status: 120 } })))
  const assertion = expect(limited.call(limitedOperation)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' })
  await jest.advanceTimersByTimeAsync(0)
  const cooldownUntil = store.documents.get('tencent:key').cooldownUntilMs
  expect(cooldownUntil).toBeGreaterThan(Date.now())
  const otherOperation = limitedOperation === 'nearbyPois' ? 'walkingRoute' : 'nearbyPois'
  const starts = []
  const other = client(store, jest.fn(async () => { starts.push(Date.now()); return ok }))
  const pending = other.call(otherOperation)
  await jest.advanceTimersByTimeAsync(cooldownUntil - Date.now() - 1)
  expect(other.request).not.toHaveBeenCalled()
  await jest.runAllTimersAsync()
  await assertion
  expect(await pending).toBe(ok)
  expect(starts[0]).toBeGreaterThanOrEqual(cooldownUntil)
  expect(limited.execute).toHaveBeenCalledTimes(2)
})
