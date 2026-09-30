const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const { createOrderPriorityEstimator } = require('../miniprogram/services/waypoint-order-priority')
const { createStartNode, createDirectedEdgeKey, buildTraversalNodes, buildEdgePairs } = require('../miniprogram/services/route-graph')
const config = require('../miniprogram/config/route-planning')

const start = { latitude: 30, longitude: 120 }
const pool = Array.from({ length: 8 }, (_, index) => ({
  poiId: String.fromCharCode(65 + index), name: `Point ${index}`,
  latitude: 30 + (index + 1) * 0.00001, longitude: 120
}))
const ids = pool.slice(0, 5).map(point => point.poiId)

function fixture({ routeType = 'point_to_point', costs = {}, fallback = 10, waypointPool = pool } = {}) {
  const resolver = jest.fn(async (from, to) => {
    const key = `${from.nodeId}->${to.nodeId}`
    const cost = Object.hasOwn(costs, key) ? costs[key] : fallback
    if (cost === null) return { success: false, error: 'UNREACHABLE' }
    return { success: true, durationSeconds: cost, distanceMeters: cost * 2,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude })) }
  })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: waypointPool, routeType, segmentResolver: resolver })
  return { session, resolver }
}

function estimateWith(session, allowed = ids, target = null) {
  return createOrderPriorityEstimator(session.getWaypointSearchData(allowed), session.getCachedSegmentCosts(), target)
}

test.each([
  ['point_to_point', 30, 53], ['loop', 70, 54], ['out_and_back', 34, 113]
])('cached directed priority matches complete %s topology including reversed edges', async (routeType, ab, ba) => {
  const { session, resolver } = fixture({ routeType, costs: {
    'START->A': 10, 'A->B': 20, 'START->B': 50, 'B->A': 3, 'A->START': 1, 'B->START': 40
  } })
  for (const order of [['A', 'B'], ['B', 'A']]) {
    await session.evaluateRouteOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: order })
  }
  const calls = resolver.mock.calls.length
  const estimate = estimateWith(session, ['A', 'B'], 60)
  expect(estimate(['A', 'B'])).toEqual({ failedEdgeCount: 0, durationSeconds: ab, distanceMeters: ab * 2, targetErrorSeconds: Math.abs(ab - 60) })
  expect(estimate(['B', 'A'])).toEqual({ failedEdgeCount: 0, durationSeconds: ba, distanceMeters: ba * 2, targetErrorSeconds: Math.abs(ba - 60) })
  expect(resolver).toHaveBeenCalledTimes(calls)
})

test('real cached duration/distance override close geometry, while reverse edges stay independent', async () => {
  const { session, resolver } = fixture({ costs: { 'C->D': 1000 } })
  const emptyEstimate = estimateWith(session)
  expect(emptyEstimate(ids).durationSeconds).toBeLessThan(10)
  await session.evaluateRouteOrder({ allowedWaypointIds: ids, orderedWaypointIds: ids })
  const estimate = estimateWith(session)
  expect(estimate(ids)).toMatchObject({ durationSeconds: 1040, distanceMeters: 2080 })
  expect(estimate(['E', 'D', 'C', 'B', 'A']).durationSeconds).toBeLessThan(10)
  // Fixed snapshots remain unchanged after new facts arrive.
  expect(emptyEstimate(ids).durationSeconds).toBeLessThan(10)
  expect(resolver).toHaveBeenCalledTimes(5)
})

test('an expensive late edge is avoided before low-value moves near the front of the array', async () => {
  const { session } = fixture({ costs: { 'C->D': 1000 } })
  await session.evaluateRouteOrder({ allowedWaypointIds: ids, orderedWaypointIds: ids })
  const evaluate = jest.spyOn(session, 'evaluateRouteOrder')
  await optimizeWaypointOrder({ session, waypointIds: ids })
  const visited = evaluate.mock.calls.map(([options]) => options.orderedWaypointIds)
  expect(visited.slice(0, 2)).toEqual([ids, [...ids].reverse()])
  const firstMove = visited[2]
  const hasExpensiveEdge = firstMove.some((id, i) => id === 'C' && firstMove[i + 1] === 'D')
  expect(hasExpensiveEdge).toBe(false)
  expect(firstMove).not.toEqual(['B', 'A', 'C', 'D', 'E'])
})

