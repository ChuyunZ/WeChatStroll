const { createTestStore } = require('./test-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { loadLimits } = require('./config')

const ok = { data: { status: '1' } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const scopes = [{ id: 'amap:key', minIntervalMs: 0 }, { id: 'amap:walking', minIntervalMs: 100 }]
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function worker(backing, { request = jest.fn(async () => ok), common = {}, service = {} } = {}) {
  const limits = { ...loadLimits({}), clockGuardMs: 0, leaseStartWindowMs: 300,
    transactionJitterMs: 10, ...common }
  for (const operation of ['walkingRoute', 'nearbyPois']) {
    limits[operation] = { ...limits[operation], minIntervalMs: 100, maxQueueWaitMs: 5000,
      cooldownBaseMs: 300, ...service }
  }
  // Separate limiter, provider and store handles, sharing only backing state.
  const store = { transaction: work => backing.transaction(work) }
  const log = jest.fn()
  const limiter = createLimiter({ store, ...limits, random: () => 0.5, log })
  const provider = createProvider({ limiter, limits, request, log })
  return { limiter, log, request, call: (operation = 'walkingRoute') => provider(operation)('mock', {}) }
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100000) })
afterEach(() => jest.useRealTimers())

test.each([500, 1500])('regression: every successful transaction taking %i ms still starts HTTP exactly once', async delay => {
  const store = createTestStore({ beforeCommit: () => sleep(delay) })
  const instance = worker(store, { common: { clockGuardMs: 100, leaseStartWindowMs: 10000 },
    service: { minIntervalMs: 1500, maxQueueWaitMs: 12000 } })
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(store.transactions).toBe(3) // lease, start gate, actual start record
  const starts = instance.log.mock.calls.map(([record]) => record).filter(record => record.event === 'provider_start')
  expect(starts).toEqual([expect.objectContaining({ startedAtMs: 100000 + 2 * delay, attempt: 1 })])
  expect(store.documents.get('amap:walking')).toMatchObject({
    nextAllowedAtMs: starts[0].startedAtMs + 1500 + 200, leaseOwner: null
  })
  expect(instance.log.mock.calls.some(([record]) => record.event === 'stale_acquisition')).toBe(false)
})

test('slow commit acknowledgement also succeeds without discarding the acquired lease', async () => {
  const store = createTestStore({ afterCommit: () => sleep(1500) })
  const instance = worker(store, { common: { clockGuardMs: 100, leaseStartWindowMs: 10000 } })
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(store.documents.get('amap:walking').nextAllowedAtMs).toBe(103300)
})

test.each([0, 400])('independent slow instances preserve actual start spacing with key interval %i', async keyMinIntervalMs => {
  let transaction = 0
  const backing = createTestStore({ beforeCommit: () => sleep(++transaction % 2 ? 500 : 1500) })
  const starts = []
  const instances = [0, 1].map(() => worker(backing, {
    common: { leaseStartWindowMs: 10000, keyMinIntervalMs }, service: { maxQueueWaitMs: 30000 },
    request: async () => { starts.push(Date.now()); return ok }
  }))
  const pending = Promise.all(instances.map(instance => instance.call()))
  await jest.runAllTimersAsync()
  expect(await pending).toEqual([ok, ok])
  expect(starts).toHaveLength(2)
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(keyMinIntervalMs || 100)
  expect(backing.documents.get('amap:walking').nextAllowedAtMs).toBe(starts[1] + 100)
})

