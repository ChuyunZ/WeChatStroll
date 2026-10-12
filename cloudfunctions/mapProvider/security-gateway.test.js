jest.mock('wx-server-sdk', () => ({ init: jest.fn(), database: jest.fn(() => ({})),
  getWXContext: jest.fn(() => ({ OPENID: 'synthetic-user', APPID: 'app' })) }))
jest.mock('axios', () => ({ get: jest.fn() }))
jest.mock('@cloudbase/node-sdk', () => ({ SYMBOL_CURRENT_ENV: 'test', init: () => ({
  callFunction: async ({ data }) => {
    // Model the critical boundary: nested invocation has NO end-user context.
    require('wx-server-sdk').getWXContext.mockReturnValueOnce({})
    return { result: await require('./index').main(data) }
  }
}) }))
jest.mock('./cloudbase-store', () => ({ ...jest.requireActual('./cloudbase-store'), createCloudBaseStore: jest.fn() }))
jest.mock('./quota-store', () => ({ ...jest.requireActual('./quota-store'), createQuotaStore: jest.fn() }))
const cloud = require('wx-server-sdk')
const axios = require('axios')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createQuotaStore } = require('./quota-store')
const { createTestStore } = require('./test-store')
const { main } = require('./index')
const { DAY } = require('./quota')
let saved, quotaStore
const start = { latitude: 31, longitude: 121 }
const destination = { latitude: 31.001, longitude: 121.001 }
beforeEach(() => {
  saved = { ...process.env }
  Object.assign(process.env, { TENCENT_MAPS_API_KEY: 'fake-key', TENCENT_MAPS_SECRET_KEY: 'fake-secret',
    MAP_PLANNING_SECRET: 'synthetic-planning-secret-32-bytes-long', MAP_QUOTA_OFFSET_MINUTES: '0', MAP_QUOTA_ACTIVE_FROM_MS: '0' })
  jest.useFakeTimers()
  jest.setSystemTime(DAY + 60000)
  jest.clearAllMocks()
  cloud.getWXContext.mockReturnValue({ OPENID: 'synthetic-user', APPID: 'app' })
  createCloudBaseStore.mockReturnValue(createTestStore())
  quotaStore = createTestStore()
  quotaStore.documents.set('calendar', { activeFromMs: 0, offsetMinutes: 0, latestDay: 0 })
  createQuotaStore.mockReturnValue(quotaStore)
  axios.get.mockImplementation(async url => ({ data: url.includes('explore') ? { status: 0, data: [
    { id: 'synthetic-poi', title: 'synthetic-title', location: { lat: destination.latitude, lng: destination.longitude } }
  ] } : { status: 0, result: { routes: [{ distance: 100, duration: 2, polyline: [31, 121, 1000, 1000] }] } } }))
  jest.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { process.env = saved; jest.useRealTimers(); jest.restoreAllMocks() })
async function call(event) { const result = main(event); await jest.runAllTimersAsync(); return result }
test('actual gateway authorizes discovery then Walking; duplicates cannot obtain another HTTP response', async () => {
  const found = await call({ action: 'nearbyPois', ...start, requestId: 'request_discovery_1' })
  expect(found.success).toBe(true)
  expect(found.planningToken).toEqual(expect.any(String))
  const event = { action: 'walkingRoute', start, destination, planningToken: found.planningToken, requestId: 'request_walking_1' }
  expect(await call(event)).toMatchObject({ success: true, route: { durationSeconds: 120 } })
  expect(await call(event)).toMatchObject({ error: { code: 'MAP_EXECUTION_UNKNOWN' } })
  expect(axios.get).toHaveBeenCalledTimes(4)
  expect(quotaStore.documents.get('day_1').used).toEqual({ explore: 3, walking: 1 })
  expect(JSON.stringify([...quotaStore.documents])).not.toMatch(/synthetic-user|synthetic-poi|synthetic-title|31\.001|121\.001|polyline/)
  expect(JSON.stringify(console.info.mock.calls)).not.toContain(found.planningToken)
  expect(await call({ action: 'closePlanning', planningToken: found.planningToken })).toEqual({ success: true })
  expect(await call({ ...event, requestId: 'request_walking_2' })).toMatchObject({ error: { code: 'MAP_SESSION_EXPIRED' } })
})
test.each([
  ['TENCENT_MAPS_API_KEY', undefined],
  ['TENCENT_MAPS_SECRET_KEY', undefined],
  ['TENCENT_MAPS_WALKING_MAX_ATTEMPTS', '0'],
  ['TENCENT_MAPS_POI_MIN_INTERVAL_MS', 'invalid']
])('authenticated closePlanning releases holds despite invalid Tencent setting %s', async (name, value) => {
  const found = await call({ action: 'nearbyPois', ...start, requestId: 'request_before_config_failure' })
  expect(found.success).toBe(true)
  expect(quotaStore.documents.get('day_1').sessions).not.toEqual({})
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  expect(await call({ action: 'closePlanning', planningToken: found.planningToken })).toEqual({ success: true })
  expect(quotaStore.documents.get('day_1').sessions).toEqual({})
  expect(quotaStore.documents.get('day_1').used).toEqual({ explore: 3, walking: 0 })
  expect(await call({ action: 'closePlanning', planningToken: found.planningToken })).toEqual({ success: true })
  expect(axios.get).toHaveBeenCalledTimes(3) // No Tencent calls on close.
  const subsequent = await call({ action: 'nearbyPois', ...start, requestId: 'request_after_config_failure' })
  expect(subsequent.success).toBe(false) // Discovery still requires valid Tencent configuration.
  expect(axios.get).toHaveBeenCalledTimes(3)
})

test('closePlanning still requires the authenticated owner when Tencent credentials are absent', async () => {
  const found = await call({ action: 'nearbyPois', ...start, requestId: 'request_authenticated_close' })
  expect(found.success).toBe(true)
  delete process.env.TENCENT_MAPS_API_KEY
  cloud.getWXContext.mockReturnValue({ OPENID: 'other-user', APPID: 'app' })
  expect(await call({ action: 'closePlanning', planningToken: found.planningToken }))
    .toMatchObject({ error: { code: 'MAP_SESSION_INVALID' } })
  expect(quotaStore.documents.get('day_1').sessions).not.toEqual({})
  cloud.getWXContext.mockReturnValue({})
  expect(await call({ action: 'closePlanning', planningToken: found.planningToken }))
    .toMatchObject({ error: { code: 'MAP_UNAUTHORIZED' } })
  expect(quotaStore.documents.get('day_1').sessions).not.toEqual({})
  expect(axios.get).toHaveBeenCalledTimes(3)
})

test.each(['ready_rejected', 'ready_committed_ack_lost'])(
  'discovery %s cleans undelivered physical and creation holds without refunding Explore sends',
  async mode => {
    let faultInjected = false
    const rejectReady = ({ writes }) => {
      const day = writes.get('day_1')
      if (!faultInjected && day && Object.values(day.sessions).some(s => s.ready)) {
        faultInjected = true
        throw new Error('synthetic ready storage failure')
      }
    }
    if (mode === 'ready_rejected') quotaStore.beforeCommit = rejectReady
    else quotaStore.afterCommit = rejectReady
    const response = await call({ action: 'nearbyPois', ...start, requestId: 'request_ready_failure' })
    expect(response).toMatchObject({ success: false, error: { code: 'MAP_QUOTA_UNAVAILABLE' } })
    expect(faultInjected).toBe(true)
    expect(quotaStore.documents.get('day_1').sessions).toEqual({})
    expect(quotaStore.documents.get('day_1').used).toEqual({ explore: 3, walking: 0 })
    expect(quotaStore.documents.get('day_1').creations.requests.explore).toBe(1)
    expect(quotaStore.documents.get('day_1').creations.attempts.explore).toBe(3)
    expect(axios.get).toHaveBeenCalledTimes(3)
  }
)

test('unsigned direct and legacy-shaped requests cannot bypass gateway authorization', async () => {
  expect(await call({ action: 'walkingRoute', start, destination, OPENID: 'fake', ownerKey: 'fake' }))
    .toMatchObject({ error: { code: 'MAP_SESSION_INVALID' } })
  cloud.getWXContext.mockReturnValue({})
  expect(await call({ action: 'nearbyPois', ...start, OPENID: 'fake', requestId: 'request_discovery_1' }))
    .toMatchObject({ error: { code: 'MAP_UNAUTHORIZED' } })
  expect(axios.get).not.toHaveBeenCalled()
})

test('authenticated legacy wrappers work when nested OPENID is absent, but do not authorize old raw Walking', async () => {
  const nearby = require('../getNearbyPois')
  const walking = require('../getWalkingRoute')
  const pending = nearby.main({ ...start, requestId: 'legacy_discovery_1', OPENID: 'forged', ownerKey: 'forged' })
  await jest.runAllTimersAsync()
  const found = await pending
  expect(found.success).toBe(true)
  const walk = walking.main({ start, destination, planningToken: found.planningToken, requestId: 'legacy_walking_1' })
  await jest.runAllTimersAsync()
  expect(await walk).toMatchObject({ success: true })
  const unauthorized = walking.main({ start, destination })
  await jest.runAllTimersAsync()
  expect(await unauthorized).toMatchObject({ error: { code: 'MAP_SESSION_INVALID' } })
  expect(axios.get).toHaveBeenCalledTimes(4)
})

test('quotaStatus cannot spend map quota or be forged by event OPENID', async () => {
  const protectedDocuments = () => JSON.stringify(
    [...quotaStore.documents].filter(([id]) => !id.startsWith('ingress_')))
  const before = protectedDocuments()
  const first = await call({ action: 'quotaStatus', OPENID: 'forged-user', ownerKey: 'forged' })
  expect(first).toMatchObject({
    success: true,
    quota: { remainingPlanningSessions: 3, resetAtMs: 2 * DAY }
  })
  expect(protectedDocuments()).toBe(before)
  const ingress = [...quotaStore.documents].filter(([id]) => id.startsWith('ingress_'))
  expect(ingress).toHaveLength(1)
  expect(ingress[0][1].counts.quotaStatus).toBe(1)
  expect(ingress[0][1].leases).toEqual([])
  expect(axios.get).not.toHaveBeenCalled()
  cloud.getWXContext.mockReturnValue({})
  expect(await call({ action: 'quotaStatus', OPENID: 'synthetic-user' }))
    .toMatchObject({ error: { code: 'MAP_UNAUTHORIZED' } })
  expect(protectedDocuments()).toBe(before)
  expect(ingress[0][1].counts.quotaStatus).toBe(1)
})
test('quotaStatus uses live user holds and works without Tencent credentials', async () => {
  const found = await call({ action: 'nearbyPois', ...start, requestId: 'quota_balance_discovery_1' })
  expect(found.success).toBe(true)
  delete process.env.TENCENT_MAPS_API_KEY
  delete process.env.TENCENT_MAPS_SECRET_KEY
  expect(await call({ action: 'quotaStatus' })).toMatchObject({
    success: true, quota: { remainingPlanningSessions: 2 }
  })
  expect(axios.get).toHaveBeenCalledTimes(3)
})