test.each(['point_to_point', 'loop', 'out_and_back'])('same cold facts produce identical %s evaluation order and recommendation', async routeType => {
  async function run(order) {
    const { session, resolver } = fixture({ routeType, costs: { 'C->D': 1000, 'D->C': 7 } })
    expect(session.getCachedSegmentCosts()).toEqual([])
    const evaluate = jest.spyOn(session, 'evaluateRouteOrder')
    const result = await optimizeWaypointOrder({ session, waypointIds: order, requestedDurationMinutes: 2 })
    return { result, visited: evaluate.mock.calls.map(([options]) => options.orderedWaypointIds),
      edges: resolver.mock.calls.map(([from, to]) => createDirectedEdgeKey(from, to)) }
  }
  expect(await run(ids)).toEqual(await run([...ids].reverse()))
})

test.each(['point_to_point', 'loop', 'out_and_back'])('8-point %s prioritization fetches only edges required by evaluated orders', async routeType => {
  const { session, resolver } = fixture({ routeType })
  const allowed = pool.map(point => point.poiId)
  const evaluate = jest.spyOn(session, 'evaluateRouteOrder')
  const prefetch = jest.spyOn(session, 'prefetchSegments')
  const result = await optimizeWaypointOrder({ session, waypointIds: allowed })
  const visited = evaluate.mock.calls.map(([options]) => options.orderedWaypointIds)
  const requiredEdges = new Set()
  for (const order of visited) {
    const nodes = order.map(id => ({ ...pool.find(point => point.poiId === id), nodeId: id, nodeType: 'waypoint' }))
    for (const [from, to] of buildEdgePairs(buildTraversalNodes(createStartNode(start), nodes, routeType))) {
      requiredEdges.add(createDirectedEdgeKey(from, to))
    }
  }
  const actualEdges = resolver.mock.calls.map(([from, to]) => createDirectedEdgeKey(from, to))
  expect(new Set(actualEdges)).toEqual(requiredEdges)
  expect(actualEdges.length).toBe(requiredEdges.size)
  expect(prefetch).not.toHaveBeenCalled()
  expect(new Set(visited.map(order => JSON.stringify(order))).size).toBe(visited.length)
  expect(result.optimization.evaluatedOrderCount).toBeLessThanOrEqual(config.ORDERING_MAX_EVALUATIONS)
  expect(result.optimization.improvementRounds).toBeLessThanOrEqual(config.ORDERING_MAX_ROUNDS)
  expect(result.optimization.seedCount).toBeLessThanOrEqual(config.ORDERING_MAX_SEEDS)
})

test('priority generation does not call the provider when actual evaluation is replaced with a stub', async () => {
  const { session, resolver } = fixture()
  jest.spyOn(session, 'evaluateRouteOrder').mockResolvedValue({ success: true, durationSeconds: 10, distanceMeters: 20 })
  await optimizeWaypointOrder({ session, waypointIds: pool.map(point => point.poiId) })
  expect(resolver).not.toHaveBeenCalled()
})

