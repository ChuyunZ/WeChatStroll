jest.mock('@cloudbase/node-sdk', () => ({
  SYMBOL_CURRENT_ENV: Symbol('current-env'),
  init: jest.fn(() => ({ callFunction: (...args) => require('wx-server-sdk').callFunction(...args) }))
}))
jest.mock('wx-server-sdk', () => ({ init: jest.fn(), database: jest.fn(() => ({})), callFunction: jest.fn() }))
jest.mock('axios', () => ({ get: jest.fn() }))
jest.mock('./cloudbase-store', () => ({
  ...jest.requireActual('./cloudbase-store'), createCloudBaseStore: jest.fn()
}))
const cloud = require('wx-server-sdk')
const axios = require('axios')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createTestStore } = require('./test-store')
const { main } = require('./index')
const { main: legacyWalking } = require('../getWalkingRoute')
const { main: legacyPois } = require('../getNearbyPois')
const input = { action: 'nearbyPois', latitude: 30.123456, longitude: 120.654321 }
const walking = { action: 'walkingRoute', start: { latitude: 30.123456, longitude: 120.654321 },
  destination: { latitude: 30.124456, longitude: 120.655321 } }
let originalKey
let originalSecretKey
let store

test('legacy and direct callers share mapProvider data and distributed pacing', async () => {
  cloud.callFunction.mockImplementation(async ({ name, data }) => {
    expect(name).toBe('mapProvider')
    return { result: await main(data) }
  })
  axios.get.mockImplementation(async url => ({ data: url.includes('/direction/')
    ? { status: 0, result: { routes: [{ distance: 100, duration: 2, polyline: [30, 120, 100, 100] }] } }
    : { status: 0, data: [] } }))
  const pending = Promise.all([main(walking), legacyWalking(walking), legacyPois(input)])
  await jest.runAllTimersAsync()
  const results = await pending
  expect(results.every(result => result.success)).toBe(true)
  expect(results[0]).toEqual(results[1])
  expect(results[0].route.durationSeconds).toBe(120)
  expect(axios.get).toHaveBeenCalledTimes(5)
  expect(axios.get.mock.calls.every(([url]) => url.startsWith('https://apis.map.qq.com/'))).toBe(true)
  const starts = console.info.mock.calls.map(([, record]) => record)
    .filter(record => record.event === 'provider_start' && record.operation === 'walkingRoute')
  expect(starts[1].startedAtMs - starts[0].startedAtMs).toBeGreaterThanOrEqual(400)
  expect(console.info.mock.calls.every(([prefix]) => ['[Map Provider]', '[Map Legacy Wrapper]'].includes(prefix))).toBe(true)
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(100000)
  jest.clearAllMocks()
  originalKey = process.env.TENCENT_MAPS_API_KEY
  originalSecretKey = process.env.TENCENT_MAPS_SECRET_KEY
  process.env.TENCENT_MAPS_API_KEY = 'private-test-key'
  process.env.TENCENT_MAPS_SECRET_KEY = 'private-test-secret'
  store = createTestStore()
  createCloudBaseStore.mockReturnValue(store)
  axios.get.mockResolvedValue({ data: { status: 0, data: [] } })
  jest.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  if (originalKey === undefined) delete process.env.TENCENT_MAPS_API_KEY
  else process.env.TENCENT_MAPS_API_KEY = originalKey
  if (originalSecretKey === undefined) delete process.env.TENCENT_MAPS_SECRET_KEY
  else process.env.TENCENT_MAPS_SECRET_KEY = originalSecretKey
})

test.each([undefined, {}, { action: 'walking' }, { action: 'private-url' }])('rejects unsupported action %p before DB/HTTP', async event => {
  expect(await main(event)).toEqual({ success: false, error: {
    code: 'INVALID_ACTION', message: 'Unsupported provider operation'
  } })
  expect(cloud.database).not.toHaveBeenCalled()
  expect(axios.get).not.toHaveBeenCalled()
})

