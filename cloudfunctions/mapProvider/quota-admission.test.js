const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { createTestStore } = require('./test-store')
const { createQuota, DAY } = require('./quota')
const { loadLimits } = require('./config')
let store, qstore, quota, auth, limiter, admission, limits
beforeEach(async () => {
  jest.useFakeTimers()
  jest.setSystemTime(DAY + 60000)
  store = createTestStore()
  qstore = createTestStore()
  qstore.documents.set('calendar', { activeFromMs: 0, offsetMinutes: 0, latestDay: 0 })
  quota = createQuota({ store: qstore, offsetMinutes: 0, activeFromMs: 0 })
  auth = await quota.begin('a'.repeat(64), 'request_identifier_1', 'input')
  await quota.ready(auth, 'scope')
  auth.scopeHash = 'scope'
  limits = loadLimits({})
  limiter = createLimiter({ store, ...limits })
  admission = { prepare: jest.fn(() => quota.debit(auth, 'walking')),
    cancel: jest.fn(permit => quota.refund(auth, permit)) }
})
afterEach(() => jest.useRealTimers())

test.each(['complete', 'retry120', 'lease-expired', 'cooldown'])(
  'close after confirmed debit, while final QPS confirmation is pending: %s', async mode => {
    let reached, resume
    const confirming = new Promise(resolve => { reached = resolve })
    const gate = new Promise(resolve => { resume = resolve })
    let paused = false
    store.beforeCommit = async ({ result }) => {
      // acquire returns a lease object; confirm returns true. Pause its real
      // optimistic transaction, not a mocked limiter or bypassed lease check.
      if (result === true && !paused) {
        paused = true
        reached()
        await gate
      }
    }
    const request = jest.fn(async () => {
      expect(qstore.documents.get('day_1').sessions[auth.sid]).toBeUndefined()
      expect(qstore.documents.get('day_1').used.walking).toBe(1)
      return { data: { status: mode === 'retry120' ? 120 : 0 } }
    })
    const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {})
      .then(value => ({ value }), error => ({ error }))
    await confirming
    expect(admission.prepare).toHaveBeenCalledTimes(1)
    expect(qstore.documents.get('day_1').used.walking).toBe(1)
    expect(request).not.toHaveBeenCalled()
    await quota.close(auth)
    await expect(quota.claim(auth, 'request_after_close', 'edge')).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
    if (mode === 'lease-expired') jest.setSystemTime(Date.now() + limits.leaseStartWindowMs + 1)
    if (mode === 'cooldown') await limiter.cooldown('tencent:key', 20000, 'walkingRoute')
    resume()
    await jest.runAllTimersAsync()
    const result = await outcome
    if (mode === 'complete' || mode === 'retry120') {
      expect(request).toHaveBeenCalledTimes(1)
      expect(admission.cancel).not.toHaveBeenCalled()
      expect(qstore.documents.get('day_1').used.walking).toBe(1)
      if (mode === 'complete') expect(result.error).toBeUndefined()
      else expect(result.error).toMatchObject({ code: 'MAP_SESSION_EXPIRED' }) // Retry needs a new debit.
    } else {
      expect(request).not.toHaveBeenCalled()
      expect(admission.cancel).toHaveBeenCalledTimes(1)
      expect(qstore.documents.get('day_1').used.walking).toBe(0)
      expect(result.error).toMatchObject({ code: mode === 'cooldown' ? 'PROVIDER_BUSY' : 'MAP_SESSION_EXPIRED' })
      if (mode === 'cooldown') expect(store.conflicts).toBeGreaterThan(0)
    }
    expect(qstore.documents.get('day_1').sessions).toEqual({})
    expect(qstore.documents.get('day_1').creations.attempts.walking).toBe(1)
    await expect(admission.prepare()).rejects.toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  })