test.each([0, 400])('lease gates competitors until actual start is recorded, with key interval %i', async keyMinIntervalMs => {
  const releaseRecord = deferred()
  let held = false
  const backing = createTestStore({ beforeCommit: ({ writes }) => {
    const state = writes.get('amap:walking')
    if (!held && state && state.leaseOwner === null && state.nextAllowedAtMs > 0) {
      held = true
      return releaseRecord.promise
    }
  } })
  const common = { leaseStartWindowMs: 10000, keyMinIntervalMs }
  const first = worker(backing, { common })
  const second = worker(backing, { common })
  const poi = worker(backing, { common })
  const firstPending = first.call()
  await jest.advanceTimersByTimeAsync(0)
  expect(first.request).toHaveBeenCalledTimes(1)
  expect(backing.documents.get('amap:walking').leaseOwner).toEqual(expect.any(String))
  expect(backing.documents.get('amap:walking').nextAllowedAtMs).toBe(0)
  const pending = Promise.all([firstPending, second.call(), poi.call('nearbyPois')])
  await jest.advanceTimersByTimeAsync(200)
  expect(second.request).not.toHaveBeenCalled()
  expect(poi.request).toHaveBeenCalledTimes(keyMinIntervalMs ? 0 : 1)
  releaseRecord.resolve()
  await jest.runAllTimersAsync()
  expect(await pending).toEqual([ok, ok, ok])
  expect(second.request).toHaveBeenCalledTimes(1)
  expect(backing.documents.get('amap:walking').leaseOwner).toBeNull()
})

test('worker crash leaves a bounded lease with a full safety tail, then a fresh owner recovers', async () => {
  const backing = createTestStore()
  const first = worker(backing, { common: { clockGuardMs: 25 } })
  const lease = await first.limiter.acquire(scopes, Date.now() + 5000, 'walkingRoute')
  expect(lease.leaseUntilMs - lease.startBeforeMs).toBe(150)
  const second = worker(backing)
  const pending = second.call()
  await jest.advanceTimersByTimeAsync(449)
  expect(second.request).not.toHaveBeenCalled()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(second.request).toHaveBeenCalledTimes(1)
  expect(second.log).toHaveBeenCalledWith({ event: 'lease_recovered', operation: 'walkingRoute', scope: 'amap:walking' })
  expect(backing.documents.get('amap:walking').leaseOwner).toBeNull()
  expect(first.request).not.toHaveBeenCalled()
})

test('start recording failure fails closed, retains the lease and later recovers without an unsafe burst', async () => {
  const backing = createTestStore()
  const first = worker(backing, { request: jest.fn(async () => {
    backing.failure = new Error('secret database internals')
    return ok
  }) })
  await expect(first.call()).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  expect(first.request).toHaveBeenCalledTimes(1)
  expect(first.log).toHaveBeenCalledWith({ event: 'start_record_failed', operation: 'walkingRoute' })
  const state = backing.documents.get('amap:walking')
  expect(state.leaseOwner).toEqual(expect.any(String))
  expect(state.nextAllowedAtMs).toBe(0)
  backing.failure = null
  const second = worker(backing)
  const pending = second.call()
  await jest.advanceTimersByTimeAsync(399)
  expect(second.request).not.toHaveBeenCalled()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(second.request).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(first.log.mock.calls)).not.toContain('secret')
})

test('late finalizer cannot overwrite or release a successor lease', async () => {
  const firstRecord = deferred()
  const secondRecord = deferred()
  let recording = 0
  const backing = createTestStore({ beforeCommit: ({ writes }) => {
    const state = writes.get('amap:walking')
    if (state && state.leaseOwner === null && state.nextAllowedAtMs > 0) {
      if (++recording === 1) return firstRecord.promise
      if (recording === 2) return secondRecord.promise
    }
  } })
  const first = worker(backing)
  const firstAssertion = expect(first.call()).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  await jest.advanceTimersByTimeAsync(450)
  const oldOwner = backing.documents.get('amap:walking').leaseOwner
  const second = worker(backing)
  const secondPending = second.call()
  await jest.advanceTimersByTimeAsync(0)
  const newOwner = backing.documents.get('amap:walking').leaseOwner
  expect(newOwner).not.toBe(oldOwner)
  firstRecord.resolve()
  await jest.advanceTimersByTimeAsync(10)
  await firstAssertion
  expect(backing.documents.get('amap:walking').leaseOwner).toBe(newOwner)
  secondRecord.resolve()
  await jest.runAllTimersAsync()
  expect(await secondPending).toBe(ok)
  expect(backing.documents.get('amap:walking').nextAllowedAtMs).toBe(100550)
})

