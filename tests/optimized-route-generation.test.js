jest.mock('../miniprogram/services/location', () => ({ getCurrentLocation: jest.fn() }))
jest.mock('../miniprogram/services/cloud-function-client', () => ({ callCloudFunction: jest.fn() }))
jest.mock('../miniprogram/services/walking-segment', () => ({ getWalkingSegment: jest.fn() }))

const { getCurrentLocation } = require('../miniprogram/services/location')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const { generateRoutes, buildOptimizedCandidateRoute } = require('../miniprogram/services/route-generation')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache')

const location = { latitude: 30, longitude: 120 }
const pois = ['A', 'B', 'C', 'D', 'E'].map((poiId, index) => ({
  poiId, name: poiId, latitude: 30 + index / 100, longitude: 120, category: 'park'
}))
const candidates = ['B', 'C', 'D', 'E'].map(id => ({ waypoints: [{ poiId: id }, { poiId: 'A' }] }))
const preferences = { durationMinutes: 45, routeType: 'point_to_point' }

function cloudPlan(plan) {
  callCloudFunction.mockImplementation(async name => name === 'getNearbyPois'
    ? { poisByCategory: { park: pois } }
    : { plan })
}

beforeEach(() => {
  jest.resetAllMocks()
  getCurrentLocation.mockResolvedValue(location)
  cloudPlan({ candidates })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 100, distanceMeters: 200,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))
})

test('initial routes and replacements optimize sets and share all cached segments', async () => {
  const result = await generateRoutes(preferences)
  expect(result.status).toBe('success')
  expect(result.routes).toHaveLength(3)
  const first = result.routes[0]
  expect(first.candidateWaypointIds).toEqual(['B', 'A'])
  expect(first.recommendedWaypointIds).toEqual(['A', 'B'])
  expect(first.routeOrder).toEqual({ orderedWaypointIds: ['A', 'B'], source: 'optimized' })
  expect(first.pointsOfInterest.map(p => p.poiId)).toEqual(['A', 'B'])
  expect(first.endPoint.name).toBe('B')
  expect(first.durationSeconds).toBe(200)
  expect(first.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 2, targetErrorSeconds: 2500 })
  expect(getWalkingSegment).toHaveBeenCalledTimes(10)
  const cache = result.waypointCandidateCache
  const candidate = cache.getUnusedCandidates()[0]
  expect(candidate.waypointIds).toEqual(['E', 'A'])
  const replacement = await buildOptimizedCandidateRoute({
    session: result.routePlanningSession, candidateCache: cache, candidate,
    location, candidateIndex: 3, requestedDurationMinutes: 45
  })
  expect(replacement.route.recommendedWaypointIds).toEqual(['A', 'E'])
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
  expect(callCloudFunction.mock.calls.map(([name]) => name)).toEqual(['getNearbyPois', 'aiRoutePlanner'])
  expect(cache.getAllCandidates().every(entry => entry.status === 'success')).toBe(true)
  expect(cache.getAllCandidates()[3]).toMatchObject({
    waypointIds: ['E', 'A'], route: { optimization: replacement.route.optimization }
  })
  await result.routePlanningSession.buildRouteForOrder({
    allowedWaypointIds: ['B', 'A'], orderedWaypointIds: ['B', 'A']
  })
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
})

test('explicit empty plan returns empty without walking requests', async () => {
  cloudPlan({ candidates: [] })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_WAYPOINT_CANDIDATES' })
  expect(getWalkingSegment).not.toHaveBeenCalled()
})

test('defensive zero-point candidate never creates a successful route', async () => {
  cloudPlan({ candidates: [{ waypoints: [] }] })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).not.toHaveBeenCalled()
})

test('malformed plans and AI provider failures remain errors', async () => {
  cloudPlan({ candidates: null })
  await expect(generateRoutes(preferences)).rejects.toMatchObject({ code: 'INVALID_AI_ROUTE_PLAN' })
  callCloudFunction.mockImplementation(async name => {
    if (name === 'getNearbyPois') return { poisByCategory: { park: pois } }
    throw Object.assign(new Error('Unavailable'), { code: 'AI_REQUEST_FAILED' })
  })
  await expect(generateRoutes(preferences)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
})

test('failed walking segments produce empty and stay cached across candidates', async () => {
  getWalkingSegment.mockResolvedValue({ success: false, error: 'UNREACHABLE' })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
})

test('a candidate is claimed once, including concurrent service calls', async () => {
  const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
  const cache = createWaypointCandidateCache(candidates)
  const options = { session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 }
  const [first, second] = await Promise.all([
    buildOptimizedCandidateRoute(options), buildOptimizedCandidateRoute(options)
  ])
  expect(first.success).toBe(true)
  expect(second).toEqual({ success: false, error: 'CANDIDATE_NOT_UNUSED' })
  expect(cache.getAllCandidates()[0].status).toBe('success')
  expect(getWalkingSegment).toHaveBeenCalledTimes(4)
})

test('unexpected evaluation exceptions settle the candidate instead of leaving it building', async () => {
  const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
  jest.spyOn(session, 'evaluateRouteOrder').mockRejectedValue(new Error('unexpected'))
  const cache = createWaypointCandidateCache(candidates)
  await expect(buildOptimizedCandidateRoute({ session, candidateCache: cache,
    candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 })).rejects.toThrow('unexpected')
  expect(cache.getAllCandidates()[0].status).toBe('failed')
})
