// Exercise the installed SDK down to HTTP request construction; no live network.
jest.mock('@cloudbase/node-sdk/dist/utils/request', () => ({ extraRequest: jest.fn() }))
jest.mock('wx-server-sdk', () => ({ init: jest.fn(),
  getWXContext: jest.fn(() => ({ OPENID: 'wrapper-user', APPID: 'test-app' })) }))
const { createTokens, hash } = require('../cloudfunctions/mapProvider/planning-token')
const originalSecret = process.env.MAP_PLANNING_SECRET
const wxCloud = require('wx-server-sdk')
const { extraRequest } = require('@cloudbase/node-sdk/dist/utils/request')
const cloudbase = require('@cloudbase/node-sdk')
const actualInit = cloudbase.init.bind(cloudbase)
const walking = require('../cloudfunctions/getWalkingRoute')
const nearby = require('../cloudfunctions/getNearbyPois')

beforeEach(() => {
  wxCloud.getWXContext.mockReturnValue({ OPENID: 'wrapper-user', APPID: 'test-app' })
  process.env.MAP_PLANNING_SECRET = 'test-wrapper-secret-at-least-32-bytes'
  jest.useFakeTimers()
  jest.clearAllMocks()
  jest.spyOn(console, 'info').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  // Dummy credentials prevent environment discovery; signing and parsing stay real.
  jest.spyOn(cloudbase, 'init').mockImplementation(options => actualInit({
    ...options, env: 'test-env', secretId: 'test-id', secretKey: 'test-key'
  }))
})
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks()
  if (originalSecret === undefined) delete process.env.MAP_PLANNING_SECRET
  else process.env.MAP_PLANNING_SECRET = originalSecret
})

test.each([[walking, 'walkingRoute', { success: true, route: { distanceMeters: 100 } }],
  [nearby, 'nearbyPois', { success: true, poisByCategory: { park: [], water: [], shoppingStreet: [] } }]])(
  'real SDK forwards a 5240 ms success with the configured HTTP timeout (%s)', async (wrapper, action, result) => {
    let markStarted
    const started = new Promise(resolve => { markStarted = resolve })
    extraRequest.mockImplementation(() => { markStarted(); return new Promise(resolve => setTimeout(() => resolve({
      statusCode: 200, body: { data: { response_data: JSON.stringify(result) }, requestId: 'test-request' }
    }), 5240)) })
    const context = { time_limit_in_ms: 80000, secret: 'private-context' }
    const pending = wrapper.main({ input: 'test' }, context)
    await started
    await jest.advanceTimersByTimeAsync(5240)
    expect(await pending).toEqual(result)
    expect(extraRequest).toHaveBeenCalledTimes(1)
    const [request, options] = extraRequest.mock.calls[0]
    expect(request.timeout).toBe(60000)
    expect(request.keepalive).toBe(false)
    expect(options.retryOptions).toEqual({ retries: 0 })
    expect(request.body.function_name).toBe('mapProvider')
    const data = JSON.parse(request.body.request_data)
    expect(data).toEqual({ action, requestId: expect.any(String), _mapDelegation: expect.any(String) })
    const { _mapDelegation, ...payload } = data
    expect(createTokens(process.env.MAP_PLANNING_SECRET).verify(_mapDelegation)).toMatchObject({
      kind: 'forward', inputHash: hash(JSON.stringify(payload)),
      owner: hash(JSON.stringify(['test-app', 'wrapper-user']))
    })
    expect(context.callbackWaitsForEmptyEventLoop).toBe(false)
    expect(console.info).toHaveBeenCalledWith('[Map Legacy Wrapper]', expect.objectContaining({
      event: 'forward_start', executionLimitMs: 80000, timeoutMs: 60000, transport: 'cloudbase-node-3.17.2'
    }))
    expect(JSON.stringify(console.info.mock.calls)).not.toContain('private-context')
    expect(jest.getTimerCount()).toBe(0)
  })

test('real SDK preserves a child business failure', async () => {
  const result = { success: false, error: { code: 'INVALID_COORDINATES', message: 'Invalid coordinates' } }
  extraRequest.mockResolvedValue({ statusCode: 200, body: { data: { response_data: JSON.stringify(result) } } })
  expect(await nearby.main({})).toEqual(result)
})

test.each(['reject', 'envelope'])('real SDK %s failure is normalized without leaking details', async mode => {
  if (mode === 'reject') extraRequest.mockRejectedValue(Object.assign(new Error('private transport details'), { code: 'ETIMEDOUT' }))
  else extraRequest.mockResolvedValue({ statusCode: 200, body: { code: 'FUNCTION_NOT_FOUND', message: 'private infrastructure details' } })
  expect(await nearby.main({})).toMatchObject({ success: false, error: { code: 'PROVIDER_GATEWAY_FAILED' } })
  expect(extraRequest).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(console.info.mock.calls)).not.toContain('private')
  expect(jest.getTimerCount()).toBe(0)
})

test.each([walking, nearby])('legacy entry fails before forwarding when server identity or signing secret is missing', async wrapper => {
  wxCloud.getWXContext.mockReturnValue({})
  expect(await wrapper.main({ OPENID: 'forged', userId: 'forged' })).toMatchObject({ error: { code: 'MAP_UNAUTHORIZED' } })
  expect(extraRequest).not.toHaveBeenCalled()
  wxCloud.getWXContext.mockReturnValue({ OPENID: 'wrapper-user', APPID: 'test-app' })
  delete process.env.MAP_PLANNING_SECRET
  expect(await wrapper.main({})).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  expect(extraRequest).not.toHaveBeenCalled()
})

test('independently deployed delegation helpers and installed SDK versions stay identical', () => {
  const fs = require('fs')
  const path = require('path')
  const source = name => fs.readFileSync(path.join(__dirname, '../cloudfunctions', name, 'delegation.js'), 'utf8')
  expect(source('getNearbyPois')).toBe(source('getWalkingRoute'))
  for (const name of ['getNearbyPois', 'getWalkingRoute']) {
    const pkg = require(`../cloudfunctions/${name}/package.json`)
    const lock = require(`../cloudfunctions/${name}/package-lock.json`)
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies)
    expect(lock.packages['node_modules/wx-server-sdk'].version).toBe('4.0.2')
  }
})
