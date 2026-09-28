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

test.each([0, 1, 2, 3, 4])('exact search handles %i waypoints', async count => {
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
    strategy: 'exact', evaluatedOrderCount: [0, 1, 2, 6, 24][count],
    durationSeconds: count * 100, targetErrorSeconds: null,
    evaluationBudget: null, roundEvaluationCounts: [], improvementRounds: 0
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

test.each([1, 3, 4, 5, 8])('all failures use the public error and retain search diagnostics (%i points)', async count => {
  const { session, resolver } = fixture({ fallback: null })
  const result = await optimizeWaypointOrder({ session, waypointIds: pool.slice(0, count).map(p => p.poiId) })
  expect(result.success).toBe(false)
  expect(result.error).toBe('WAYPOINT_ORDER_NOT_FOUND')
  expect(result.optimization.strategy).toBe(count <= 4 ? 'exact' : 'heuristic')
  expect(result.optimization.budgetExhausted).toBe(count > 4)
  expect(result.optimization.evaluatedOrderCount).toBe(count === 1 ? 1 : count === 3 ? 6 : count === 4 ? 24 : 32)
  const edges = resolver.mock.calls.map(([from, to]) => JSON.stringify([from.nodeId, to.nodeId]))
  expect(new Set(edges).size).toBe(edges.length)
})

test.each([5, 6, 7, 8])('heuristic search is deterministic, bounded and preserves all %i points', async count => {
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
  expect(first.optimization.evaluationBudget).toBe(32)
  expect(first.optimization.roundEvaluationCounts.reduce((sum, n) => sum + n, first.optimization.seedCount))
    .toBe(visited.length)
  // Reproducibility requires identical initial cache facts, not the warmed
  // cache left by the first run.
  const repeated = fixture()
  const repeatedEvaluate = jest.spyOn(repeated.session, 'evaluateRouteOrder')
  expect(await optimizeWaypointOrder({ session: repeated.session, waypointIds: ids })).toEqual(first)
  expect(repeatedEvaluate.mock.calls.map(([options]) => JSON.stringify(options.orderedWaypointIds))).toEqual(visited)
})

test('search explores variants even if every seed is unreachable', async () => {
  const { session } = fixture({ fallback: null, costs: {
    'START->B': 10, 'B->A': 10, 'A->C': 10, 'C->D': 10, 'D->E': 10
  } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['E', 'D', 'C', 'B', 'A'] })
  expect(result.success).toBe(true)
  expect(result.recommendedWaypointIds).toEqual(['B', 'A', 'C', 'D', 'E'])
  expect(result.optimization.strategy).toBe('heuristic')
})

test('heuristic moves improve feasible seeds using real walking costs', async () => {
  const { session } = fixture({ costs: {
    'START->B': 1, 'B->A': 1, 'A->C': 1, 'C->D': 1, 'D->E': 1
  } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B', 'C', 'D', 'E'] })
  expect(result.recommendedWaypointIds).toEqual(['B', 'A', 'C', 'D', 'E'])
  expect(result.optimization.durationSeconds).toBe(5)
  expect(result.optimization.strategy).toBe('heuristic')
})

test('three-point optimum can differ from AI order and coordinate proximity', async () => {
  const { session } = fixture({ costs: { 'START->C': 1, 'C->A': 1, 'A->B': 1 } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B', 'C'] })
  expect(result.recommendedWaypointIds).toEqual(['C', 'A', 'B'])
  expect(result.optimization).toMatchObject({ durationSeconds: 3, evaluatedOrderCount: 6 })
})

test.each(['point_to_point', 'loop', 'out_and_back'])('four-point exact prefetch shares cached directed edges for %s', async routeType => {
  const { session, resolver } = fixture({ routeType })
  const ids = ['A', 'B', 'C', 'D']
  const prefetch = await session.prefetchSegments(ids)
  const edgeCount = routeType === 'point_to_point' ? 16 : 20
  expect(prefetch).toMatchObject({ prefetched: true, edgeCount })
  expect(resolver).toHaveBeenCalledTimes(edgeCount)
  const result = await optimizeWaypointOrder({ session, waypointIds: ids })
  expect(result.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 24 })
  await session.buildRouteForOrder({ allowedWaypointIds: ids, orderedWaypointIds: result.recommendedWaypointIds })
  expect(resolver).toHaveBeenCalledTimes(edgeCount)
})

test('four-point exact search finds a known global optimum outside the seeds', async () => {
  const { session } = fixture({ costs: {
    'START->C': 1, 'C->A': 1, 'A->D': 1, 'D->B': 1
  } })
  const result = await optimizeWaypointOrder({ session, waypointIds: ['B', 'A', 'C', 'D'] })
  expect(result.recommendedWaypointIds).toEqual(['C', 'A', 'D', 'B'])
  expect(result.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 24, durationSeconds: 4 })
})

test('heuristic explores a four-element reversal early and scores its directed costs in full', async () => {
  const makeFixture = async () => {
    const setup = fixture({ costs: {
      'START->D': 1, 'D->C': 1, 'C->B': 1, 'B->A': 1, 'A->E': 1
    } })
    // Ordering now uses cached costs: supply the same known reversal facts
    // to each run, rather than relying on the old index exploration sequence.
    await setup.session.evaluateRouteOrder({ allowedWaypointIds: ['A', 'B', 'C', 'D', 'E'],
      orderedWaypointIds: ['D', 'C', 'B', 'A', 'E'] })
    return setup
  }
  const { session } = await makeFixture()
  const ids = ['A', 'B', 'C', 'D', 'E']
  const evaluate = jest.spyOn(session, 'evaluateRouteOrder')
  const result = await optimizeWaypointOrder({ session, waypointIds: ids })
  const visited = evaluate.mock.calls.map(([options]) => options.orderedWaypointIds)
  // D,C,B,A,E reverses the first four points of the nearest/canonical seed.
  // Neither one relocation nor one pair swap can produce this permutation.
  const reversal = ['D', 'C', 'B', 'A', 'E']
  expect(visited).toContainEqual(reversal)
  expect(result.recommendedWaypointIds).toEqual(reversal)
  expect(result.optimization).toMatchObject({ strategy: 'heuristic', durationSeconds: 5 })
  expect(visited.length).toBeLessThanOrEqual(config.ORDERING_MAX_EVALUATIONS)
  expect(new Set(visited.map(order => JSON.stringify(order))).size).toBe(visited.length)
  expect(result.optimization.improvementRounds).toBeLessThanOrEqual(config.ORDERING_MAX_ROUNDS)
  const repeated = await makeFixture()
  const repeatedEvaluate = jest.spyOn(repeated.session, 'evaluateRouteOrder')
  expect(await optimizeWaypointOrder({ session: repeated.session, waypointIds: [...ids].reverse() })).toEqual(result)
  expect(repeatedEvaluate.mock.calls.map(([options]) => options.orderedWaypointIds)).toEqual(visited)
})

test.each([5, 6, 7, 8])('each %i-point neighbor stream is unique, deterministic and leaves its input unchanged', count => {
  // Inspect the private iterator in an isolated module, without exposing a
  // test-only helper in the production API. Evaluation has separate dedup tests.
  const fs = require('node:fs')
  const vm = require('node:vm')
  const { createRequire } = require('node:module')
  const filename = require.resolve('../miniprogram/services/waypoint-order-optimizer')
  const context = { module: { exports: {} }, require: createRequire(filename) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { neighbors, prioritizeNeighbors }', context, { filename })
  const ids = pool.slice(0, count).map(point => point.poiId)
  const original = [...ids]
  const enumerate = () => Array.from(context.module.exports.neighbors(ids), candidate => ({
    ...candidate, order: Array.from(candidate.order)
  }))
  const neighbors = enumerate()
  const keys = neighbors.map(candidate => JSON.stringify(candidate.order))
  expect(new Set(keys).size).toBe(keys.length)
  expect(neighbors.map(candidate => candidate.order)).not.toContainEqual(ids)
  expect(enumerate()).toEqual(neighbors)
  expect(ids).toEqual(original)
  for (const { order } of neighbors) expect([...order].sort()).toEqual(ids)
  const tail = ids.slice(4)
  expect(neighbors.slice(0, 6).map(candidate => candidate.order)).toEqual([
    ['B', 'A', 'C', 'D', ...tail],
    ['B', 'C', 'A', 'D', ...tail],
    ['C', 'B', 'A', 'D', ...tail],
    ['B', 'C', 'D', 'A', ...tail],
    ['D', 'B', 'C', 'A', ...tail],
    ['D', 'C', 'B', 'A', ...tail]
  ])
  expect(neighbors[0]).toMatchObject({ type: 'relocation', fromIndex: 0, toIndex: 1 })
  expect(neighbors.find(candidate => JSON.stringify(candidate.order) === JSON.stringify(['B', 'C', 'A', 'D', ...tail])))
    .toMatchObject({ type: 'relocation', fromIndex: 0, toIndex: 2 })
  expect(neighbors.find(candidate => JSON.stringify(candidate.order) === JSON.stringify(['D', 'C', 'B', 'A', ...tail])))
    .toMatchObject({ type: 'two_opt', fromIndex: 0, toIndex: 3 })
  const tied = context.module.exports.prioritizeNeighbors(ids, () => ({
    failedEdgeCount: 0, targetErrorSeconds: 0, durationSeconds: 10, distanceMeters: 20
  }))
  const typeRank = { relocation: 0, swap: 1, two_opt: 2 }
  const expected = [...neighbors].sort((a, b) => typeRank[a.type] - typeRank[b.type] ||
    a.fromIndex - b.fromIndex || a.toIndex - b.toIndex)
  expect(Array.from(tied, candidate => JSON.stringify(candidate.order)))
    .toEqual(expected.map(candidate => JSON.stringify(candidate.order)))
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
  jest.doMock('../miniprogram/config/route-planning', () => ({ ...config, EXACT_ORDERING_MAX_WAYPOINTS: 3 }))
  try {
    const { createRoutePlanningSession: createSession } = require('../miniprogram/services/route-engine')
    const { optimizeWaypointOrder: optimize } = require('../miniprogram/services/waypoint-order-optimizer')
    const session = createSession({ start, verifiedWaypointPool: pool, segmentResolver: async () => ({ success: false }) })
    const result = await optimize({ session, waypointIds: ['A', 'B', 'C', 'D'] })
    expect(result.optimization.strategy).toBe('heuristic')
    expect(result.optimization.evaluatedOrderCount).toBeLessThanOrEqual(24)
    expect((await session.prefetchSegments(['A', 'B', 'C', 'D'])).prefetched).toBe(false)
  } finally {
    jest.dontMock('../miniprogram/config/route-planning')
    jest.resetModules()
  }
})
