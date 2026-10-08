const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { getStreetEvidence, rememberStreetEvidence, aggregateStreetEvidence } = require('../miniprogram/services/street-evidence')
const { buildGeneratedRoute, buildGeneratedRouteFromAiCandidate, rebuildGeneratedRouteForOrder } = require('../miniprogram/services/route-generation')
const { scoreRoute } = require('../miniprogram/services/route-ranking')
const start = { latitude: 30, longitude: 120 }
const pool = ['A', 'B'].map((poiId, i) => ({ poiId, name: poiId, category: 'park', latitude: 31 + i, longitude: 120 }))
const originalWx = global.wx
afterEach(() => { global.wx = originalWx })

function mockCloud(evidences) {
  global.wx = { cloud: { callFunction: jest.fn(async ({ data }) => {
    const index = data.destination.latitude === 31 ? 0 : 1
    return { result: { success: true, route: {
      distanceMeters: index === 0 ? 100 : 900, durationSeconds: 900,
      polyline: [data.start, data.destination], streetEvidence: evidences[index],
      steps: [{ type: 0, distance: 1000 }], environmentStats: { normalRoadRatio: 1 }
    } } }
  }) } }
}

test.each([
  [[{ coverageRatio: 1, ordinaryRoadRatio: 1 }, { coverageRatio: 1, ordinaryRoadRatio: 0 }], { coverageRatio: 1, ordinaryRoadRatio: 0.1 }],
  [[{ coverageRatio: 1, ordinaryRoadRatio: 1 }, undefined], { coverageRatio: 0.1, ordinaryRoadRatio: 1 }],
  [[undefined, { coverageRatio: 1, ordinaryRoadRatio: 0 }], { coverageRatio: 0.9, ordinaryRoadRatio: 0 }],
  [[undefined, undefined], null]
])('complete route uses actual directed distances, missing capability reduces coverage', async (evidences, expected) => {
  mockCloud(evidences)
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
  const options = { allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] }
  const walking = await session.buildRouteForOrder(options)
  expect(getStreetEvidence(walking)).toEqual(expected)
  expect(walking.distanceMeters).toBe(1000)
  expect(JSON.stringify(walking)).not.toMatch(/streetEvidence|coverageRatio|ordinaryRoadRatio|environmentStats|steps/)
  const generated = buildGeneratedRouteFromAiCandidate({ location: start, walkingRoute: walking })
  expect(getStreetEvidence(generated)).toEqual(expected)
  const rebuilt = await session.buildRouteForOrder(options)
  expect(getStreetEvidence(rebuilt)).toEqual(expected)
  expect(wx.cloud.callFunction).toHaveBeenCalledTimes(2)
})

test('edits recompute evidence with the same route ID; replacement, copies and new sessions cannot inherit it', async () => {
  mockCloud([{ coverageRatio: 1, ordinaryRoadRatio: 1 }, undefined])
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
  const walking = await session.buildRouteForOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] })
  const base = buildGeneratedRouteFromAiCandidate({ location: start, walkingRoute: walking })
  const editedWalk = await session.buildRouteForOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A'] })
  const edited = rebuildGeneratedRouteForOrder({ baseRoute: base, walkingRoute: editedWalk })
  expect(edited.routeId).toBe(base.routeId)
  expect(getStreetEvidence(base).coverageRatio).toBe(0.1)
  expect(getStreetEvidence(edited)).toEqual({ coverageRatio: 1, ordinaryRoadRatio: 1 })
  expect(getStreetEvidence({ ...edited })).toBeNull()
  const fallback = buildGeneratedRoute({ location: start, selectedPoi: pool[0], walkingRoute: editedWalk })
  expect(getStreetEvidence(fallback)).toEqual(getStreetEvidence(edited))
  mockCloud([undefined, undefined])
  const fresh = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
  const freshWalk = await fresh.buildRouteForOrder({ allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] })
  const replacement = rebuildGeneratedRouteForOrder({ baseRoute: edited, walkingRoute: freshWalk })
  expect(replacement.routeId).toBe(edited.routeId)
  expect(getStreetEvidence(replacement)).toBeNull()
  expect(JSON.stringify({ activeWalkSession: { route: edited }, pendingWalkResult: { route: fallback } }))
    .not.toMatch(/streetEvidence|coverageRatio|ordinaryRoadRatio/)
  edited.polyline = [start, pool[1]]
  expect(getStreetEvidence(edited)).toBeNull()
})

test('injected resolver properties are not trusted evidence and cannot bypass route failures', async () => {
  const segmentResolver = jest.fn(async (from, to) => ({ success: true, distanceMeters: 100, durationSeconds: 100,
    polyline: [from, to], streetEvidence: { coverageRatio: 1, ordinaryRoadRatio: 1 },
    environmentStats: { normalRoadRatio: 1 }, steps: [{ type: 0, distance: 100 }] }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver })
  expect(getStreetEvidence(await session.buildRouteForOrder({ allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }))).toBeNull()
  expect(await session.buildRouteForOrder({ allowedWaypointIds: ['A'], orderedWaypointIds: ['unknown'] }))
    .toMatchObject({ success: false })
  expect(segmentResolver).toHaveBeenCalledTimes(1)
})