test('missing credentials or invalid coordinates never acquire slots', async () => {
  expect(await main({ action: 'nearbyPois' })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  expect(await main({ action: 'walkingRoute' })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  delete process.env.TENCENT_MAPS_API_KEY
  expect(await main(input)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  process.env.TENCENT_MAPS_API_KEY = 'private-test-key'
  delete process.env.TENCENT_MAPS_SECRET_KEY
  expect(await main(walking)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  expect(store.transactions).toBe(0)
  expect(axios.get).not.toHaveBeenCalled()
})

test('all categories traverse the shared limiter and logs/state exclude provider data', async () => {
  axios.get.mockResolvedValue({ data: { status: 0, request_id: 'raw-request-id', data: [{
    id: 'p1', title: 'Park', location: { lat: 30.123456, lng: 120.654321 }, ad_info: 'raw-payload'
  }] } })
  const pending = main({ ...input, radius: 5000, minIntervalMs: 0, maxQueueWaitMs: 0 })
  await jest.runAllTimersAsync()
  const result = await pending
  expect(result.success).toBe(true)
  expect(axios.get).toHaveBeenCalledTimes(3)
  expect(cloud.database).toHaveBeenCalledWith({ throwOnNotFound: false })
  const starts = console.info.mock.calls
    .filter(([, record]) => record.event === 'provider_start')
    .map(([, record]) => record.startedAtMs)
  expect(starts).toHaveLength(3)
  expect(starts[0]).toBeGreaterThanOrEqual(100000)
  for (let i = 1; i < starts.length; i++) {
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(400)
  }
  expect(console.info.mock.calls.every(([prefix]) => prefix === '[Map Provider]')).toBe(true)
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret|30\.123456|120\.654321|https:|raw-payload|raw-request-id/)
  expect(JSON.stringify([...store.documents])).not.toMatch(/private-test-key|private-test-secret|30\.123456|120\.654321|https:|raw-payload/)
  expect(JSON.stringify(result)).not.toMatch(/ad_info|providerMeta|request_id|raw-payload|private-test-key/)
})

test.each([
  [121, 'PROVIDER_QUOTA_EXHAUSTED'],
  ...[110, 111, 112, 113, 190, 199, 311, 500, 510, 520, 530, 531, 600]
    .map(status => [status, 'PROVIDER_GATEWAY_FAILED'])
])('status %i crosses the gateway as %s across concurrent category work', async (status, code) => {
  axios.get.mockResolvedValue({ data: { status, message: 'private-test-key raw-payload https://private 30.123456' } })
  const pending = main(input)
  await jest.runAllTimersAsync()
  expect(await pending).toEqual({ success: false, error: { code, message: 'Unable to retrieve nearby places' } })
  expect(axios.get).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret|raw-payload|https:|30\.123456/)
})

test('HTTP rejection with provider quota payload is normalized and redacted end to end', async () => {
  axios.get.mockRejectedValue({ message: 'private-test-key', config: { url: 'https://private' },
    response: { data: { status: 121, message: 'raw-payload 30.123456' } } })
  const pending = main(input)
  await jest.runAllTimersAsync()
  expect(await pending).toMatchObject({ error: { code: 'PROVIDER_QUOTA_EXHAUSTED' } })
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret|raw-payload|https:|30\.123456/)
})

test('store initialization failure returns only a safe gateway error', async () => {
  createCloudBaseStore.mockImplementationOnce(() => { throw new Error('private-test-key') })
  expect(await main(input)).toEqual({ success: false, error: {
    code: 'PROVIDER_GATEWAY_FAILED', message: 'Provider service is temporarily unavailable'
  } })
  expect(axios.get).not.toHaveBeenCalled()
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret/)
})

test('walking dispatch uses the walking scope, normalizes seconds, and redacts logs', async () => {
  axios.get.mockResolvedValue({ data: { status: 0, request_id: 'private-id', result: { routes: [{
    distance: 150, duration: 2.5, polyline: [30.123456, 120.654321, 1000, 1000],
    steps: [{ type: 1, road_class: 2, road_name: 'private-road' }]
  }] } } })
  const result = await main(walking)
  expect(result).toEqual({ success: true, route: {
    distanceMeters: 150, durationSeconds: 150,
    polyline: [walking.start, { latitude: expect.closeTo(30.124456, 8), longitude: expect.closeTo(120.655321, 8) }]
  } })
  expect(axios.get).toHaveBeenCalledWith('https://apis.map.qq.com/ws/direction/v1/walking/', {
    params: { key: 'private-test-key', from: '30.123456,120.654321', to: '30.124456,120.655321',
      sig: 'd997ddbd44dee65b751401ce88289cd0' }, timeout: 10000
  })
  expect([...store.documents.keys()].sort()).toEqual(['tencent:key', 'tencent:walking'])
  expect(console.info).toHaveBeenCalledWith('[Map Provider]', expect.objectContaining({
    event: 'provider_start', operation: 'walkingRoute', scope: 'tencent:walking'
  }))
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret|30\.123456|120\.654321|https:|private-road|private-id/)
})

test.each([input, walking])('transport failures cross $action without retry or rate cooldown', async event => {
  for (const response of [undefined, { status: 500 }, { status: 400 }]) {
    store = createTestStore()
    createCloudBaseStore.mockReturnValue(store)
    axios.get.mockClear().mockRejectedValue({ response, message: 'private-test-key 30.123456' })
    const code = response && response.status === 400
      ? event.action === 'nearbyPois' ? 'POI_SEARCH_FAILED' : 'WALKING_ROUTE_FAILED'
      : 'PROVIDER_GATEWAY_FAILED'
    const pending = main(event)
    await jest.runAllTimersAsync()
    expect(await pending).toMatchObject({ success: false, error: { code } })
    expect(axios.get).toHaveBeenCalledTimes(event.action === 'nearbyPois' ? 3 : 1)
    expect(store.documents.get('tencent:key').cooldownUntilMs).toBe(0)
    expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|private-test-secret|30\.123456/)
  }
})

test.each([[120, 'PROVIDER_RATE_LIMITED', 2], [121, 'PROVIDER_QUOTA_EXHAUSTED', 1],
  [111, 'PROVIDER_GATEWAY_FAILED', 1], [500, 'PROVIDER_GATEWAY_FAILED', 1],
  [378, 'ROUTE_NOT_FOUND', 1]])(
  'walking body status %i normalizes as %s through the gateway', async (status, code, calls) => {
    axios.get.mockResolvedValue({ data: { status, message: 'private-test-key' } })
    const pending = main(walking)
    await jest.runAllTimersAsync()
    expect(await pending).toMatchObject({ success: false, error: { code } })
    expect(axios.get).toHaveBeenCalledTimes(calls)
  }
)
