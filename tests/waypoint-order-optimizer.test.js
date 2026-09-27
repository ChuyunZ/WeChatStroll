const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const config = require('../miniprogram/config/route-planning')

const start = { latitude: 30, longitude: 120 }
const pool = Array.from({ length: 9 }, (_, index) => ({
  poiId: String.fromCharCode(65 + index), name: `Place ${index}`,
  latitude: 30 + (index + 1) / 100, longitude: 120
}))

function fixture({ routeType = 'point_to_point', costs = {}, fallback = 100 } = {}) {
  const resolver = jest.fn(async (from, to) => {
    const key = `${from.nodeId}->${to.nodeId}`
    const cost = Object.hasOwn(costs, key) ? costs[key] : fallback
    if (cost === null) return { success: false, error: 'UNREACHABLE' }
    return {
      success: true, durationSeconds: cost, distanceMeters: cost * 2,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
    }
  })
  const session = createRoutePlanningSession({
    start, verifiedWaypointPool: pool, routeType, segmentResolver: resolver
  })
  return { session, resolver }
}

test.each([0, 1, 2, 3])('exact search handles %i waypoints', async count => {
  const { session, resolver } = fixture()
  const ids = pool.slice(0, count).map(p => p.poiId).reverse()
  const result = await optimizeWaypointOrder({ session, waypointIds: ids })
  if (!count) {
    expect(result).toEqual({ success: false, error: 'NO_WAYPOINTS' })
    expect(resolver).not.toHaveBeenCalled()
    return
  }
  expect(result.success).toBe(true)
  expect(result.recommendedWaypointIds).toEqual([...ids].sort())
  expect(result.optimization).toMatchObject({
    strategy: 'exact', evaluatedOrderCount: [0, 1, 2, 6][count],
    durationSeconds: count * 100, targetErrorSeconds: null
  })
})

test.each([
  ['point_to_point', 30, 53],
  ['loop', 70, 54],
  ['out_and_back', 34, 113]
])('evaluation counts every directed edge for %s', async (routeType, ab, ba) => {
  const { session } = fixture({ routeType, costs: {
    'START->A': 10, 'A->B': 20, 'START->B': 50, 'B->A': 3,
    'A->START': 1, 'B->START': 40
  } })
  for (const [order, expected] of [[['A', 'B'], ab], [['B', 'A'], ba]]) {
    const options = { allowedWaypointIds: ['A', 'B'], orderedWaypointIds: order }
    const evaluation = await session.evaluateRouteOrder(options)
    const built = await session.buildRouteForOrder(options)
    expect(evaluation).toEqual({ success: true, durationSeconds: expected, distanceMeters: expected * 2 })
    expect(built.durationSeconds).toBe(expected)
    expect(evaluation.polyline).toBeUndefined()
  }
  const result = await optimizeWaypointOrder({ session, waypointIds: ['B', 'A'] })
  expect(result.recommendedWaypointIds).toEqual(ab < ba ? ['A', 'B'] : ['B', 'A'])
})

test('target duration is a soft objective and uses seconds rather than rounded minutes', async () => {
  const { session } = fixture({ costs: {
    'START->A': 900, 'A->B': 900, 'START->B': 1320, 'B->A': 1320
  } })
  const options = { session, waypointIds: ['A', 'B'] }
  expect((await optimizeWaypointOrder(options)).recommendedWaypointIds).toEqual(['A', 'B'])
  const target = await optimizeWaypointOrder({ ...options, requestedDurationMinutes: 45 })
  expect(target.recommendedWaypointIds).toEqual(['B', 'A'])
  expect(target.optimization.targetErrorSeconds).toBe(60)

  const seconds = fixture({ costs: { 'START->A': 61, 'A->B': 60, 'START->B': 60, 'B->A': 60 } })
  expect((await optimizeWaypointOrder({ session: seconds.session, waypointIds: ['A', 'B'],
    requestedDurationMinutes: 121 / 60 })).recommendedWaypointIds).toEqual(['A', 'B'])
})