test.each(['amap:walking', 'amap:key'])('start gate rechecks %s cooldown published during acquisition acknowledgement', async scope => {
  const commitAck = deferred()
  let held = false
  const backing = createTestStore({ afterCommit: ({ result }) => {
    if (!held && result && result.owner) { held = true; return commitAck.promise }
  } })
  const waiting = worker(backing)
  const pending = waiting.call()
  await jest.advanceTimersByTimeAsync(50)
  await worker(backing).limiter.cooldown(scope, 300, 'walkingRoute')
  commitAck.resolve()
  await jest.advanceTimersByTimeAsync(299)
  expect(waiting.request).not.toHaveBeenCalled()
  // A blocked start gate gives up its lease while waiting for cooldown.
  expect(backing.documents.get('amap:walking').leaseOwner).toBeNull()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(waiting.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'provider_start', startedAtMs: 100350 }))
})

test('waiting for another lease respects the fixed queue deadline', async () => {
  const backing = createTestStore()
  await worker(backing).limiter.acquire(scopes, Date.now() + 5000, 'walkingRoute')
  const second = worker(backing, { service: { maxQueueWaitMs: 150 } })
  const assertion = expect(second.call()).rejects.toMatchObject({ code: 'PROVIDER_BUSY' })
  await jest.runAllTimersAsync()
  await assertion
  expect(Date.now()).toBe(100150)
  expect(second.request).not.toHaveBeenCalled()
  expect(second.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'queue_deadline_exceeded' }))
})

test('HTTP completion beyond queue deadline still succeeds and releases no second start', async () => {
  const instance = worker(createTestStore(), { service: { maxQueueWaitMs: 100 },
    request: jest.fn(async () => { await sleep(1000); return ok }) })
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(instance.request).toHaveBeenCalledTimes(1)
})

test('recording after queue deadline still persists the actual start and returns the completed HTTP result', async () => {
  const backing = createTestStore({ beforeCommit: ({ writes }) => {
    const state = writes.get('amap:walking')
    if (state && state.nextAllowedAtMs > 0) return sleep(500)
  } })
  const instance = worker(backing, { service: { maxQueueWaitMs: 100 } })
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(backing.documents.get('amap:walking')).toMatchObject({ leaseOwner: null, nextAllowedAtMs: 100100 })
})

test('late QPS response publishes cooldown but cannot reset the original queue deadline for retry', async () => {
  const backing = createTestStore()
  const instance = worker(backing, { service: { maxQueueWaitMs: 100 },
    request: jest.fn(async () => { await sleep(1000); return { data: { infocode: '10021' } } }) })
  const assertion = expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_BUSY' })
  await jest.runAllTimersAsync()
  await assertion
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(backing.documents.get('amap:walking').cooldownUntilMs).toBe(101300)
})

test('a genuinely expired start window is never used to start HTTP in the safety tail', async () => {
  let transactions = 0
  const backing = createTestStore({ afterCommit: () => ++transactions === 2 ? sleep(301) : undefined })
  const instance = worker(backing)
  const pending = instance.call()
  await jest.runAllTimersAsync()
  expect(await pending).toBe(ok)
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(instance.log).toHaveBeenCalledWith({ event: 'lease_start_expired', operation: 'walkingRoute' })
  expect(instance.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'provider_start', startedAtMs: 100301 }))
})

test('record failure still publishes QPS cooldown and never retries HTTP directly', async () => {
  let failRecord = true
  const backing = createTestStore({ beforeCommit: ({ writes }) => {
    const state = writes.get('amap:walking')
    if (failRecord && state && state.nextAllowedAtMs > 0) {
      failRecord = false
      throw new Error('secret')
    }
  } })
  const instance = worker(backing, { request: jest.fn(async () => ({ data: { infocode: '10023' } })) })
  await expect(instance.call()).rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  expect(instance.request).toHaveBeenCalledTimes(1)
  expect(backing.documents.get('amap:key').cooldownUntilMs).toBe(100300)
  expect(backing.documents.get('amap:walking').leaseOwner).toEqual(expect.any(String))
})
