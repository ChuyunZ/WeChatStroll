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

const walking = { action: 'walkingRoute', start: { latitude: 30, longitude: 120 },
  destination: { latitude: 31, longitude: 121 } }
const nearby = { action: 'nearbyPois', latitude: 30, longitude: 120 }
const poiResponse = { data: { status: '1', pois: [] } }
const walkingResponse = { data: { status: '1', count: '1', route: { paths: [{
  distance: '100', cost: { duration: '80' }, steps: [{ step_distance: '100',
    polyline: '120,30;121,31', navi: { walk_type: '0' } }]
}] } } }
let store
let originalKey

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(100000)
  jest.clearAllMocks()
  originalKey = process.env.AMAP_API_KEY
  process.env.AMAP_API_KEY = 'secret-key'
  store = createTestStore()
  createCloudBaseStore.mockReturnValue(store)
  jest.spyOn(console, 'info').mockImplementation(() => {})
  axios.get.mockImplementation(async url => url.includes('/direction/') ? walkingResponse : poiResponse)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  if (originalKey === undefined) delete process.env.AMAP_API_KEY
  else process.env.AMAP_API_KEY = originalKey
})

test('walking contract is retained and caller-supplied timing/config cannot bypass limiter', async () => {
  const pending = Promise.all([main(walking), main({ ...walking, minIntervalMs: 0,
    now: 9999999999999, maxQueueWaitMs: 0, action: 'walkingRoute' })])
  await jest.runAllTimersAsync()
  const results = await pending
  expect(results[0]).toEqual(results[1])
  expect(results[0]).toMatchObject({ success: true, route: {
    distanceMeters: 100, durationSeconds: 80, polyline: [walking.start, walking.destination],
    environmentStats: { normalRoadRatio: 1, walkTypeCoverageRatio: 1 }
  } })
  expect(cloud.database).toHaveBeenCalledWith({ throwOnNotFound: false })
  const starts = console.info.mock.calls.map(([, record]) => record)
    .filter(record => record.event === 'provider_start').map(record => record.startedAtMs)
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1500)
})

test('all three POI categories pass the same service limiter and preserve category response', async () => {
  const pending = main(nearby)
  await jest.runAllTimersAsync()
  expect(await pending).toEqual({ success: true, poisByCategory: { park: [], water: [], shoppingStreet: [] } })
  expect(axios.get).toHaveBeenCalledTimes(3)
  const starts = console.info.mock.calls.map(([, record]) => record)
    .filter(record => record.event === 'provider_start').map(record => record.startedAtMs)
  expect(starts).toEqual([100000, 101700, 103400])
})

test('POI error stops later categories instead of leaving orphan provider work', async () => {
  axios.get.mockResolvedValue({ data: { status: '0', infocode: '10001' } })
  expect(await main(nearby)).toMatchObject({ success: false, error: { code: 'POI_SEARCH_FAILED' } })
  expect(axios.get).toHaveBeenCalledTimes(1)
})

test('invalid input/action and absent credentials never acquire provider slots', async () => {
  expect(await main({ action: 'arbitrary-url' })).toMatchObject({ error: { code: 'INVALID_ACTION' } })
  expect(await main({ action: 'walkingRoute' })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  expect(await main({ action: 'nearbyPois' })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  delete process.env.AMAP_API_KEY
  expect(await main(walking)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  expect(axios.get).not.toHaveBeenCalled()
  expect(store.transactions).toBe(0)
})

test('rollback gateway still coordinates independent direct callers', async () => {
  const pending = Promise.all([main(walking), main(walking), main(nearby)])
  await jest.runAllTimersAsync()
  expect((await pending).every(result => result.success)).toBe(true)
  expect(axios.get).toHaveBeenCalledTimes(5)
  const starts = console.info.mock.calls.map(([, record]) => record)
    .filter(record => record.event === 'provider_start' && record.operation === 'walkingRoute')
  expect(starts[1].startedAtMs - starts[0].startedAtMs).toBeGreaterThanOrEqual(1500)
})

test('queue exhaustion returns normalized business error and sanitized logs', async () => {
  store.documents.set('amap:key', { nextAllowedAtMs: 0, cooldownUntilMs: 200000 })
  for (const event of [walking, nearby]) {
    const result = await main(event)
    expect(result).toMatchObject({ success: false, error: { code: 'PROVIDER_BUSY' } })
    expect(Object.keys(result).sort()).toEqual(['error', 'success'])
  }
  expect(axios.get).not.toHaveBeenCalled()
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/secret|latitude|longitude|restapi|payload/)
})

test('gateway retry normalizes HTTP QPS failure without leaking raw request or provider data', async () => {
  axios.get.mockRejectedValue({ message: 'secret URL', config: { params: { key: 'secret-key' } },
    response: { data: { infocode: '10021', coordinates: '120,30', payload: 'secret-payload' } } })
  const pending = main(walking)
  await jest.runAllTimersAsync()
  const result = await pending
  expect(result).toMatchObject({ success: false, error: { code: 'AMAP_RATE_LIMITED' } })
  expect(axios.get).toHaveBeenCalledTimes(2)
  expect(JSON.stringify([result, console.info.mock.calls])).not.toMatch(/secret|coordinates|payload|120,30/)
})

test.each([walking, nearby])('unexpected gateway initialization failure is sanitized (%j)', async event => {
  createCloudBaseStore.mockImplementationOnce(() => { throw new Error('private database internals') })
  const result = await main(event)
  expect(result).toMatchObject({ success: false, error: { code: 'PROVIDER_GATEWAY_FAILED' } })
  expect(axios.get).not.toHaveBeenCalled()
  expect(JSON.stringify([result, console.info.mock.calls])).not.toContain('private')
})

test('invalid limiter configuration fails neutrally before HTTP', async () => {
  const previous = process.env.AMAP_WALKING_MIN_INTERVAL_MS
  process.env.AMAP_WALKING_MIN_INTERVAL_MS = 'invalid'
  try {
    expect(await main(walking)).toMatchObject({ success: false, error: { code: 'PROVIDER_GATEWAY_FAILED' } })
    expect(axios.get).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.AMAP_WALKING_MIN_INTERVAL_MS
    else process.env.AMAP_WALKING_MIN_INTERVAL_MS = previous
  }
})