test('target ties prefer shorter duration, then distance, then canonical ID sequence', async () => {
  const { session } = fixture({ costs: { 'START->A': 11, 'START->B': 9 }, fallback: 0 })
  expect((await optimizeWaypointOrder({ session, waypointIds: ['A', 'B'],
    requestedDurationMinutes: 10 / 60 })).recommendedWaypointIds).toEqual(['B', 'A'])
  const equal = fixture()
  const evaluate = equal.session.evaluateRouteOrder.bind(equal.session)
  jest.spyOn(equal.session, 'evaluateRouteOrder').mockImplementation(async options => ({
    ...await evaluate(options), distanceMeters: options.orderedWaypointIds[0] === 'B' ? 1 : 2
  }))
  expect((await optimizeWaypointOrder({ session: equal.session, waypointIds: ['A', 'B'] }))
    .recommendedWaypointIds).toEqual(['B', 'A'])
})

test('a failed prefetched edge only invalidates orders that need it; final builds reuse cache', async () => {
  const { session, resolver } = fixture({ costs: { 'A->B': null } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B'] })
  expect(result.recommendedWaypointIds).toEqual(['B', 'A'])
  expect(resolver).toHaveBeenCalledTimes(4)
  await session.buildRouteForOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['B', 'A'] })
  await session.buildRouteForOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] })
  await optimizeWaypointOrder({ session, waypointIds: ['A'] })
  expect(resolver).toHaveBeenCalledTimes(4)
})

test.each([1, 3, 8])('all failures count toward evaluations with an accurate reason (%i points)', async count => {
  const { session, resolver } = fixture({ fallback: null })
  const result = await optimizeWaypointOrder({ session, waypointIds: pool.slice(0, count).map(p => p.poiId) })
  expect(result.success).toBe(false)
  expect(result.error).toBe(count <= 3 ? 'NO_FEASIBLE_ORDER' : 'SEARCH_NO_FEASIBLE_ORDER_FOUND')
  expect(result.optimization.evaluatedOrderCount).toBe(count === 1 ? 1 : count === 3 ? 6 : 24)
  const edges = resolver.mock.calls.map(([from, to]) => JSON.stringify([from.nodeId, to.nodeId]))
  expect(new Set(edges).size).toBe(edges.length)
})

test.each([4, 5, 6, 7, 8])('heuristic search is deterministic, bounded and preserves all %i points', async count => {
  const { session } = fixture()
  const ids = pool.slice(0, count).map(p => p.poiId)
  const evaluate = jest.spyOn(session, 'evaluateRouteOrder')
  const first = await optimizeWaypointOrder({ session, waypointIds: [...ids].reverse() })
  expect(first.success).toBe(true)
  expect([...first.recommendedWaypointIds].sort()).toEqual(ids)
  expect(first.optimization.strategy).toBe('heuristic')
  expect(first.optimization.evaluatedOrderCount).toBeLessThanOrEqual(config.ORDERING_MAX_EVALUATIONS)
  expect(first.optimization.improvementRounds).toBeLessThanOrEqual(config.ORDERING_MAX_ROUNDS)
  // Nearest-neighbor equals canonical here, so the duplicate seed is removed.
  expect(first.optimization.seedCount).toBe(2)
  const visited = evaluate.mock.calls.map(([options]) => JSON.stringify(options.orderedWaypointIds))
  expect(new Set(visited).size).toBe(visited.length)
  expect(first.optimization.evaluatedOrderCount).toBe(visited.length)
  expect(await optimizeWaypointOrder({ session, waypointIds: ids })).toEqual(first)
})

test('search explores variants even if every seed is unreachable', async () => {
  const { session } = fixture({ fallback: null, costs: {
    'START->B': 10, 'B->A': 10, 'A->C': 10, 'C->D': 10
  } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['D', 'C', 'B', 'A'] })
  expect(result.success).toBe(true)
  expect(result.recommendedWaypointIds).toEqual(['B', 'A', 'C', 'D'])
})

