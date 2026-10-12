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
const wxInvocation = () => ({ environment: JSON.stringify({ WX_APPID: 'test-app', WX_OPENID: 'wrapper-user' }) })

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
    const context = { time_limit_in_ms: 80000, secret: 'private-context', ...wxInvocation() }
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

test.each([[walking, 'walkingRoute'], [nearby, 'nearbyPois']])(
  'SDK forwarding ignores attacker-supplied transport, identity and prototype fields (%s)', async (wrapper, action) => {
    const malicious = JSON.parse(JSON.stringify({
      action: 'private-other-function', OPENID: 'forged-user', APPID: 'forged-app',
      _mapDelegation: 'forged-signature', ownerKey: 'forged-user', name: 'private-other-function',
      url: 'https://attacker.invalid/', proxy: 'https://attacker.invalid/',
      headers: { Authorization: 'attacker-token' }, timeout: 0, retries: 50,
      secretId: 'attacker-id', secretKey: 'attacker-key', latitude: 31, longitude: 121
    }).replace(/}$/, ',"__proto__":{"__sdkAuditPolluted":true},' +
      '"constructor":{"prototype":{"__sdkAuditPolluted":true}}}'))
    expect({}.__sdkAuditPolluted).toBeUndefined()
    const result = { success: true, accepted: true }
    extraRequest.mockResolvedValue({ statusCode: 200,
      body: { data: { response_data: JSON.stringify(result) } } })
    expect(await wrapper.main(malicious, { time_limit_in_ms: 80000, ...wxInvocation() })).toEqual(result)
    expect(extraRequest).toHaveBeenCalledTimes(1)
    const [request, options] = extraRequest.mock.calls[0]
    expect(request.body.function_name).toBe('mapProvider')
    expect(request.timeout).toBe(60000)
    expect(options.retryOptions).toEqual({ retries: 0 })
    const data = JSON.parse(request.body.request_data)
    expect(data).toEqual({ action, latitude: 31, longitude: 121,
      requestId: expect.any(String), _mapDelegation: expect.any(String) })
    expect(createTokens(process.env.MAP_PLANNING_SECRET).verify(data._mapDelegation)).toMatchObject({
      kind: 'forward', owner: hash(JSON.stringify(['test-app', 'wrapper-user']))
    })
    expect(JSON.stringify(request)).not.toMatch(/attacker\\.invalid|attacker-token|attacker-key|private-other-function|forged-user/)
    expect({}.__sdkAuditPolluted).toBeUndefined()
    expect(jest.getTimerCount()).toBe(0)
  })

test('real SDK preserves a child business failure', async () => {
  const result = { success: false, error: { code: 'INVALID_COORDINATES', message: 'Invalid coordinates' } }
  extraRequest.mockResolvedValue({ statusCode: 200, body: { data: { response_data: JSON.stringify(result) } } })
  expect(await nearby.main({}, wxInvocation())).toEqual(result)
})

test.each(['reject', 'envelope'])('real SDK %s failure is normalized without leaking details', async mode => {
  if (mode === 'reject') extraRequest.mockRejectedValue(Object.assign(new Error('private transport details'), { code: 'ETIMEDOUT' }))
  else extraRequest.mockResolvedValue({ statusCode: 200, body: { code: 'FUNCTION_NOT_FOUND', message: 'private infrastructure details' } })
  expect(await nearby.main({}, wxInvocation())).toMatchObject({ success: false, error: { code: 'PROVIDER_GATEWAY_FAILED' } })
  expect(extraRequest).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(console.info.mock.calls)).not.toContain('private')
  expect(jest.getTimerCount()).toBe(0)
})

test.each([walking, nearby])('legacy entry fails before forwarding when server identity or signing secret is missing', async wrapper => {
  wxCloud.getWXContext.mockReturnValue({ OPENID: 'stale-other-user', APPID: 'test-app' })
  expect(await wrapper.main({ OPENID: 'forged', userId: 'forged' }, { environment: '{}' })).toMatchObject({ error: { code: 'MAP_UNAUTHORIZED' } })
  expect(extraRequest).not.toHaveBeenCalled()
  delete process.env.MAP_PLANNING_SECRET
  expect(await wrapper.main({}, wxInvocation())).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
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
