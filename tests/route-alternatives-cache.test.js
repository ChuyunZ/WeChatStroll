jest.mock('../miniprogram/services/cloud-function-client', () => ({ callCloudFunction: jest.fn() }))
jest.mock('../miniprogram/services/preference-profile-records', () => ({ refreshProfile: jest.fn() }))

const generation = require('../miniprogram/services/route-generation')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { refreshProfile } = require('../miniprogram/services/preference-profile-records')

const start = { latitude: 30, longitude: 120 }
const pois = ['A', 'B', 'C', 'D', 'E'].map((poiId, i) => ({
  poiId, name: poiId, category: 'park', latitude: 30.01 + i / 100, longitude: 120
}))
const tap = id => ({ currentTarget: { dataset: { id } } })
const resolver = () => jest.fn(async (from, to) => ({
  success: true, durationSeconds: 600, distanceMeters: 800,
  polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
}))
const sessionWith = segmentResolver => createRoutePlanningSession({
  start, verifiedWaypointPool: pois, routeType: 'point_to_point', segmentResolver
})
const order = ids => ({ allowedWaypointIds: ids, orderedWaypointIds: ids })
const edgeCalls = (mock, from, to) => mock.mock.calls.filter(([a, b]) => a.nodeId === from && b.nodeId === to).length

function pageWith(session, cache, routes) {
  let definition
  global.Page = value => { definition = value }
  jest.isolateModules(() => require('../miniprogram/pages/routes/routes'))
  const page = { ...definition, data: { ...definition.data } }
  page.setData = jest.fn(update => Object.assign(page.data, update))
  page.resetManualAlternatives()
  page._routeRequestId = 1
  page._routePlanningSession = session
  page._waypointCandidateCache = cache
  page._routeLocation = start
  page._routePreferences = { durationMinutes: 20 }
  page._rawRoutes = routes
  routes.forEach(route => page.rememberSurfacedRoute(route))
  page._initialCandidateProcessingComplete = true
  page.updateManualAlternativeControls()
  return page
}

beforeEach(() => {
  jest.clearAllMocks()
  global.wx = { showToast: jest.fn() }
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { jest.restoreAllMocks(); delete global.Page; delete global.wx })

test('directed lookup, repeated evaluation/build and fresh session have exact resolver counts', async () => {
  const resolve = resolver()
  const session = sessionWith(resolve)
  expect((await session.buildRouteForOrder(order(['A', 'B']))).success).toBe(true)
  expect(resolve).toHaveBeenCalledTimes(2) // START → A, A → B
  expect(edgeCalls(resolve, 'A', 'B')).toBe(1)
  await session.evaluateRouteOrder(order(['A', 'B']))
  await session.buildRouteForOrder(order(['A', 'B']))
  expect(resolve).toHaveBeenCalledTimes(2)
  await session.buildRouteForOrder(order(['B', 'A']))
  expect(resolve).toHaveBeenCalledTimes(4) // START → B, B → A are distinct
  expect(edgeCalls(resolve, 'B', 'A')).toBe(1)
  await session.buildRouteForOrder(order(['A', 'C']))
  expect(resolve).toHaveBeenCalledTimes(5) // only A → C is missing
  expect(edgeCalls(resolve, 'A', 'C')).toBe(1)
  await sessionWith(resolve).buildRouteForOrder(order(['A', 'B']))
  expect(resolve).toHaveBeenCalledTimes(7)
  expect(edgeCalls(resolve, 'A', 'B')).toBe(2)
})

test('page Add and Replace reuse initial optimizer segments and never refresh history or call AI', async () => {
  const resolve = resolver()
  const session = sessionWith(resolve)
  const cache = createWaypointCandidateCache(['B', 'C', 'D', 'E'].map(id => ({
    waypoints: [{ poiId: 'A' }, { poiId: id }]
  })))
  const first = await generation.buildOptimizedCandidateRoute({
    session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0],
    location: start, candidateIndex: 0, requestedDurationMinutes: 20
  })
  expect(first.success).toBe(true)
  expect(resolve).toHaveBeenCalledTimes(4)
  const page = pageWith(session, cache, [first.route])
  await page.showOtherRoutes()
  expect(page._rawRoutes).toHaveLength(2)
  expect(resolve).toHaveBeenCalledTimes(7) // START → A reused, three new directed edges
  await page.showOtherRoutes()
  expect(page._rawRoutes).toHaveLength(3)
  expect(resolve).toHaveBeenCalledTimes(10)
  const selected = page._rawRoutes[1]
  const kept = page._rawRoutes.filter(route => route !== selected)
  page.showOtherRoutes()
  await page.selectRouteToReplace(tap(selected.routeId))
  expect(resolve).toHaveBeenCalledTimes(13)
  expect(page._rawRoutes).toHaveLength(3)
  kept.forEach(route => expect(page._rawRoutes).toContain(route))
  expect(page._rawRoutes).not.toContain(selected)
  const { START_NODE_ID } = require('../miniprogram/services/route-engine')
  expect(edgeCalls(resolve, START_NODE_ID, 'A')).toBe(1)
  expect(edgeCalls(resolve, 'A', 'B')).toBe(1)
  expect(edgeCalls(resolve, 'B', 'A')).toBe(1)
  await session.buildRouteForOrder(order(['A', 'E']))
  expect(resolve).toHaveBeenCalledTimes(13)
  expect(page._manualAlternativeActionCount).toBe(3)
  expect(page._routePlanningSession).toBe(session)
  expect(page._waypointCandidateCache).toBe(cache)
  // Display-only quota reads are allowed. They must not trigger any AI,
  // Explore or Walking call or change the cached segment count.
  expect(callCloudFunction).toHaveBeenCalledTimes(3)
  expect(callCloudFunction.mock.calls.every(([name, data]) =>
    name === 'mapProvider' && data.action === 'quotaStatus')).toBe(true)
  expect(refreshProfile).not.toHaveBeenCalled()
})

test.each(['malformed', 'provider', 'duration'])('invalid %s candidate cannot change displayed routes or budget', async mode => {
  const resolve = resolver()
  const session = sessionWith(resolve)
  const cache = createWaypointCandidateCache(['B', 'C'].map(id => ({
    waypoints: [{ poiId: 'A' }, { poiId: id }]
  })))
  const first = await generation.buildOptimizedCandidateRoute({
    session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0],
    location: start, candidateIndex: 0, requestedDurationMinutes: 20
  })
  const normal = resolve.getMockImplementation()
  resolve.mockImplementation(async (from, to) => {
    if (from.poiId === 'C' || to.poiId === 'C') {
      if (mode === 'malformed') return { success: true, polyline: [] }
      if (mode === 'provider') return { success: false, error: 'PROVIDER_GATEWAY_FAILED' }
      return { ...(await normal(from, to)), durationSeconds: 10000 }
    }
    return normal(from, to)
  })
  const page = pageWith(session, cache, [first.route])
  const original = page._rawRoutes
  await page.showOtherRoutes()
  expect(page._rawRoutes).toBe(original)
  expect(page._manualAlternativeActionCount).toBe(0)
  expect(cache.getAllCandidates()[1].status).toBe('failed')
  const calls = resolve.mock.calls.length
  await session.buildRouteForOrder(order(['A', 'C']))
  expect(resolve).toHaveBeenCalledTimes(calls) // cached failure is not a valid route or a retry
})
