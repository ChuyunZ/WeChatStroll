// #107 release-planning evidence. No Tencent API calls, CloudBase writes or
// production limit changes. This measures the existing Route Engine's logical
// walking-segment calls; provider status-120 retries are additional HTTP starts.
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const { validateGeneratedWalkingRoute } = require('../miniprogram/services/route-validation')

const start = { latitude: 31.23, longitude: 121.47 }
const pool = Array.from({ length: 18 }, (_, i) => ({
  poiId: String.fromCharCode(65 + i),
  name: `Synthetic POI ${i + 1}`,
  category: 'park',
  latitude: 31.2301 + i * 0.0001,
  longitude: 121.4701 + i * 0.0001,
  distanceInMeters: 100 + i * 10
}))

// Five structurally distinct candidates are allowed in one AI batch, and 18
// verified POIs are within the current initial pool boundary. Shared A/B edges
// are intentionally reused for the fifth set to exercise the real Promise cache.
const attemptedSets = [
  ['A', 'B', 'C', 'D'],
  ['E', 'F', 'G', 'H'],
  ['I', 'J', 'K', 'L'],
  ['M', 'N', 'O', 'P'],
  ['A', 'B', 'Q', 'R']
]

function fixture() {
  const resolver = jest.fn(async (from, to) => ({
    success: true,
    distanceMeters: 800,
    durationSeconds: 600,
    polyline: [
      { latitude: from.latitude, longitude: from.longitude },
      { latitude: to.latitude, longitude: to.longitude }
    ]
  }))
  const session = createRoutePlanningSession({
    start, verifiedWaypointPool: pool, routeType: 'loop', segmentResolver: resolver
  })
  return { session, resolver }
}

async function tryCandidate(session, ids) {
  const optimized = await optimizeWaypointOrder({
    session, waypointIds: ids, requestedDurationMinutes: 30
  })
  expect(optimized.success).toBe(true)
  const built = await session.buildRouteForOrder({
    allowedWaypointIds: ids,
    orderedWaypointIds: optimized.recommendedWaypointIds,
    source: 'recommended'
  })
  expect(built.success).toBe(true)
  // Each complete synthetic loop is 5 x 600s: a route-engine success but a
  // genuine duration rejection, so the normal caller may try the next set.
  expect(validateGeneratedWalkingRoute(built, {
    allowedWaypointIds: ids, requestedDurationMinutes: 30
  })).toMatchObject({ valid: false, reason: 'ROUTE_DURATION_OUT_OF_RANGE' })
}

test('existing session metrics count real resolver invocations across failed candidates and cache hits', async () => {
  const { session, resolver } = fixture()
  const counts = []
  for (const ids of attemptedSets) {
    await tryCandidate(session, ids)
    const { segmentResolverCalls } = session.getPlanningDiagnostics()
    expect(segmentResolverCalls).toBe(resolver.mock.calls.length)
    counts.push(segmentResolverCalls)
  }
  // Five legitimate candidate attempts from one verified 18-POI pool. Four
  // disjoint four-waypoint loops need 20 directed edges each; the fifth needs
  // only 14 new edges thanks to cached A/B facts. 90 is NOT a hard ceiling.
  expect(counts).toEqual([20, 40, 60, 80, 94])
  expect(counts[2]).toBeLessThan(90)
  expect(counts[4]).toBeGreaterThan(90)
  const callsBeforeReuse = resolver.mock.calls.length
  await tryCandidate(session, attemptedSets[0])
  expect(resolver).toHaveBeenCalledTimes(callsBeforeReuse)
  expect(session.getPlanningDiagnostics().segmentCacheHits).toBeGreaterThan(0)
})

test.each(['point_to_point', 'loop', 'out_and_back'])(
  'four-waypoint prefetch measures directed edges for %s, without double counting cache reuse',
  async routeType => {
    const { resolver } = fixture()
    const session = createRoutePlanningSession({
      start, verifiedWaypointPool: pool, routeType, segmentResolver: resolver
    })
    const ids = attemptedSets[0]
    const prefetch = await session.prefetchSegments(ids)
    const expected = routeType === 'point_to_point' ? 16 : 20
    expect(prefetch).toMatchObject({ prefetched: true, edgeCount: expected })
    expect(session.getPlanningDiagnostics().segmentResolverCalls).toBe(expected)
    await session.prefetchSegments(ids)
    expect(resolver).toHaveBeenCalledTimes(expected)
  }
)
