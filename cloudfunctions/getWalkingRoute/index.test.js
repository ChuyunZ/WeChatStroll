jest.mock('wx-server-sdk', () => ({ init: jest.fn(), getWXContext: jest.fn(() => ({ OPENID: 'test-user', APPID: 'test-app' })) }))
const originalPlanningSecret = process.env.MAP_PLANNING_SECRET
jest.mock('@cloudbase/node-sdk', () => ({ init: jest.fn(() => ({ callFunction: mockInvoke })), SYMBOL_CURRENT_ENV: Symbol('current-env') }))
const mockInvoke = jest.fn()
const fs = require('fs')
const path = require('path')
const cloud = { callFunction: mockInvoke }
const { main: functionMain } = require('./index')
const validInvocation = { environment: JSON.stringify({ WX_APPID: 'test-app', WX_OPENID: 'test-user' }) }
const main = (event, context = {}) => functionMain(event, { ...validInvocation, ...context })
const ACTION = 'walkingRoute'
const failure = { success: false, error: {
  code: 'PROVIDER_GATEWAY_FAILED', message: 'Unable to contact the provider gateway'
} }

beforeEach(() => {
  process.env.MAP_PLANNING_SECRET = 'test-wrapper-secret-with-at-least-32-bytes'
  jest.useFakeTimers()
  jest.clearAllMocks()
  jest.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks()
  if (originalPlanningSecret === undefined) delete process.env.MAP_PLANNING_SECRET
  else process.env.MAP_PLANNING_SECRET = originalPlanningSecret
})

test('forwards to the canonical gateway with fixed action and explicit Node SDK transport timeout', async () => {
  const result = { success: true, value: 'unchanged' }
  cloud.callFunction.mockResolvedValue({ result })
  expect(await main({ action: 'override', input: 'trusted-by-gateway' })).toBe(result)
  expect(cloud.callFunction).toHaveBeenCalledWith({ name: 'mapProvider',
    data: { action: ACTION, requestId: expect.any(String), _mapDelegation: expect.any(String) } },
    { timeout: 60000, retryOptions: { retries: 0 } })
  expect(cloud.callFunction.mock.calls[0]).toHaveLength(2)
  expect(jest.getTimerCount()).toBe(0)
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED', 'INVALID_COORDINATES', 'CONFIG_MISSING'])(
  'preserves child business failure %s without remapping', async code => {
    const result = { success: false, error: { code, message: 'Child failure' } }
    cloud.callFunction.mockResolvedValue({ result })
    expect(await main({})).toBe(result)
    expect(jest.getTimerCount()).toBe(0)
  })

test.each([{ success: true, route: { distanceMeters: 100 } },
  { success: false, error: { code: 'PROVIDER_RATE_LIMITED', message: 'Busy' } }])(
  'accepts a JSON string business result without extra response wrapping', async result => {
    cloud.callFunction.mockResolvedValue({ result: JSON.stringify(result) })
    expect(await main({})).toEqual(result)
  })

test.each([undefined, null, '', 'not JSON', 'null', '[]', 'true', 17, true, [], {},
  { success: 'true' }, { success: false }, { success: false, error: { code: 5, message: 'bad' } },
  JSON.stringify(JSON.stringify({ success: true }))])('invalid child result %p fails neutrally', async result => {
    cloud.callFunction.mockResolvedValue({ result })
    expect(await main({})).toEqual(failure)
    expect(console.info).toHaveBeenCalledWith('[Map Legacy Wrapper]', {
      event: 'forward_failed', action: ACTION, code: 'INVALID_GATEWAY_RESULT'
    })
    expect(jest.getTimerCount()).toBe(0)
  })

test.each([undefined, null, {}])('missing SDK response %p is handled', async response => {
  cloud.callFunction.mockResolvedValue(response)
  expect(await main()).toEqual(failure)
})

test.each(['ETIMEDOUT', 'ECONNRESET', 'secret-code'])('transport rejection %s is sanitized', async code => {
  cloud.callFunction.mockRejectedValue(Object.assign(new Error('secret transport details'), {
    code, config: { url: 'secret-url', key: 'secret-key' }
  }))
  expect(await main({ latitude: 31.23456, longitude: 121.45678 })).toEqual(failure)
  const logs = JSON.stringify(console.info.mock.calls)
  for (const forbidden of ['secret', 'latitude', 'longitude', '31.23456', '121.45678']) expect(logs).not.toContain(forbidden)
  expect(jest.getTimerCount()).toBe(0)
})

test('synchronous SDK throws also clear the watchdog and return a neutral failure', async () => {
  cloud.callFunction.mockImplementation(() => { throw new Error('secret') })
  expect(await main({})).toEqual(failure)
  expect(jest.getTimerCount()).toBe(0)
})

test('forwards the walking route business result without wrapping it', async () => {
  const result = { success: true, route: {
    distanceMeters: 100, durationSeconds: 80,
    polyline: [{ latitude: 30, longitude: 120 }, { latitude: 30.001, longitude: 120.001 }]
  } }
  cloud.callFunction.mockResolvedValue({ result })
  expect(await main({})).toBe(result)
  expect(cloud.callFunction.mock.calls[0]).toEqual([{
    name: 'mapProvider', data: { action: ACTION, requestId: expect.any(String), _mapDelegation: expect.any(String) }
  }, { timeout: 60000, retryOptions: { retries: 0 } }])
})

test('a successful 1.37-second child result returns immediately with no leftover watchdog', async () => {
  const result = { success: true, route: { polyline: 'secret route' } }
  cloud.callFunction.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ result }), 1370)))
  const pending = main({ secret: 'location' })
  await jest.advanceTimersByTimeAsync(1370)
  expect(await pending).toBe(result)
  expect(jest.getTimerCount()).toBe(0)
  expect(console.info).toHaveBeenCalledWith('[Map Legacy Wrapper]', {
    event: 'forward_return', action: ACTION, success: true
  })
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/secret|polyline|location/)
})

test('a never-settling SDK call is bounded without retrying or invoking AMap again', async () => {
  let lateReject
  cloud.callFunction.mockImplementation(() => new Promise((_, reject) => { lateReject = reject }))
  const pending = main({})
  await jest.advanceTimersByTimeAsync(65000)
  expect(await pending).toEqual(failure)
  expect(console.info).toHaveBeenCalledWith('[Map Legacy Wrapper]', {
    event: 'forward_failed', action: ACTION, code: 'FORWARD_DEADLINE_EXCEEDED'
  })
  expect(cloud.callFunction).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
  lateReject(new Error('secret late rejection'))
  await Promise.resolve() // Promise.race observes late rejection as well.
})

test('wrapper has no direct provider dependency and remains independently deployable', () => {
  expect(require('./package.json').dependencies).toEqual({ '@cloudbase/node-sdk': '3.17.2', 'wx-server-sdk': '^4.0.2' })
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  expect(source.match(/require\([^)]*\)/g)).toEqual(["require('@cloudbase/node-sdk')", "require('./delegation')"])
  expect(source).not.toMatch(/axios|restapi\.amap|AMAP_API_KEY/)
})


test('successful forwarding emits only minimal safe diagnostics', async () => {
  cloud.callFunction.mockResolvedValue({ result: { success: true, private: 'private-result' } })
  await main({ private: 'private-input' }, { private: 'private-context' })
  expect(console.info.mock.calls.map(call => call[1].event)).toEqual(['forward_start', 'forward_return'])
  expect(JSON.stringify(console.info.mock.calls)).not.toContain('private')
  expect(jest.getTimerCount()).toBe(0)
})
