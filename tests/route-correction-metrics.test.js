// The shared RoutePlanningSession must report actual resolver invocations,
// not count in-flight Promise reuse as additional Tencent map requests.
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { ROUTE_TYPES } = require('../miniprogram/constants/route-types')

test('safe route metrics distinguish directed resolver calls from Promise-cache hits', async () => {
  const start = { latitude: 45.5, longitude: -73.6 }
  const poi = { poiId: 'A', name: 'A', category: 'park', latitude: 45.501, longitude: -73.601 }
  const resolver = jest.fn(async (from, to) => ({
    success: true, durationSeconds: 600, distanceMeters: 900,
    polyline: [from, to].map(point => ({ latitude: point.latitude, longitude: point.longitude }))
  }))
  const session = createRoutePlanningSession({
    start, verifiedWaypointPool: [poi], routeType: ROUTE_TYPES.LOOP,
    segmentResolver: resolver
  })
  const request = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }
  const built = await session.buildRouteForOrder(request)
  expect(built.success).toBe(true)
  const first = session.getPlanningDiagnostics()
  expect(first).toEqual({
    segmentResolverCalls: 2, segmentCacheHits: 0, settledSegmentCosts: 2
  })
  const again = await session.evaluateRouteOrder(request)
  expect(again.success).toBe(true)
  expect(session.getPlanningDiagnostics()).toEqual({
    segmentResolverCalls: 2, segmentCacheHits: 2, settledSegmentCosts: 2
  })
  expect(resolver).toHaveBeenCalledTimes(2)
})
