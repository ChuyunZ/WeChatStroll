/**
 * Issue #91 integration verification:
 * real route-generation, route engine, order optimizer, validator and Routes Page;
 * only external location/history/AI/cloud-map boundary is mocked.
 * No Tencent requests, WeChat device or CloudBase credentials are used.
 */
jest.mock('../miniprogram/services/location', () => ({
  getCurrentLocation: jest.fn()
}))
jest.mock('../miniprogram/services/preference-profile-records', () => ({
  refreshProfile: jest.fn()
}))
jest.mock('../miniprogram/services/cloud-function-client', () => ({
  callCloudFunction: jest.fn()
}))
jest.mock('../miniprogram/services/walking-segment', () => ({
  getWalkingSegment: jest.fn()
}))

const { getCurrentLocation } = require('../miniprogram/services/location')
const { refreshProfile } = require('../miniprogram/services/preference-profile-records')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const {
  generateRoutes, buildOptimizedCandidateRoute
} = require('../miniprogram/services/route-generation')
const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache')
const { getAllowedDurationRange, validateGeneratedWalkingRoute } =
  require('../miniprogram/services/route-validation')
const { waypointSetKey } = require('../miniprogram/services/agentic-route-planning')
const {
  MAX_CORRECTION_CANDIDATES, MAX_CORRECTION_NEW_SEGMENTS
} = require('../miniprogram/config/route-planning')

const start = { latitude: 30, longitude: 120 }
const coordinates = [
  ['A', 30.007, 120.005],
  ['B', 30.003, 120.000],
  ['C', 30.003, 120.007],
  ['D', 30.008, 120.000],
  ['E', 30.008, 120.003],
  ['F', 30.008, 120.006],
  ['G', 30.008, 120.008],
  ['H', 30.006, 120.008]
]
const pois = coordinates.map(([poiId, latitude, longitude]) => ({
  poiId, latitude, longitude, name: poiId,
  category: 'park', distanceInMeters: 800,
  address: poiId + ' street'
}))
const prefs = {
  durationMinutes: 30, routeType: 'out_and_back',
  crowdPreference: 'medium', environmentPreferences: ['公园']
}
const singleLegSeconds = { A: 900, B: 450, C: 500, D: 1290, E: 1290,
  F: 1290, G: 1290, H: 1290 }
let pageDefinition
let allowFeasiblePair
let calls

beforeAll(() => {
  global.Page = jest.fn(definition => { pageDefinition = definition })
  require('../miniprogram/pages/routes/routes')
})

afterAll(() => { delete global.Page; delete global.wx })

beforeEach(() => {
  jest.clearAllMocks()
  allowFeasiblePair = true
  calls = []
  global.wx = { showToast: jest.fn(), navigateTo: jest.fn() }
  getCurrentLocation.mockResolvedValue(start)
  refreshProfile.mockResolvedValue(null)
  callCloudFunction.mockImplementation(async (name, data) => {
    calls.push({ name, action: data && data.action, attempt: data && data.replanningContext && data.replanningContext.attempt })
    if (name === 'mapProvider') return { poisByCategory: { park: pois } }
    if (name === 'aiRoutePlanner') return {
      plan: { candidates: data && data.replanningContext
        ? [] : [{ waypoints: [{ poiId: 'A' }] }] }
    }
    throw new Error('Unexpected cloud boundary: ' + name)
  })
  getWalkingSegment.mockImplementation(async (from, to) => {
    const a = from.nodeId, b = to.nodeId
    let durationSeconds
    if (a === 'START') durationSeconds = singleLegSeconds[b]
    else if (b === 'START') durationSeconds = singleLegSeconds[a]
    else if (allowFeasiblePair && a === 'B' && b === 'C') durationSeconds = 450
    else if (allowFeasiblePair && a === 'C' && b === 'B') durationSeconds = 450
    else durationSeconds = 2200
    if (!Number.isFinite(durationSeconds)) throw new Error('Unknown synthetic segment: ' + a + '-' + b)
    return {
      success: true, durationSeconds, distanceMeters: durationSeconds * 1.2,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
    }
  })
})

function createPage(result) {
  const page = {
    ...pageDefinition, data: { ...pageDefinition.data },
    setData(updates) { this.data = { ...this.data, ...updates } }
  }
  page.resetManualAlternatives()
  page._routeRequestId = 1
  page._routePreferences = prefs
  page._rawRoutes = [...result.routes]
  page._routePlanningSession = result.routePlanningSession
  page._waypointCandidateCache = result.waypointCandidateCache
  page._routeLocation = result.location
  page._historicalPreferenceProfile = result.historicalPreferenceProfile || null
  page._verifiedWaypointPool = result.verifiedWaypointPool
  page._rawRoutes.forEach(route => page.rememberSurfacedRoute(route))
  page._initialCandidateProcessingComplete = true
  page.updateManualAlternativeControls()
  return page
}