test('heuristic moves improve feasible seeds using real walking costs', async () => {
  const { session } = fixture({ costs: {
    'START->B': 1, 'B->A': 1, 'A->C': 1, 'C->D': 1
  } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B', 'C', 'D'] })
  expect(result.recommendedWaypointIds).toEqual(['B', 'A', 'C', 'D'])
  expect(result.optimization.durationSeconds).toBe(4)
})

test('three-point optimum can differ from AI order and coordinate proximity', async () => {
  const { session } = fixture({ costs: { 'START->C': 1, 'C->A': 1, 'A->B': 1 } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B', 'C'] })
  expect(result.recommendedWaypointIds).toEqual(['C', 'A', 'B'])
  expect(result.optimization).toMatchObject({ durationSeconds: 3, evaluatedOrderCount: 6 })
})

test('ID sequence tie-breaking is unambiguous for IDs containing delimiters', async () => {
  const ids = ['a,b', 'a']
  const session = createRoutePlanningSession({ start,
    verifiedWaypointPool: ids.map((poiId, index) => ({ ...pool[index], poiId })),
    segmentResolver: async (from, to) => ({
      success: true, durationSeconds: 1, distanceMeters: 1, polyline: [from, to]
    })
  })
  const result = await optimizeWaypointOrder({ session, waypointIds: ids })
  expect(result.recommendedWaypointIds).toEqual(['a', 'a,b'])
})

test('engine evaluation rejects invalid scope/order with the same validation as rendering', async () => {
  const { session, resolver } = fixture()
  for (const options of [
    { allowedWaypointIds: ['A'], orderedWaypointIds: ['B'] },
    { allowedWaypointIds: ['A'], orderedWaypointIds: ['A', 'A'] },
    { allowedWaypointIds: ['unknown'], orderedWaypointIds: ['unknown'] }
  ]) {
    const result = await session.evaluateRouteOrder(options)
    expect(result.success).toBe(false)
    expect(result).toEqual(await session.buildRouteForOrder(options))
  }
  expect(resolver).not.toHaveBeenCalled()
})

test.each([undefined, null, 'A', ['A', 'A'], ['unknown'], [4], [' '],
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']])('rejects invalid waypoint input %j before fetching', async waypointIds => {
  const { session, resolver } = fixture()
  expect((await optimizeWaypointOrder({ session, waypointIds })).success).toBe(false)
  expect(resolver).not.toHaveBeenCalled()
})

test.each([NaN, Infinity, -1, 0, null, '45', Number.MAX_VALUE])('rejects invalid duration %j', async duration => {
  const { session, resolver } = fixture()
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A'], requestedDurationMinutes: duration })
  expect(result.error).toBe('INVALID_REQUESTED_DURATION')
  expect(resolver).not.toHaveBeenCalled()
})

test('trusted coordinate snapshots cannot mutate session data', () => {
  const { session } = fixture()
  const data = session.getWaypointSearchData(['A'])
  data.start.latitude = 0
  data.waypoints[0].latitude = 0
  expect(session.getWaypointSearchData(['A']).start).toEqual(start)
  expect(session.getWaypointSearchData(['A']).waypoints[0].latitude).toBe(pool[0].latitude)
  expect(() => createRoutePlanningSession({ start, verifiedWaypointPool: [{ poiId: 'A', latitude: NaN, longitude: 1 }] }))
    .toThrow()
})

test('exact threshold is configurable for both optimizer and engine prefetch', async () => {
  jest.resetModules()
  jest.doMock('../miniprogram/config/route-planning', () => ({ ...config, EXACT_ORDERING_MAX_WAYPOINTS: 4 }))
  try {
    const { createRoutePlanningSession: createSession } = require('../miniprogram/services/route-engine')
    const { optimizeWaypointOrder: optimize } = require('../miniprogram/services/waypoint-order-optimizer')
    const session = createSession({ start, verifiedWaypointPool: pool, segmentResolver: async () => ({ success: false }) })
    const result = await optimize({ session, waypointIds: ['A', 'B', 'C', 'D'] })
    expect(result.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 24 })
    expect((await session.prefetchSegments(['A', 'B', 'C', 'D'])).prefetched).toBe(true)
  } finally {
    jest.dontMock('../miniprogram/config/route-planning')
    jest.resetModules()
  }
})
