const { proposeDeterministicWaypointSets, runBoundedRouteCorrections } = require('./route-correction')
const { createDirectedEdgeKey } = require('./route-graph')

const pois = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((poiId, index) => ({
  poiId, latitude: 45.5 + index * 0.0005, longitude: -73.6 + index * 0.0005
}))

function sessionFor(pool = pois, routeType = 'out_and_back') {
  const known = new Map(pool.map(poi => [poi.poiId, poi]))
  const costs = new Map()
  return {
    costs,
    getWaypointSearchData: ids => ids.every(id => known.has(id))
      ? { valid: true, routeType, start: { latitude: 45.5, longitude: -73.6 },
          waypoints: ids.map(id => known.get(id)) }
      : { valid: false },
    getCachedSegmentCosts: () => [...costs].map(([edgeKey, cost]) => ({ edgeKey, ...cost })),
    settle: (fromId, toId, seconds) => costs.set(createDirectedEdgeKey(
      fromId === 'START' ? { nodeType: 'start', nodeId: fromId }
        : { nodeType: 'waypoint', nodeId: fromId },
      toId === 'START' ? { nodeType: 'start', nodeId: toId }
        : { nodeType: 'waypoint', nodeId: toId }
    ), { success: true, durationSeconds: seconds, distanceMeters: seconds })
  }
}

const failure = (ids, type) => ({ waypointIds: ids, failure: { type } })

describe('Issue #91 bounded verified-POI correction', () => {
  test('reproduced empty-manual-batch situation explores new pairs after 8 singletons', () => {
    const session = sessionFor()
    const options = proposeDeterministicWaypointSets({
      session, verifiedWaypointPool: pois,
      requestedDurationMinutes: 30,
      excludedWaypointSets: pois.map(poi => [poi.poiId]),
      allowPairFallback: true
    })
    expect(options).toHaveLength(28)
    expect(options.every(option => option.waypointIds.length === 2 && option.reason === 'novel_pair')).toBe(true)
    expect(options.every(option => option.newSegmentUpperBound === 6)).toBe(true)
  })

  test('short duration yields Insert, long duration yields Remove', () => {
    const pool = pois.slice(0, 3)
    const session = sessionFor(pool)
    const insert = proposeDeterministicWaypointSets({ session, verifiedWaypointPool: pool,
      requestedDurationMinutes: 30, observations: [failure(['A'], 'DURATION_TOO_SHORT')] })
    const remove = proposeDeterministicWaypointSets({ session, verifiedWaypointPool: pool,
      requestedDurationMinutes: 30, observations: [failure(['A','B','C'], 'DURATION_TOO_LONG')] })
    expect(insert.map(item => item.key).sort()).toEqual(['["A","B"]', '["A","C"]'])
    expect(remove.map(item => item.key).sort()).toEqual(['["A","B"]', '["A","C"]', '["B","C"]'])
  })

  test('order-independent exclusion prevents duplicate complete sets', () => {
    const pool = pois.slice(0, 3)
    const result = proposeDeterministicWaypointSets({ session: sessionFor(pool),
      verifiedWaypointPool: pool, requestedDurationMinutes: 30,
      observations: [failure(['A'], 'DURATION_TOO_SHORT')],
      excludedWaypointSets: [['B','A']] })
    expect(result.map(item => item.key)).toEqual(['["A","C"]'])
  })

  test('directed edge cache counts reverse edge as a distinct request', () => {
    const pool = pois.slice(0, 2)
    const session = sessionFor(pool)
    for (const [from,to,seconds] of [
      ['START','A',200],['A','START',200],
      ['START','B',250],['B','START',250],['A','B',180]
    ]) session.settle(from,to,seconds)
    const result = proposeDeterministicWaypointSets({ session, verifiedWaypointPool: pool,
      requestedDurationMinutes: 30, observations: [failure(['A'],'DURATION_TOO_SHORT')] })
    expect(result).toHaveLength(1)
    expect(result[0].newSegmentUpperBound).toBe(1)
  })

  test('full-cache duration infeasibility avoids pointless rebuild', () => {
    const pool = pois.slice(0, 2)
    const session = sessionFor(pool)
    for (const [from,to] of [
      ['START','A'],['A','START'],['START','B'],['B','START'],['A','B'],['B','A']
    ]) session.settle(from,to,60)
    const result = proposeDeterministicWaypointSets({ session, verifiedWaypointPool: pool,
      requestedDurationMinutes: 30, observations: [failure(['A'],'DURATION_TOO_SHORT')] })
    expect(result).toEqual([])
  })

  test('strict map-request budget can reject expensive corrections before evaluating', async () => {
    const pool = pois.slice(0, 5)
    const buildCandidateRoute = jest.fn()
    const result = await runBoundedRouteCorrections({ session: sessionFor(pool),
      verifiedWaypointPool: pool, observations: [failure(['A','B','C'],'DURATION_TOO_SHORT')],
      requestedDurationMinutes: 30, buildCandidateRoute })
    expect(buildCandidateRoute).not.toHaveBeenCalled()
    expect(result.remainingSegmentBudget).toBe(12)
  })

  test('provider failure stops immediately and never returns a route', async () => {
    const pool = pois.slice(0, 3)
    const buildCandidateRoute = jest.fn(async () => ({ success: false, error: 'PROVIDER_BUSY' }))
    const result = await runBoundedRouteCorrections({ session: sessionFor(pool),
      verifiedWaypointPool: pool, observations: [failure(['A'],'DURATION_TOO_SHORT')],
      requestedDurationMinutes: 30, buildCandidateRoute })
    expect(result.success).toBe(false)
    expect(result.providerError).toBe('PROVIDER_BUSY')
    expect(result.failures).toEqual([])
    expect(buildCandidateRoute).toHaveBeenCalledTimes(1)
  })

  test('the real builder is the only source of route success; returns on first valid result', async () => {
    const pool = pois.slice(0, 4)
    const route = { routeId: 'valid', durationSeconds: 1800 }
    const buildCandidateRoute = jest.fn(async ({ candidate, candidateCache }) => {
      expect(candidateCache.markBuilding(candidate.candidateId)).toBe(true)
      candidateCache.markSuccess(candidate.candidateId, route)
      return { success: true, route }
    })
    const result = await runBoundedRouteCorrections({ session: sessionFor(pool),
      verifiedWaypointPool: pool, observations: [failure(['A'],'DURATION_TOO_SHORT')],
      requestedDurationMinutes: 30, buildCandidateRoute })
    expect(result.success).toBe(true)
    expect(result.route).toBe(route)
    expect(result.attemptedCandidates).toBe(1)
    expect(buildCandidateRoute).toHaveBeenCalledTimes(1)
  })
})
