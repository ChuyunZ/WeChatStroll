const fs = require('fs')
const path = require('path')
const { copyEditableWaypoint, routeEditErrorMessage } = require('../miniprogram/services/route-editing')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { isProviderUnavailableCode } = require('../miniprogram/utils/provider-errors')
const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const start = { latitude: 30, longitude: 120 }
const poi = { poiId: 'A', name: 'Park', category: 'park', latitude: 31, longitude: 121,
  distanceInMeters: 500, address: 'Address' }
const stalePoi = { ...poi, providerMeta: { typecode: '110101' }, raw: { secret: true } }
const options = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }

test('editable and public route waypoints whitelist neutral fields even for stale provider metadata', async () => {
  expect(copyEditableWaypoint(stalePoi)).toEqual(poi)
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: [stalePoi],
    segmentResolver: async () => ({ success: true, distanceMeters: 100, durationSeconds: 120,
      polyline: [start, poi], environmentStats: { normalRoadRatio: 1 }, providerMeta: { secret: true } }) })
  const result = await session.buildRouteForOrder(options)
  expect(result.success).toBe(true)
  expect(result.waypoints).toEqual([poi])
  expect(result).not.toHaveProperty('environmentStats')
  expect(result.segments[0]).toEqual({ from: 'START', to: 'A', distanceMeters: 100, durationSeconds: 120,
    polyline: [start, { latitude: 31, longitude: 121 }] })
  expect(JSON.stringify(result)).not.toMatch(/providerMeta|typecode|secret|environmentStats/)
})

test('walking boundary strips stale environment data and accepts the same route without it', async () => {
  const original = global.wx
  try {
    for (const extra of [{}, { environmentStats: { normalRoadRatio: 1 }, providerMeta: { type: 'road' } }]) {
      global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue({ result: { success: true, route: {
        distanceMeters: 100, durationSeconds: 120, polyline: [start, poi], ...extra
      } } }) } }
      expect(await getWalkingSegment(start, poi)).toEqual({ success: true, distanceMeters: 100,
        durationSeconds: 120, polyline: [start, { latitude: 31, longitude: 121 }] })
      expect(wx.cloud.callFunction.mock.calls[0][0].name).toBe('mapProvider')
    }
  } finally { global.wx = original }
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])(
  '%s is provider unavailability and gets the service error in all editing envelopes', code => {
    expect(isProviderUnavailableCode(code)).toBe(true)
    for (const field of ['code', 'error', 'causeCode']) {
      expect(routeEditErrorMessage({ [field]: code })).toBe('路线服务暂时繁忙，请稍后重试')
    }
  }
)

test('ROUTE_NOT_FOUND remains a cached deterministic failure rather than provider unavailability', async () => {
  expect(isProviderUnavailableCode('ROUTE_NOT_FOUND')).toBe(false)
  expect(isProviderUnavailableCode('AMAP_RATE_LIMITED')).toBe(false)
  const resolver = jest.fn(async () => ({ success: false, error: 'WALKING_SEGMENT_FAILED', causeCode: 'ROUTE_NOT_FOUND' }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: [poi], segmentResolver: resolver })
  expect(await session.evaluateRouteOrder(options)).toMatchObject({ error: 'MULTI_SEGMENT_ROUTE_FAILED' })
  expect(session.getCachedSegmentCosts()).toEqual([{ edgeKey: expect.any(String), success: false }])
  await session.evaluateRouteOrder(options)
  expect(resolver).toHaveBeenCalledTimes(1)
})

test('both production entry points use mapProvider and the AI prompt is provider-neutral', () => {
  for (const file of ['route-generation', 'walking-segment']) {
    const source = fs.readFileSync(path.join(__dirname, `../miniprogram/services/${file}.js`), 'utf8')
    expect(source).toContain("'mapProvider'")
    expect(source).not.toMatch(/amapProvider|AMAP_RATE_LIMITED/)
  }
  const prompt = fs.readFileSync(path.join(__dirname, '../cloudfunctions/aiRoutePlanner/routePlanningPrompt.js'), 'utf8')
  expect(prompt).not.toContain('AMap')
  expect(prompt).toContain("The map provider and the application's route engine are the source of truth")
})