test.each([[120, 2, 'PROVIDER_RATE_LIMITED'], [121, 1, 'PROVIDER_QUOTA_EXHAUSTED']])(
  'Tencent %i charges every physical attempt, then terminates', async (status, count, code) => {
    const request = jest.fn(async () => {
      expect(qstore.documents.get('day_1').used.walking).toBe(request.mock.calls.length)
      return { data: { status } }
    })
    const provider = createProvider({ limiter, limits, request, admission })
    const outcome = provider('walkingRoute')('mock', {}).catch(error => error)
    await jest.runAllTimersAsync()
    expect(await outcome).toMatchObject({ code })
    expect(request).toHaveBeenCalledTimes(count)
    expect(qstore.documents.get('day_1').used.walking).toBe(count)
    expect(qstore.documents.get('day_1').creations.attempts.walking).toBe(count)
  })
test('QPS deadline before acquisition never charges daily quota', async () => {
  await limiter.cooldown('tencent:key', 20000, 'walkingRoute')
  const request = jest.fn()
  const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {}).catch(e => e)
  await jest.runAllTimersAsync()
  expect(await outcome).toMatchObject({ code: 'PROVIDER_BUSY' })
  expect(admission.prepare).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})
test('slow confirmed debit outliving queue refunds once without sending', async () => {
  admission.prepare.mockImplementation(async () => {
    const permit = await quota.debit(auth, 'walking')
    jest.setSystemTime(Date.now() + 13000)
    return permit
  })
  const request = jest.fn()
  const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {}).catch(e => e)
  await jest.runAllTimersAsync()
  expect(await outcome).toMatchObject({ code: 'PROVIDER_BUSY' })
  expect(request).not.toHaveBeenCalled()
  expect(qstore.documents.get('day_1').used.walking).toBe(0)
  expect(admission.cancel).toHaveBeenCalledTimes(1)
  expect(qstore.documents.get('day_1').creations.attempts.walking).toBe(1)
})
test('ambiguous debit acknowledgement retains charge and sends no HTTP', async () => {
  qstore.afterCommit = () => { throw new Error('ack lost') }
  const request = jest.fn()
  const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {}).catch(e => e)
  await jest.runAllTimersAsync()
  expect(await outcome).toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
  expect(request).not.toHaveBeenCalled()
  expect(admission.cancel).not.toHaveBeenCalled()
  expect(qstore.documents.get('day_1').used.walking).toBe(1)
  expect(qstore.documents.get('day_1').creations.attempts.walking).toBe(1)
})
test('quota expiration between debit and send never reaches HTTP', async () => {
  admission.prepare.mockImplementation(async () => {
    const permit = await quota.debit(auth, 'walking')
    return { ...permit, startBefore: Date.now() }
  })
  const request = jest.fn()
  const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {}).catch(e => e)
  await jest.runAllTimersAsync()
  expect(await outcome).toMatchObject({ code: 'MAP_SESSION_EXPIRED' })
  expect(request).not.toHaveBeenCalled()
  expect(qstore.documents.get('day_1').used.walking).toBe(0)
})
test('network failure cannot safely refund an invoked HTTP request', async () => {
  const request = jest.fn(async () => { throw new Error('network lost') })
  const outcome = createProvider({ limiter, limits, request, admission })('walkingRoute')('mock', {}).catch(e => e)
  await jest.runAllTimersAsync()
  expect(await outcome).toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  expect(request).toHaveBeenCalledTimes(1)
  expect(admission.cancel).not.toHaveBeenCalled()
  expect(qstore.documents.get('day_1').used.walking).toBe(1)
})


test('close while HTTP is in flight keeps its charge; next send is refused', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve });
  const request = jest.fn(() => pending);
  const invoke = createProvider({ limiter, limits, request, admission })('walkingRoute');
  const outcome = invoke('mock', {});
  await jest.advanceTimersByTimeAsync(100);
  expect(request).toHaveBeenCalledTimes(1);
  await quota.close(auth);
  complete({ data: { status: 0 } });
  await outcome;
  expect(admission.cancel).not.toHaveBeenCalled();
  expect(qstore.documents.get('day_1').used.walking).toBe(1);
  const rejected = invoke('mock', {}).catch(e => e);
  await jest.runAllTimersAsync();
  expect(await rejected).toMatchObject({ code: 'MAP_SESSION_EXPIRED' });
  expect(request).toHaveBeenCalledTimes(1);
});