async function warmUpAllSingletons(page) {
  const attemptOutcomes = []
  for (const poi of pois.filter(p => p.poiId !== 'A')) {
    const cache = createWaypointCandidateCache([
      { waypoints: [{ poiId: poi.poiId }] }
    ])
    const candidate = cache.getUnusedCandidates()[0]
    const result = await buildOptimizedCandidateRoute({
      session: page._routePlanningSession, candidateCache: cache, candidate,
      location: start, candidateIndex: 0, requestedDurationMinutes: 30
    })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('ROUTE_DURATION_OUT_OF_RANGE')
    page._manualAttemptedKeys.add(waypointSetKey([poi.poiId]))
    attemptOutcomes.push({poiId:poi.poiId,actual:result.actualDurationSeconds})
  }
  const excluded = new Set([...page._manualAttemptedKeys, ...page._seenWaypointSetKeys])
  expect(excluded.size).toBe(8)
  return attemptOutcomes
}

async function startAndPrepare() {
  const generated = await generateRoutes(prefs)
  expect(generated.status).toBe('success')
  expect(generated.source).toBe('ai')
  expect(generated.routes).toHaveLength(1)
  expect(generated.routes[0].durationSeconds).toBe(1800)
  const page = createPage(generated)
  const results = await warmUpAllSingletons(page)
  expect(results.filter(x => x.actual < 1350)).toHaveLength(2)
  expect(results.filter(x => x.actual > 2250)).toHaveLength(5)
  expect(page.getManualAlternativeAction()).toBe('add')
  return { page, generated }
}

test('8 excluded singleton sets: real Add/Correction/Optimizer/Validator finds valid B+C without another AI call', async () => {
  const { page, generated } = await startAndPrepare()
  const beforeMap = getWalkingSegment.mock.calls.length
  const beforeAI = calls.filter(c => c.name === 'aiRoutePlanner').length
  const logSpy = jest.spyOn(console, 'log')
  let acceptedLogs
  try {
    await page.showOtherRoutes()
    acceptedLogs = logSpy.mock.calls.filter(([label]) =>
      label === '[Manual AI Planning] Route accepted:')
  } finally {
    logSpy.mockRestore()
  }
  expect(acceptedLogs).toEqual([[
    '[Manual AI Planning] Route accepted:',
    { attempt: 0, action: 'add', source: 'deterministic-correction' }
  ]])
  const newMapCalls = getWalkingSegment.mock.calls.length - beforeMap
  const newAICalls = calls.filter(c => c.name === 'aiRoutePlanner').length - beforeAI
  expect(newAICalls).toBe(0)
  expect(newMapCalls).toBeLessThanOrEqual(MAX_CORRECTION_NEW_SEGMENTS)
  expect(page._rawRoutes).toHaveLength(2)
  const added = page._rawRoutes.find(route =>
    waypointSetKey(route.recommendedWaypointIds) === waypointSetKey(['B','C']))
  expect(added).toBeDefined()
  const range = getAllowedDurationRange(30)
  expect(added.durationSeconds).toBeGreaterThanOrEqual(range.minSeconds)
  expect(added.durationSeconds).toBeLessThanOrEqual(range.maxSeconds)
  expect(page._manualAlternativeActionCount).toBe(1)
  expect(page._routePlanningSession).toBe(generated.routePlanningSession)
  expect(page._manualAlternativeExhausted).toBe(false)
  expect(generated.routePlanningSession.getPlanningDiagnostics().segmentResolverCalls)
    .toBe(getWalkingSegment.mock.calls.length)
  expect(MAX_CORRECTION_CANDIDATES).toBe(6)
})

test('8 exhausted singleton sets + no feasible pairs + genuine empty AI responses: stop safely after two empty batches', async () => {
  allowFeasiblePair = false
  const { page, generated } = await startAndPrepare()
  const existingRoute = page._rawRoutes[0]
  const beforeMap = getWalkingSegment.mock.calls.length
  await page.showOtherRoutes()
  const addedMapCalls = getWalkingSegment.mock.calls.length - beforeMap
  const aiCalls = calls.filter(c => c.name === 'aiRoutePlanner')
  expect(aiCalls).toHaveLength(3) // one initial, two manually empty (not three)
  expect(aiCalls.filter(c => c.attempt !== undefined).map(c => c.attempt)).toEqual([1,2])
  expect(addedMapCalls).toBeLessThanOrEqual(MAX_CORRECTION_NEW_SEGMENTS)
  expect(page._rawRoutes).toEqual([existingRoute])
  expect(page._manualAlternativeActionCount).toBe(0)
  expect(page._manualAlternativeExhausted).toBe(true)
  expect(page._routePlanningSession).toBe(generated.routePlanningSession)
  expect(page.data.routes).not.toEqual(expect.arrayContaining([
    expect.objectContaining({recommendedWaypointIds:['B','C']})
  ]))
})
