jest.mock('../miniprogram/services/cloud-function-client', () => ({
  callCloudFunction: jest.fn()
}))
jest.mock('../miniprogram/services/preference-profile-records', () => ({
  refreshProfile: jest.fn()
}))
jest.mock('../miniprogram/services/location', () => ({
  getCurrentLocation: jest.fn()
}))

const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const locationService = require('../miniprogram/services/location')
const { refreshProfile } = require('../miniprogram/services/preference-profile-records')
const { requestManualWaypointCandidates } = require('../miniprogram/services/route-generation')

const location = { latitude: 30, longitude: 120 }
const nearbyPois = ['A', 'B'].map((poiId, index) => ({
  poiId, name: poiId, category: 'park', latitude: 30.01 + index / 100,
  longitude: 120, distanceInMeters: 100
}))
const preferences = {
  durationMinutes: 90, routeType: 'point_to_point',
  crowdPreference: 'any', environmentPreferences: ['公园', '水边', '商街']
}

beforeEach(() => jest.clearAllMocks())

test('requests one bounded AI batch using captured facts without searching location or refreshing profile', async () => {
  callCloudFunction.mockResolvedValue({ plan: { candidates: [
    { waypoints: [{ poiId: 'A' }] },
    { waypoints: [{ poiId: 'B' }] }
  ] } })
  const result = await requestManualWaypointCandidates({
    location, preferences, nearbyPois, attempt: 2,
    historicalPreferenceProfile: null,
    previousFailures: [{ attempt: 1, waypointIds: ['A'],
      failure: { type: 'NO_COMPLETE_ROUTE' } }]
  })
  expect(result.getUnusedCandidates()).toHaveLength(2)
  expect(callCloudFunction).toHaveBeenCalledTimes(1)
  const [name, event] = callCloudFunction.mock.calls[0]
  expect(name).toBe('aiRoutePlanner')
  expect(event.startPoint).toEqual(location)
  expect(event.nearbyPois).toEqual(nearbyPois)
  expect(event.replanningContext.attempt).toBe(2)
  expect(locationService.getCurrentLocation).not.toHaveBeenCalled()
  expect(refreshProfile).not.toHaveBeenCalled()
})

test('does not accept hallucinated POIs or malformed AI candidates as usable routes', async () => {
  callCloudFunction.mockResolvedValue({ plan: { candidates: [
    { waypoints: [{ poiId: 'UNVERIFIED' }] },
    { waypoints: [{ poiId: 'A' }, { poiId: 'A' }] },
    { waypoints: [{ poiId: 'A' }] }
  ] } })
  const cache = await requestManualWaypointCandidates({
    location, preferences, nearbyPois, attempt: 1
  })
  expect(cache.getUnusedCandidates().map(c => c.waypointIds)).toEqual([['A']])
  await expect(requestManualWaypointCandidates({
    location, preferences, nearbyPois, attempt: 4
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('first manual request reaches the real cloud prompt with verified exclusions and no invented failures', async () => {
  const { buildRoutePlanningPrompt } = require('../cloudfunctions/aiRoutePlanner/routePlanningPrompt')
  callCloudFunction.mockResolvedValue({ plan: { candidates: [] } })
  await requestManualWaypointCandidates({ location, nearbyPois, attempt: 1,
    preferences: { ...preferences, crowdPreference: 'medium',
      environmentPreferences: ['公园', '水边', '街道', '商街'] },
    excludedWaypointSets: [[' B ', 'A'], ['A', 'B'], ['UNVERIFIED'], ['A', 'UNVERIFIED'], []]
  })
  const event = callCloudFunction.mock.calls[0][1]
  expect(event.replanningContext).toEqual({ mode: 'manual', attempt: 1,
    excludedWaypointSets: [['A', 'B']], previousFailures: [] })
  const result = buildRoutePlanningPrompt(event)
  expect(result.success).toBe(true)
  const context = JSON.parse(result.data.prompt.split('MANUAL ALTERNATIVE CONTEXT\n')[1].split('\n')[0])
  expect(context).toEqual(event.replanningContext)
  expect(result.data.prompt).toContain('Partial POI overlap')
  expect(result.data.prompt).not.toContain('UNVERIFIED')
  expect(refreshProfile).not.toHaveBeenCalled()
  expect(locationService.getCurrentLocation).not.toHaveBeenCalled()
})