test('cache inspection is isolated, omits pending promises, and preserves in-flight deduplication', async () => {
  let resolveSegment
  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  const resolver = jest.fn((from, to) => new Promise(resolve => {
    resolveSegment = () => resolve({ success: true, durationSeconds: 7, distanceMeters: 11, polyline: [from, to] })
    notifyStarted()
  }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const options = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }
  expect(session.getCachedSegmentCosts()).toEqual([])
  expect(resolver).not.toHaveBeenCalled()
  const first = session.evaluateRouteOrder(options)
  await started
  const second = session.evaluateRouteOrder(options)
  expect(session.getCachedSegmentCosts()).toEqual([])
  resolveSegment()
  await Promise.all([first, second])
  expect(resolver).toHaveBeenCalledTimes(1)
  const snapshot = session.getCachedSegmentCosts()
  expect(snapshot).toEqual([{ edgeKey: JSON.stringify([['start', 'START'], ['waypoint', 'A']]),
    success: true, durationSeconds: 7, distanceMeters: 11 }])
  snapshot[0].durationSeconds = 999
  snapshot.push({ success: false })
  expect(session.getCachedSegmentCosts()).toHaveLength(1)
  expect(session.getCachedSegmentCosts()[0].durationSeconds).toBe(7)
  expect((await session.evaluateRouteOrder(options)).durationSeconds).toBe(7)
  expect(resolver).toHaveBeenCalledTimes(1)
})

test('known failures stay failures in cost snapshots and never trigger inspection refetches', async () => {
  const { session, resolver } = fixture({ costs: { 'A->B': null } })
  await session.evaluateRouteOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] })
  const snapshot = session.getCachedSegmentCosts()
  expect(snapshot.some(cost => cost.success === false)).toBe(true)
  const estimate = estimateWith(session, ['A', 'B'])
  expect(estimate(['A', 'B']).failedEdgeCount).toBe(1)
  expect(estimate(['B', 'A']).failedEdgeCount).toBe(0)
  await session.evaluateRouteOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] })
  expect(resolver).toHaveBeenCalledTimes(2)
})

test('a waypoint named START cannot alias the typed starting node in priority costs', async () => {
  const { session } = fixture({ waypointPool: [{ ...pool[0], poiId: 'START' }, pool[1]], routeType: 'loop' })
  const order = ['START', 'B']
  const evaluated = await session.evaluateRouteOrder({ allowedWaypointIds: order, orderedWaypointIds: order })
  expect(estimateWith(session, order)(order).durationSeconds).toBe(evaluated.durationSeconds)
  expect(session.getCachedSegmentCosts()).toHaveLength(3)
})

test('2-opt priority includes every asymmetric internal reverse edge', async () => {
  const { session } = fixture({ costs: { 'D->C': 100, 'C->B': 200, 'B->A': 300 } })
  const reversed = ['D', 'C', 'B', 'A', 'E']
  for (const order of [ids, reversed]) {
    await session.evaluateRouteOrder({ allowedWaypointIds: ids, orderedWaypointIds: order })
  }
  const estimate = estimateWith(session)
  expect(estimate(ids).durationSeconds).toBe(50)
  expect(estimate(reversed).durationSeconds).toBe(620)
})

test.each([undefined, 2])('final recommendation uses evaluated costs despite misleading priority (target %s)', async requestedDurationMinutes => {
  const { session, resolver } = fixture()
  const visited = []
  jest.spyOn(session, 'evaluateRouteOrder').mockImplementation(async ({ orderedWaypointIds }) => {
    visited.push([...orderedWaypointIds])
    // The first prioritized move is expensive; the following move wins under
    // either objective. A later, shorter route must lose with a duration target.
    const index = visited.length - 1
    const durationSeconds = index === 2 ? 1000 : index === 3 ? 120 : 200
    return { success: true, durationSeconds: requestedDurationMinutes && index === 4 ? 1 : durationSeconds, distanceMeters: 10 }
  })
  const result = await optimizeWaypointOrder({ session, waypointIds: ids, requestedDurationMinutes })
  expect(visited.length).toBeGreaterThan(4)
  expect(result.recommendedWaypointIds).toEqual(visited[3])
  expect(result.recommendedWaypointIds).not.toEqual(visited[2])
  expect(result.optimization.durationSeconds).toBe(120)
  expect(resolver).not.toHaveBeenCalled()
})
