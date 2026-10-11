jest.mock('../miniprogram/services/cloud-function-client', () => ({ callCloudFunction: jest.fn() }))
jest.mock('../miniprogram/services/location', () => ({ getCurrentLocation: jest.fn() }))
jest.mock('../miniprogram/services/preference-profile-records', () => ({ refreshProfile: jest.fn(async () => null) }))
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { getCurrentLocation } = require('../miniprogram/services/location')
const { rememberDiscovery, resolverFor, bindSession, releaseSession } = require('../miniprogram/services/map-planning-authorization')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { generateRoutes, requestManualWaypointCandidates } = require('../miniprogram/services/route-generation')
const { mapErrorMessage, isProviderUnavailableCode } = require('../miniprogram/utils/provider-errors')
const { routeEditErrorMessage } = require('../miniprogram/services/route-editing')
const start = { latitude: 30, longitude: 120 }
const pool = ['A', 'B', 'C'].map((poiId, i) => ({ poiId, name: poiId, category: 'park',
  latitude: 30.001 + i / 1000, longitude: 120, distanceInMeters: 100 }))
beforeEach(() => {
  jest.clearAllMocks()
  getCurrentLocation.mockResolvedValue(start)
  callCloudFunction.mockImplementation(async (name, event) => {
    if (event.action === 'nearbyPois') return { success: true, planningToken: 'private-planning-token', poisByCategory: { park: pool } }
    if (event.action === 'walkingRoute') return { success: true, route: {
      durationSeconds: 300, distanceMeters: 300, polyline: [event.start, event.destination]
    } }
    if (event.action === 'closePlanning') return { success: true }
    if (name === 'aiRoutePlanner') return { plan: { candidates: [{ waypoints: [{ poiId: 'A' }] }] } }
    throw new Error('Unexpected request')
  })
})
test.each(['point_to_point', 'loop', 'out_and_back'])('bound resolver preserves %s cache and authorization across additions and edits', async routeType => {
  const grouped = rememberDiscovery({ park: pool }, { planningToken: 'private-planning-token' })
  const session = bindSession(createRoutePlanningSession({ start, routeType, verifiedWaypointPool: pool,
    segmentResolver: resolverFor(grouped) }), grouped)
  const order = { allowedWaypointIds: ['A', 'B'], orderedWaypointIds: ['A', 'B'] }
  const route = await session.buildRouteForOrder(order)
  expect(route.success).toBe(true)
  expect(JSON.stringify(route)).not.toContain('private-planning-token')
  const count = callCloudFunction.mock.calls.length
  await session.buildRouteForOrder(order)
  expect(callCloudFunction).toHaveBeenCalledTimes(count)
  await session.buildRouteForOrder({ allowedWaypointIds: ['B', 'C'], orderedWaypointIds: ['C', 'B'] })
  const events = callCloudFunction.mock.calls.map(([, event]) => event)
  expect(events.every(e => e.planningToken === 'private-planning-token')).toBe(true)
  expect(new Set(events.map(e => e.requestId)).size).toBe(events.length)
  await releaseSession(session)
  await releaseSession(session)
  expect(callCloudFunction.mock.calls.filter(([, e]) => e.action === 'closePlanning')).toHaveLength(1)
})
test.each([15, 30, 60, 120])('real generation at %i minutes never sends credentials to AI or returned Route snapshots', async durationMinutes => {
  // Match the target for a singleton loop; no external API is invoked.
  const base = callCloudFunction.getMockImplementation()
  callCloudFunction.mockImplementation(async (name, event) => {
    const result = await base(name, event)
    if (event.action === 'walkingRoute') result.route.durationSeconds = durationMinutes * 30
    return result
  })
  const generated = await generateRoutes({ durationMinutes, routeType: 'loop',
    crowdPreference: 'medium', environmentPreferences: ['公园'] })
  expect(generated.status).toBe('success')
  expect(JSON.stringify(generated.routes)).not.toMatch(/private-planning-token|planningToken|planningExpiresAt/)
  await requestManualWaypointCandidates({ location: start, nearbyPois: pool, preferences: { durationMinutes }, attempt: 1 })
  const ai = callCloudFunction.mock.calls.filter(([name]) => name === 'aiRoutePlanner')
  expect(ai.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(ai)).not.toMatch(/private-planning-token|planningToken|planningExpiresAt/)
  expect(callCloudFunction.mock.calls.filter(([, e]) => e.action === 'walkingRoute')
    .every(([, event]) => event.planningToken === 'private-planning-token')).toBe(true)
})
test('two simultaneous discoveries do not swap credentials', async () => {
  const a = resolverFor(rememberDiscovery({}, { planningToken: 'session-A' }))
  const b = resolverFor(rememberDiscovery({}, { planningToken: 'session-B' }))
  await Promise.all([a(start, pool[0]), b(start, pool[1])])
  expect(callCloudFunction.mock.calls.map(([, e]) => e.planningToken)).toEqual(['session-A', 'session-B'])
})
test.each(['MAP_USER_QUOTA_EXHAUSTED', 'MAP_GLOBAL_QUOTA_EXHAUSTED', 'MAP_SESSION_EXPIRED',
  'MAP_EXECUTION_UNKNOWN', 'MAP_QUOTA_UNAVAILABLE'])( '%s is a service failure with a distinct edit message', async code => {
  const grouped = rememberDiscovery({}, { planningToken: 'token' })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolverFor(grouped) })
  callCloudFunction.mockRejectedValue(Object.assign(new Error('failed'), { code }))
  const result = await session.buildRouteForOrder({ allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] })
  expect(result.success).toBe(false)
  expect(isProviderUnavailableCode(code)).toBe(true)
  expect(routeEditErrorMessage({ code })).toBe(mapErrorMessage(code))
  expect(mapErrorMessage(code)).toEqual(expect.any(String))
  expect(session.getCachedSegmentCosts()).toEqual([])
})