test.each([{}, { coverageRatio: NaN, ordinaryRoadRatio: 1 }, { coverageRatio: 1, ordinaryRoadRatio: '1' },
  { coverageRatio: -1, ordinaryRoadRatio: 1 }, { coverageRatio: 1, ordinaryRoadRatio: 2 }])(
  'cloud malformed aggregate is unknown without losing valid walking facts', async evidence => {
    mockCloud([evidence])
    const segment = await getWalkingSegment(start, pool[0])
    expect(segment.success).toBe(true)
    expect(getStreetEvidence(segment)).toBeNull()
  })

test('aggregate rejects invalid distances and never substitutes distance or geometry as evidence', () => {
  expect(aggregateStreetEvidence([])).toBeNull()
  for (const distanceMeters of [0, -1, NaN, Infinity, '100']) {
    expect(aggregateStreetEvidence([{ distanceMeters }])).toBeNull()
  }
  const segment = { distanceMeters: 100 }
  rememberStreetEvidence(segment, { coverageRatio: 1, ordinaryRoadRatio: 0 })
  expect(aggregateStreetEvidence([segment, { distanceMeters: 0 }])).toEqual({ coverageRatio: 1, ordinaryRoadRatio: 0 })
})

test.each([['loop', 3, 1900, 100 / 1900], ['out_and_back', 4, 2000, 0.1]])(
  '%s evidence includes every return edge with its own actual distance', async (routeType, calls, distance, ratio) => {
    mockCloud([{ coverageRatio: 1, ordinaryRoadRatio: 1 }, { coverageRatio: 1, ordinaryRoadRatio: 0 }])
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, routeType })
    const result = await session.buildRouteForOrder({ allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] })
    expect(result.success).toBe(true)
    expect(result.distanceMeters).toBe(distance)
    expect(getStreetEvidence(result).coverageRatio).toBe(1)
    expect(getStreetEvidence(result).ordinaryRoadRatio).toBeCloseTo(ratio)
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(calls)
  })


test('observed partial coverage survives cloud boundary, directed aggregation and generated route ranking', async () => {
  const firstCoverage = 1209 / 1213
  const secondCoverage = 1247 / 1252
  mockCloud([
    { coverageRatio: firstCoverage, ordinaryRoadRatio: 1 },
    { coverageRatio: secondCoverage, ordinaryRoadRatio: 0.5 }
  ])
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
  const walking = await session.buildRouteForOrder({
    allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B']
  })
  const evidence = getStreetEvidence(walking)
  expect(evidence.coverageRatio).toBeCloseTo((100 * firstCoverage + 900 * secondCoverage) / 1000)
  expect(evidence.ordinaryRoadRatio).toBeCloseTo(
    (100 * firstCoverage + 900 * secondCoverage * 0.5) /
    (100 * firstCoverage + 900 * secondCoverage)
  )
  expect(evidence).toEqual({
    coverageRatio: expect.any(Number),
    ordinaryRoadRatio: expect.any(Number)
  })
  const generated = buildGeneratedRouteFromAiCandidate({ location: start, walkingRoute: walking })
  expect(getStreetEvidence(generated)).toEqual(evidence)
  const score = scoreRoute(generated, { preferences: {
    durationMinutes: 30, environmentPreferences: ['街道', '公园', '水边', '商街']
  } })
  expect(score.streetBonus).toBeCloseTo(0.05 * evidence.coverageRatio * evidence.ordinaryRoadRatio)
  expect(score.streetBonus).toBeGreaterThan(0)
  expect(JSON.stringify(generated)).not.toMatch(/streetEvidence|classificationComplete|coverageRatio|ordinaryRoadRatio/)
})

test('unknown directed segments contribute zero confirmed meters, not a score cliff', () => {
  const confirmed = rememberStreetEvidence({ distanceMeters: 200 }, {
    coverageRatio: 1, ordinaryRoadRatio: 1
  })
  const unknown = { distanceMeters: 800 }
  const aggregate = aggregateStreetEvidence([confirmed, unknown])
  expect(aggregate).toEqual({ coverageRatio: 0.2, ordinaryRoadRatio: 1 })
  const baseRoute = { distanceMeters: 1000, durationSeconds: 1800,
    pointsOfInterest: [{ poiId: 'A', category: 'park' }] }
  const route = rememberStreetEvidence(baseRoute, aggregate)
  const ctx = { preferences: {
    durationMinutes: 30, environmentPreferences: ['街道', '公园', '水边', '商街']
  } }
  expect(scoreRoute(route, ctx).streetBonus).toBeCloseTo(0.01)
  // All-unknown segments have no evidence, so there is nothing to score.
  expect(aggregateStreetEvidence([{ distanceMeters: 1000 }])).toBeNull()
  expect(scoreRoute(baseRoute, ctx).streetBonus).toBeCloseTo(0.01)

  // Legacy completion flags are ignored: only the two allowlisted numeric ratios survive.
  const legacy = rememberStreetEvidence({ ...baseRoute }, {
    coverageRatio: 0.99, ordinaryRoadRatio: 0.5, classificationComplete: true
  })
  expect(getStreetEvidence(legacy)).toEqual({ coverageRatio: 0.99, ordinaryRoadRatio: 0.5 })
  expect(scoreRoute(legacy, ctx).streetBonus).toBeCloseTo(0.05 * 0.99 * 0.5)
  expect(JSON.stringify(legacy)).not.toContain('classificationComplete')
})
