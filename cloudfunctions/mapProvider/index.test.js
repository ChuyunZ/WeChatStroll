jest.mock('wx-server-sdk', () => ({ init: jest.fn(), database: jest.fn(() => ({})) }))
jest.mock('axios', () => ({ get: jest.fn() }))
jest.mock('./cloudbase-store', () => ({
  ...jest.requireActual('./cloudbase-store'), createCloudBaseStore: jest.fn()
}))
const cloud = require('wx-server-sdk')
const axios = require('axios')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createTestStore } = require('./test-store')
const { main } = require('./index')
const input = { action: 'nearbyPois', latitude: 30.123456, longitude: 120.654321 }
let originalKey
let store

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(100000)
  jest.clearAllMocks()
  originalKey = process.env.TENCENT_MAPS_API_KEY
  process.env.TENCENT_MAPS_API_KEY = 'private-test-key'
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
})

test.each([undefined, {}, { action: 'walkingRoute' }, { action: 'private-url' }])('rejects unsupported action %p before DB/HTTP', async event => {
  expect(await main(event)).toEqual({ success: false, error: {
    code: 'INVALID_ACTION', message: 'Unsupported provider operation'
  } })
  expect(cloud.database).not.toHaveBeenCalled()
  expect(axios.get).not.toHaveBeenCalled()
})

test('missing credentials or invalid coordinates never acquire slots', async () => {
  expect(await main({ action: 'nearbyPois' })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  delete process.env.TENCENT_MAPS_API_KEY
  expect(await main(input)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
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
  const starts = console.info.mock.calls.filter(([, record]) => record.event === 'provider_start')
  expect(starts.map(([, record]) => record.startedAtMs)).toEqual([100000, 101700, 103400])
  expect(console.info.mock.calls.every(([prefix]) => prefix === '[Map Provider]')).toBe(true)
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|30\.123456|120\.654321|https:|raw-payload|raw-request-id/)
  expect(JSON.stringify([...store.documents])).not.toMatch(/private-test-key|30\.123456|120\.654321|https:|raw-payload/)
  expect(JSON.stringify(result)).not.toMatch(/ad_info|providerMeta|request_id|raw-payload|private-test-key/)
})

test.each([
  [120, 'PROVIDER_RATE_LIMITED', 2], [121, 'PROVIDER_QUOTA_EXHAUSTED', 1],
  ...[500, 510, 520, 530, 531, 600].map(status => [status, 'PROVIDER_GATEWAY_FAILED', 1]),
  [110, 'POI_SEARCH_FAILED', 1]
])('status %i crosses the gateway as %s and stops categories', async (status, code, calls) => {
  axios.get.mockResolvedValue({ data: { status, message: 'private-test-key raw-payload https://private 30.123456' } })
  const pending = main(input)
  await jest.runAllTimersAsync()
  expect(await pending).toEqual({ success: false, error: { code, message: 'Unable to retrieve nearby places' } })
  expect(axios.get).toHaveBeenCalledTimes(calls)
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|raw-payload|https:|30\.123456/)
})

test('HTTP rejection with QPS payload is normalized and redacted end to end', async () => {
  axios.get.mockRejectedValue({ message: 'private-test-key', config: { url: 'https://private' },
    response: { data: { status: 120, message: 'raw-payload 30.123456' } } })
  const pending = main(input)
  await jest.runAllTimersAsync()
  expect(await pending).toMatchObject({ error: { code: 'PROVIDER_RATE_LIMITED' } })
  expect(JSON.stringify(console.info.mock.calls)).not.toMatch(/private-test-key|raw-payload|https:|30\.123456/)
})

test('store initialization failure returns only a safe gateway error', async () => {
  createCloudBaseStore.mockImplementationOnce(() => { throw new Error('private-test-key') })
  expect(await main(input)).toEqual({ success: false, error: {
    code: 'PROVIDER_GATEWAY_FAILED', message: 'Provider service is temporarily unavailable'
  } })
  expect(axios.get).not.toHaveBeenCalled()
  expect(JSON.stringify(console.info.mock.calls)).not.toContain('private-test-key')
})
