const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const config = require('../miniprogram/config/route-planning')

// Inspect private neighborhoods without adding production test APIs. Optional
// limits let the exhaustion test reach the finite neighborhood's end.
function loadOptimizer(limits = {}) {
  const filename = require.resolve('../miniprogram/services/waypoint-order-optimizer')
  const localRequire = createRequire(filename)
  const context = { module: { exports: {} }, require: name => name === '../config/route-planning'
    ? { ...config, ...limits } : localRequire(name) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports = { optimizeWaypointOrder, neighbors, createSeeds }', context, { filename })
  return context.module.exports
}

const optimizer = loadOptimizer()
const ids = [...'ABCDEFGH']
const key = order => order.join('')

function fixture({ count = 8, score = () => 100, threeSeeds = false } = {}) {
  const allowed = ids.slice(0, count)
  const visited = []
  const snapshots = []
  const searchData = { valid: true, routeType: 'point_to_point', start: { latitude: 30, longitude: 120 },
    waypoints: allowed.map((poiId, i) => ({ poiId, latitude: 30,
      longitude: threeSeeds ? 120 + (i === 0 ? 2 : i === 1 ? 1 : i + 1) * 0.001 : 120 })) }
  const session = {
    getWaypointSearchData: () => searchData,
    prefetchSegments: jest.fn(),
    getCachedSegmentCosts: jest.fn(() => {
      snapshots.push(visited.length)
      return []
    }),
    evaluateRouteOrder: jest.fn(async ({ orderedWaypointIds }) => {
      visited.push(key(orderedWaypointIds))
      const durationSeconds = score(key(orderedWaypointIds))
      return durationSeconds === null ? { success: false, error: 'UNREACHABLE' }
        : { success: true, durationSeconds, distanceMeters: durationSeconds }
    })
  }
  return { session, allowed, visited, snapshots, searchData }
}

test('a second-hop optimum is reached from the improved first-round frontier', async () => {
  const intermediate = 'BCDAEFGH'
  const optimum = 'CDABEFGH'
  const setup = fixture({ score: order => order === optimum ? 1 : order === intermediate ? 50
    : order === 'ABCDEFGH' || order === 'HGFEDCBA' ? 100 : 1000 })
  const seeds = optimizer.createSeeds(setup.searchData)
  for (const seed of seeds) {
    expect(optimizer.neighbors(seed).map(move => key(move.order))).not.toContain(optimum)
  }
  expect(optimizer.neighbors([...intermediate]).map(move => key(move.order))).toContain(optimum)
  const result = await optimizer.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  const firstRound = setup.visited.slice(setup.snapshots[0], setup.snapshots[1])
  const secondRound = setup.visited.slice(setup.snapshots[1], setup.snapshots[2])
  expect(firstRound).toContain(intermediate)
  expect(firstRound).not.toContain(optimum)
  expect(secondRound).toContain(optimum)
  expect(key(result.recommendedWaypointIds)).toBe(optimum)
  expect(result.optimization.improvementRounds).toBe(3)
  expect(result.optimization.evaluatedOrderCount).toBeLessThanOrEqual(32)
})

test.each([false, true])('round quotas count only distinct evaluations, including failures (%s)', async fail => {
  const setup = fixture({ threeSeeds: true, score: () => fail ? null : 100 })
  const result = await optimizer.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  expect(result.optimization).toMatchObject({ seedCount: 3, evaluationBudget: 32,
    evaluatedOrderCount: 32, improvementRounds: 3, roundEvaluationCounts: [10, 10, 9], budgetExhausted: true })
  expect(setup.snapshots).toEqual([3, 13, 23])
  expect(new Set(setup.visited).size).toBe(32)
  expect(setup.session.evaluateRouteOrder).toHaveBeenCalledTimes(32)
  expect(result.success).toBe(!fail)
})

test('round-robin gives both frontiers turns before a second candidate from either', async () => {
  const setup = fixture({ score: () => null })
  await optimizer.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  // All coordinates coincide, so canonical move metadata breaks priority ties.
  expect(setup.visited.slice(0, 8)).toEqual([
    'ABCDEFGH', 'HGFEDCBA',
    'BACDEFGH', 'GHFEDCBA',
    'BCADEFGH', 'GFHEDCBA',
    'BCDAEFGH', 'GFEHDCBA'
  ])
})

test('no improvement does not stop fresh rounds and duplicate neighbors do not reuse quota', async () => {
  const setup = fixture({ score: order => order === 'ABCDEFGH' || order === 'HGFEDCBA' ? 1 : 100 })
  const result = await optimizer.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  expect(key(result.recommendedWaypointIds)).toBe('ABCDEFGH')
  expect(setup.snapshots).toEqual([2, 12, 22])
  expect(result.optimization.roundEvaluationCounts).toEqual([10, 10, 10])
  expect(new Set(setup.visited).size).toBe(32)
  expect(setup.visited.slice(2, 12).every(order => order !== 'ABCDEFGH' && order !== 'HGFEDCBA')).toBe(true)
})

test('a zero-new-evaluation round stops before the remaining round and global limits', async () => {
  const bounded = loadOptimizer({ ORDERING_MAX_EVALUATIONS: 200, ORDERING_MAX_ROUNDS: 10 })
  const setup = fixture({ count: 5 })
  const result = await bounded.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  const counts = result.optimization.roundEvaluationCounts
  expect(counts[counts.length - 1]).toBe(0)
  expect(counts.slice(0, -1).every(count => count > 0)).toBe(true)
  expect(result.optimization.improvementRounds).toBeLessThan(10)
  expect(result.optimization.budgetExhausted).toBe(false)
  expect(result.optimization.evaluatedOrderCount).toBe(counts.reduce((sum, n) => sum + n, 2))
})

test('four-point exact mode ignores even a one-evaluation heuristic budget', async () => {
  const exact = loadOptimizer({ ORDERING_MAX_EVALUATIONS: 1 })
  const setup = fixture({ count: 4 })
  const result = await exact.optimizeWaypointOrder({ session: setup.session, waypointIds: setup.allowed })
  expect(result.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 24,
    evaluationBudget: null, roundEvaluationCounts: [], improvementRounds: 0, budgetExhausted: false })
  expect(setup.session.prefetchSegments).toHaveBeenCalledTimes(1)
  expect(setup.session.getCachedSegmentCosts).not.toHaveBeenCalled()
})
