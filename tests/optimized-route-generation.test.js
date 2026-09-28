// Synthetic tests skip real-time pacing; fake-timer tests cover production intervals.
jest.mock('../miniprogram/config/route-planning', () => ({
  ...jest.requireActual('../miniprogram/config/route-planning'), WALKING_PROVIDER_MIN_INTERVAL_MS: 0
}))

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
    success: true, durationSeconds: 1350, distanceMeters: 200,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))
})

test('initial routes and replacements optimize sets and share all cached segments', async () => {
  const result = await generateRoutes(preferences)
  expect(result.status).toBe('success')
  expect(result.routes).toHaveLength(1)
  expect(getWalkingSegment).toHaveBeenCalledTimes(4)
  for (const candidate of result.waypointCandidateCache.getUnusedCandidates().slice(0, 2)) {
    const next = await buildOptimizedCandidateRoute({
      session: result.routePlanningSession, candidateCache: result.waypointCandidateCache,
      candidate, location, candidateIndex: Number(candidate.candidateId.split('-').pop()) - 1,
      requestedDurationMinutes: 45
    })
    result.routes.push(next.route)
  }
  expect(result.routes).toHaveLength(3)
  const first = result.routes[0]
  expect(first.candidateWaypointIds).toEqual(['B', 'A'])
  expect(first.recommendedWaypointIds).toEqual(['A', 'B'])
  expect(first.routeOrder).toEqual({ orderedWaypointIds: ['A', 'B'], source: 'optimized' })
  expect(first.pointsOfInterest.map(p => p.poiId)).toEqual(['A', 'B'])
  expect(first.endPoint.name).toBe('B')
  expect(first.durationSeconds).toBe(2700)
  expect(first.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 2, targetErrorSeconds: 0 })
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

test('explicit empty AI plan uses a validated deterministic fallback without repeating location or POI search', async () => {
  cloudPlan({ candidates: [] })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(result.routes).toHaveLength(1)
  expect(getCurrentLocation).toHaveBeenCalledTimes(1)
  expect(callCloudFunction.mock.calls.map(([name]) => name))
    .toEqual(['getNearbyPois', 'aiRoutePlanner'])
  expect(result.waypointCandidateCache.getUnusedCandidates()).toHaveLength(0)
})

test('initial generation skips a failed candidate and returns the next success before later candidates', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => from.nodeId === 'B' || to.nodeId === 'B'
    ? { success: false, error: 'ROUTE_NOT_FOUND' }
    : { success: true, durationSeconds: 1350, distanceMeters: 200, polyline: [from, to] })
  const result = await generateRoutes(preferences)
  expect(result.routes).toHaveLength(1)
  expect(result.routes[0].candidateWaypointIds).toEqual(['C', 'A'])
  expect(result.waypointCandidateCache.getAllCandidates().map(entry => entry.status))
    .toEqual(['failed', 'success', 'unused', 'unused'])
})

test('rejects a candidate outside the requested duration range and tries the next candidate', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => {
    const touchesB = from.nodeId === 'B' || to.nodeId === 'B'
    return {
      success: true, durationSeconds: touchesB ? 100 : 1350, distanceMeters: 200,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
    }
  })

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('ai')
  expect(result.routes).toHaveLength(1)
  expect(result.routes[0].candidateWaypointIds).toEqual(['C', 'A'])
  expect(result.routes[0].durationSeconds).toBe(2700)
  expect(result.waypointCandidateCache.getAllCandidates().map(entry => entry.status))
    .toEqual(['failed', 'success', 'unused', 'unused'])
})

test('falls back after every AI candidate fails and validates the fallback route', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => {
    if (from.nodeId === 'START' && to.nodeId === 'A') {
      return {
        success: true, durationSeconds: 2700, distanceMeters: 1000,
        polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
      }
    }

    return { success: false, error: 'ROUTE_NOT_FOUND' }
  })

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(result.routes).toHaveLength(1)
  expect(result.waypointCandidateCache.getUnusedCandidates()).toHaveLength(0)
})

test('route-build failures emit their stage and directed edge instead of bypassing the diagnostic log', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
    const failedSegment = { from: 'A', to: 'B', error: 'WALKING_SEGMENT_FAILED', causeCode: 'ROUTE_NOT_FOUND' }
    jest.spyOn(session, 'buildRouteForOrder').mockResolvedValue({ success: false, error: 'MULTI_SEGMENT_ROUTE_FAILED', failedSegment })
    const cache = createWaypointCandidateCache(candidates)
    await buildOptimizedCandidateRoute({ session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 })
    expect(warn).toHaveBeenCalledWith('[Route Generation] Candidate failed:', expect.objectContaining({
      stage: 'route_build', failedSegment, optimization: expect.objectContaining({ strategy: 'exact' })
    }))
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('latitude')
    expect(logged).not.toContain('polyline')
  } finally { warn.mockRestore() }
})

test('exhausted rate limiting produces a temporary generation error, not an empty geographic result', async () => {
  jest.useFakeTimers()
  try {
    getWalkingSegment.mockResolvedValue({ success: false, error: 'AMAP_RATE_LIMITED' })
    const assertion = expect(generateRoutes(preferences)).rejects.toMatchObject({ code: 'AMAP_RATE_LIMITED' })
    await jest.runAllTimersAsync()
    await assertion
  } finally { jest.useRealTimers() }
})

test('defensive zero-point candidate never creates a successful route', async () => {
  cloudPlan({ candidates: [{ waypoints: [] }] })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(1)
})

test('malformed AI plan uses the deterministic fallback', async () => {
  cloudPlan({ candidates: null })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
})

test('AI provider failure uses the deterministic fallback', async () => {
  callCloudFunction.mockImplementation(async name => {
    if (name === 'getNearbyPois') return { poisByCategory: { park: pois } }
    throw Object.assign(new Error('Unavailable'), { code: 'AI_REQUEST_FAILED' })
  })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(getCurrentLocation).toHaveBeenCalledTimes(1)
  expect(callCloudFunction.mock.calls.map(([name]) => name))
    .toEqual(['getNearbyPois', 'aiRoutePlanner'])
})

test('fallback also fails safely instead of exposing an invalid route', async () => {
  cloudPlan({ candidates: [] })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 100, distanceMeters: 200,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  expect(await generateRoutes(preferences))
    .toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE' })
})

test('failed walking segments produce empty and stay cached across candidates', async () => {
  getWalkingSegment.mockResolvedValue({ success: false, error: 'UNREACHABLE' })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(14)
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