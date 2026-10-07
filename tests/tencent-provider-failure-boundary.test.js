jest.mock('../miniprogram/services/location', () => ({ getCurrentLocation: jest.fn() }))

const location = require('../miniprogram/services/location')
const { generateRoutes } = require('../miniprogram/services/route-generation')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { createProvider } = require('../cloudfunctions/mapProvider/provider')
const { createWalkingHandler } = require('../cloudfunctions/mapProvider/walking')
const { loadLimits } = require('../cloudfunctions/mapProvider/config')

const start = { latitude: 31, longitude: 121 }
const poi = { poiId: 'A', name: 'Park', category: 'park', latitude: 31.001,
  longitude: 121.001, distanceInMeters: 150 }
const alternative = { ...poi, poiId: 'B', latitude: 31.002, distanceInMeters: 300 }

// Admission is immediate here; limiter timing has its own tests. Exercise the real
// provider -> adapter -> cloud client -> engine -> generation error boundary.
function gateway(request) {
  const limiter = { execute: async (scopes, deadline, operation, startRequest) => ({
    recorded: true,
    outcome: await Promise.resolve().then(() => startRequest({ startedAtMs: 0, waitMs: 0 }))
      .then(value => ({ value }), error => ({ error }))
  }) }
  return createWalkingHandler({ apiKey: 'test', request: createProvider({
    limiter, limits: loadLimits({}), request
  })('walkingRoute') })
}

beforeEach(() => {
  jest.clearAllMocks()
  location.getCurrentLocation.mockResolvedValue(start)
  global.wx = { cloud: { callFunction: jest.fn() } }
})
afterEach(() => { delete global.wx })

const failures = [
  ...[403, 429].map(status => [`HTTP ${status}`, { status }]),
  ['missing body', { data: undefined }],
  ['HTML body', { data: '<html>gateway error</html>' }],
  ['unknown status', { data: { status: 999 } }],
  ['missing routes', { data: { status: 0, result: {} } }],
  ['invalid duration', { data: { status: 0, result: { routes: [
    { distance: 150, duration: '2', polyline: [31, 121, 1000, 1000] }
  ] } } }],
  ['corrupt geometry', { data: { status: 0, result: { routes: [
    { distance: 150, duration: 2, polyline: [] }
  ] } } }]
]

test.each(failures)('%s is not cached as an unreachable edge and stops generation before fallback', async (_, response) => {
  const request = jest.fn(async () => {
    if (response.status) throw { response: { ...response, data: 'private gateway payload' } }
    return response
  })
  const handler = gateway(request)
  wx.cloud.callFunction.mockImplementation(async ({ name, data }) => {
    if (name === 'preferenceProfileStore') return { result: { success: true, profile: null } }
    if (name === 'aiRoutePlanner') return { result: { success: true, plan: {
      candidates: [{ waypoints: [{ poiId: poi.poiId }] }, { waypoints: [{ poiId: alternative.poiId }] }]
    } } }
    if (name === 'mapProvider' && data.action === 'nearbyPois') return { result: {
      success: true, poisByCategory: { park: [poi, alternative], water: [], shoppingStreet: [] }
    } }
    return { result: await handler(data) }
  })

  const session = createRoutePlanningSession({ start, verifiedWaypointPool: [poi] })
  const order = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }
  await expect(session.evaluateRouteOrder(order)).resolves.toMatchObject({ error: 'PROVIDER_GATEWAY_FAILED' })
  expect(session.getCachedSegmentCosts()).toEqual([])
  await session.evaluateRouteOrder(order)
  expect(request).toHaveBeenCalledTimes(1) // Preserve request-local deduplication.

  request.mockClear()
  wx.cloud.callFunction.mockClear()
  await expect(generateRoutes({ durationMinutes: 30, routeType: 'point_to_point' }))
    .rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' })
  expect(wx.cloud.callFunction.mock.calls.map(([{ name, data }]) => data.action || name))
    .toEqual(['nearbyPois', 'refreshProfile', 'aiRoutePlanner', 'walkingRoute'])
  expect(request).toHaveBeenCalledTimes(1)
})

test.each([{ status: 378 }, { status: 0, result: { routes: [] } }])(
  'explicit no-route result %p still becomes a deterministic failed edge', async data => {
    const request = jest.fn(async () => ({ data }))
    const handler = gateway(request)
    wx.cloud.callFunction.mockImplementation(async ({ data }) => ({ result: await handler(data) }))
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: [poi] })
    await expect(session.evaluateRouteOrder({ allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }))
      .resolves.toMatchObject({ failedSegment: { causeCode: 'ROUTE_NOT_FOUND' } })
    expect(session.getCachedSegmentCosts()).toEqual([expect.objectContaining({ success: false })])
  }
)
