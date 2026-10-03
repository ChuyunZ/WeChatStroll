const { createTestStore } = require('./test-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { loadLimits } = require('./config')
const ok = { data: { status: 0, data: [] } }

function client(store, request = jest.fn(async () => ok), service = {}) {
  const limits = { ...loadLimits({}), clockGuardMs: 0, transactionJitterMs: 10 }
  limits.nearbyPois = { ...limits.nearbyPois, minIntervalMs: 100, maxQueueWaitMs: 5000,
    cooldownBaseMs: 300, ...service }
  const log = jest.fn()
  const limiter = createLimiter({ store, ...limits, random: () => 0.5, log })
  const execute = jest.spyOn(limiter, 'execute')
  const cooldown = jest.spyOn(limiter, 'cooldown')
  const provider = createProvider({ limiter, limits, request, log })
  return { limiter, execute, cooldown, request, log, call: () => provider('nearbyPois')('private-url', { params: { key: 'secret' } }) }
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

test.each([121, 500, 510, 520, 530, 531, 600])('status %i is normalized without retries or cooldown', async status => {
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

test('ordinary HTTP errors are not retried or given rate cooldowns', async () => {
  const instance = client(createTestStore(), jest.fn().mockRejectedValue(new Error('transport failed')))
  await expect(instance.call()).rejects.toThrow('transport failed')
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(instance.cooldown).not.toHaveBeenCalled()
})
