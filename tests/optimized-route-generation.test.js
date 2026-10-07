jest.mock('../miniprogram/services/location', () => ({ getCurrentLocation: jest.fn() }))
jest.mock('../miniprogram/services/preference-profile-records', () => ({ refreshProfile: jest.fn() }))
jest.mock('../miniprogram/services/cloud-function-client', () => ({ callCloudFunction: jest.fn() }))
jest.mock('../miniprogram/services/walking-segment', () => ({ getWalkingSegment: jest.fn() }))

const { getCurrentLocation } = require('../miniprogram/services/location')
const { refreshProfile } = require('../miniprogram/services/preference-profile-records')
const { buildProfile } = require('../cloudfunctions/preferenceProfileStore/profile-builder')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const { generateRoutes, buildOptimizedCandidateRoute } = require('../miniprogram/services/route-generation')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache')

const location = { latitude: 30, longitude: 120 }
const pois = ['A', 'B', 'C', 'D', 'E'].map((poiId, index) => ({
  poiId, name: poiId, latitude: 30 + index / 100, longitude: 120, category: 'park',
  address: `${poiId} street`, distanceInMeters: 800,
  providerMeta: { type: '公园', typecode: '110101' }
}))
const publicPois = pois.map(({ providerMeta, ...poi }) => poi)
const candidates = ['B', 'C', 'D', 'E'].map(id => ({ waypoints: [{ poiId: id }, { poiId: 'A' }] }))
const preferences = { durationMinutes: 45, routeType: 'point_to_point' }

function cloudPlan(plan) {
  callCloudFunction.mockImplementation(async name => name === 'mapProvider'
    ? { poisByCategory: { park: pois } }
    : { plan })
}

beforeEach(() => {
  jest.resetAllMocks()
  refreshProfile.mockResolvedValue(null)
  getCurrentLocation.mockResolvedValue(location)
  cloudPlan({ candidates })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 1350, distanceMeters: 200,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))
})

test('initial routes and replacements optimize sets and share all cached segments', async () => {
  const result = await generateRoutes(preferences)
  expect(result.status).toBe('success')
  expect(result.routes).toHaveLength(1)
  expect(getWalkingSegment).toHaveBeenCalledTimes(4)
  for (const candidate of result.waypointCandidateCache.getUnusedCandidates().slice(0, 2)) {
    const next = await buildOptimizedCandidateRoute({
      session: result.routePlanningSession, candidateCache: result.waypointCandidateCache,
      candidate, location, candidateIndex: Number(candidate.candidateId.split('-').pop()) - 1,
      requestedDurationMinutes: 45
    })
    result.routes.push(next.route)
  }
  expect(result.routes).toHaveLength(3)
  const first = result.routes[0]
  expect(first.candidateWaypointIds).toEqual(['B', 'A'])
  expect(first.recommendedWaypointIds).toEqual(['A', 'B'])
  expect(first.routeOrder).toEqual({ orderedWaypointIds: ['A', 'B'], source: 'recommended' })
  expect(first.pointsOfInterest.map(p => p.poiId)).toEqual(['A', 'B'])
  expect(first.editableWaypoints).toEqual(publicPois.slice(0, 2))
  expect(first.pointsOfInterest[0]).toMatchObject(publicPois[0])
  expect(first.endPoint.name).toBe('B')
  expect(first.durationSeconds).toBe(2700)
  expect(first.optimization).toMatchObject({ strategy: 'exact', evaluatedOrderCount: 2, targetErrorSeconds: 0 })
  expect(getWalkingSegment).toHaveBeenCalledTimes(10)
  const cache = result.waypointCandidateCache
  const candidate = cache.getUnusedCandidates()[0]
  expect(candidate.waypointIds).toEqual(['E', 'A'])
  const replacement = await buildOptimizedCandidateRoute({
    session: result.routePlanningSession, candidateCache: cache, candidate,
    location, candidateIndex: 3, requestedDurationMinutes: 45
  })
  expect(replacement.route.recommendedWaypointIds).toEqual(['A', 'E'])
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
  expect(callCloudFunction.mock.calls.map(([name]) => name)).toEqual(['mapProvider', 'aiRoutePlanner'])
  expect(cache.getAllCandidates().every(entry => entry.status === 'success')).toBe(true)
  expect(cache.getAllCandidates()[3]).toMatchObject({
    waypointIds: ['E', 'A'], route: { optimization: replacement.route.optimization }
  })
  await result.routePlanningSession.buildRouteForOrder({
    allowedWaypointIds: ['B', 'A'], orderedWaypointIds: ['B', 'A']
  })
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
})

test('explicit empty AI plan uses a validated deterministic fallback without repeating location or POI search', async () => {
  cloudPlan({ candidates: [] })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(result.routes).toHaveLength(1)
  expect(getCurrentLocation).toHaveBeenCalledTimes(1)
  expect(result.routes[0].editableWaypoints).toEqual([publicPois[0]])
  expect(result.routes[0].routeOrder).toEqual({ source: 'recommended', orderedWaypointIds: ['A'] })
  expect(callCloudFunction.mock.calls.map(([name]) => name))
    .toEqual(['mapProvider', 'aiRoutePlanner'])
  expect(result.waypointCandidateCache.getUnusedCandidates()).toHaveLength(0)
})

test('malformed nested AI candidates use the deterministic fallback', async () => {
  cloudPlan({ candidates: [{ waypoints: null }] })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(result.routes).toHaveLength(1)
})

test('duration-aware fallback tries bounded POIs until one validates', async () => {
  const fallbackPois = [
    { ...pois[0], poiId: 'near', name: 'near', distanceInMeters: 100 },
    { ...pois[1], poiId: 'middle', name: 'middle', distanceInMeters: 900 },
    { ...pois[2], poiId: 'far', name: 'far', distanceInMeters: 1600 },
    { ...pois[3], poiId: 'second-far', name: 'second-far', distanceInMeters: 1500 }
  ]

  callCloudFunction.mockImplementation(async name => name === 'mapProvider'
    ? { poisByCategory: { park: fallbackPois } }
    : { plan: { candidates: [] } })

  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true,
    durationSeconds: to.nodeId === 'second-far' ? 2700 : 100,
    distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(getWalkingSegment.mock.calls.map(([, to]) => to.nodeId))
    .toEqual(['far', 'second-far'])
})

test.each([[15, 'near', 563], [30, 'far', 1000]])(
  'fallback for %i minutes prefers %s with duration-aware POI discovery',
  async (durationMinutes, expectedPoiId, expectedRadius) => {
    const fallbackPois = [
      { ...pois[0], poiId: 'near', distanceInMeters: 550 },
      { ...pois[1], poiId: 'far', distanceInMeters: 950 }
    ]
    callCloudFunction.mockImplementation(async name => name === 'mapProvider'
      ? { poisByCategory: { park: fallbackPois } }
      : { plan: { candidates: [] } })
    getWalkingSegment.mockImplementation(async (from, to) => ({
      success: true,
      durationSeconds: to.nodeId === 'near' ? 900 : 1800,
      distanceMeters: to.nodeId === 'near' ? 1100 : 2200,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
    }))

    const result = await generateRoutes({ ...preferences, durationMinutes })

    expect(callCloudFunction.mock.calls.filter(([name]) => name === 'mapProvider'))
      .toEqual([['mapProvider', {
        action: 'nearbyPois', ...location, radius: expectedRadius
      }, expect.any(Object)]])
    // Inspect the first attempted segment, not only the eventual valid route:
    // duration validation must not hide a duration-independent ranking.
    expect(getWalkingSegment.mock.calls.map(([, to]) => to.nodeId)).toEqual([expectedPoiId])
    expect(result).toMatchObject({ status: 'success', source: 'fallback' })
    expect(result.routes[0].pointsOfInterest.map(poi => poi.poiId)).toEqual([expectedPoiId])
    expect(result.routes[0].durationSeconds).toBe(durationMinutes * 60)
  }
)

test('initial generation skips a failed candidate and returns the next success before later candidates', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => from.nodeId === 'B' || to.nodeId === 'B'
    ? { success: false, error: 'ROUTE_NOT_FOUND' }
    : { success: true, durationSeconds: 1350, distanceMeters: 200, polyline: [from, to] })
  const result = await generateRoutes(preferences)
  expect(result.routes).toHaveLength(1)
  expect(result.routes[0].candidateWaypointIds).toEqual(['C', 'A'])
  expect(result.waypointCandidateCache.getAllCandidates().map(entry => entry.status))
    .toEqual(['failed', 'success', 'unused', 'unused'])
  expect(aiCalls()).toHaveLength(1)
})

test('rejects a candidate outside the requested duration range and tries the next candidate', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => {
    const touchesB = from.nodeId === 'B' || to.nodeId === 'B'
    return {
      success: true, durationSeconds: touchesB ? 100 : 1350, distanceMeters: 200,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
    }
  })

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('ai')
  expect(result.routes).toHaveLength(1)
  expect(result.routes[0].candidateWaypointIds).toEqual(['C', 'A'])
  expect(result.routes[0].durationSeconds).toBe(2700)
  expect(result.waypointCandidateCache.getAllCandidates().map(entry => entry.status))
    .toEqual(['failed', 'success', 'unused', 'unused'])
})

test('falls back after every AI candidate fails and validates the fallback route', async () => {
  getWalkingSegment.mockImplementation(async (from, to) => {
    if (from.nodeId === 'START' && to.nodeId === 'A') {
      return {
        success: true, durationSeconds: 2700, distanceMeters: 1000,
        polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
      }
    }

    return { success: false, error: 'ROUTE_NOT_FOUND' }
  })

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(result.routes).toHaveLength(1)
  expect(result.waypointCandidateCache.getUnusedCandidates()).toHaveLength(0)
})

test('route-build failures emit their stage and directed edge instead of bypassing the diagnostic log', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
    const failedSegment = { from: 'A', to: 'B', error: 'WALKING_SEGMENT_FAILED', causeCode: 'ROUTE_NOT_FOUND' }
    jest.spyOn(session, 'buildRouteForOrder').mockResolvedValue({ success: false, error: 'MULTI_SEGMENT_ROUTE_FAILED', failedSegment })
    const cache = createWaypointCandidateCache(candidates)
    await buildOptimizedCandidateRoute({ session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 })
    expect(warn).toHaveBeenCalledWith('[Route Generation] Candidate failed:', expect.objectContaining({
      stage: 'route_build', failedSegment, optimization: expect.objectContaining({ strategy: 'exact' })
    }))
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('latitude')
    expect(logged).not.toContain('polyline')
  } finally { warn.mockRestore() }
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])('exhausted rate limiting produces a temporary generation error, not an empty geographic result', async code => {
  jest.useFakeTimers()
  try {
    getWalkingSegment.mockResolvedValue({ success: false, error: code })
    const assertion = expect(generateRoutes(preferences)).rejects.toMatchObject({ code: code })
    await jest.runAllTimersAsync()
    await assertion
  } finally { jest.useRealTimers() }
})

test('defensive zero-point candidate never creates a successful route', async () => {
  cloudPlan({ candidates: [{ waypoints: [] }] })
  expect(await generateRoutes(preferences)).toMatchObject({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(3)
})

test('malformed AI plan uses the deterministic fallback', async () => {
  cloudPlan({ candidates: null })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
})

test('AI provider failure uses the deterministic fallback', async () => {
  callCloudFunction.mockImplementation(async name => {
    if (name === 'mapProvider') return { poisByCategory: { park: pois } }
    throw Object.assign(new Error('Unavailable'), { code: 'AI_REQUEST_FAILED' })
  })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  const result = await generateRoutes(preferences)

  expect(result.status).toBe('success')
  expect(result.source).toBe('fallback')
  expect(getCurrentLocation).toHaveBeenCalledTimes(1)
  expect(callCloudFunction.mock.calls.map(([name]) => name))
    .toEqual(['mapProvider', 'aiRoutePlanner'])
})

test('fallback also fails safely instead of exposing an invalid route', async () => {
  cloudPlan({ candidates: [] })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 100, distanceMeters: 200,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))

  expect(await generateRoutes(preferences))
    .toMatchObject({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(3)
})

test('failed walking segments produce empty and stay cached across candidates', async () => {
  getWalkingSegment.mockResolvedValue({ success: false, error: 'UNREACHABLE' })
  expect(await generateRoutes(preferences)).toMatchObject({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment).toHaveBeenCalledTimes(13)
})

test('a candidate is claimed once, including concurrent service calls', async () => {
  const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
  const cache = createWaypointCandidateCache(candidates)
  const options = { session, candidateCache: cache, candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 }
  const [first, second] = await Promise.all([
    buildOptimizedCandidateRoute(options), buildOptimizedCandidateRoute(options)
  ])
  expect(first.success).toBe(true)
  expect(second).toEqual({ success: false, error: 'CANDIDATE_NOT_UNUSED' })
  expect(cache.getAllCandidates()[0].status).toBe('success')
  expect(getWalkingSegment).toHaveBeenCalledTimes(4)
})

test('unexpected evaluation exceptions settle the candidate instead of leaving it building', async () => {
  const session = createRoutePlanningSession({ start: location, verifiedWaypointPool: pois })
  jest.spyOn(session, 'evaluateRouteOrder').mockRejectedValue(new Error('unexpected'))
  const cache = createWaypointCandidateCache(candidates)
  await expect(buildOptimizedCandidateRoute({ session, candidateCache: cache,
    candidate: cache.getUnusedCandidates()[0], location, candidateIndex: 0 })).rejects.toThrow('unexpected')
  expect(cache.getAllCandidates()[0].status).toBe('failed')
})
function sequencePlans(plans) {
  let index = 0
  callCloudFunction.mockImplementation(async name => name === 'mapProvider'
    ? { poisByCategory: { park: pois } }
    : { plan: plans[Math.min(index++, plans.length - 1)] })
}
const planSets = (...sets) => ({ candidates: sets.map(ids => ({ waypoints: ids.map(poiId => ({ poiId })) })) })
const aiCalls = () => callCloudFunction.mock.calls.filter(([name]) => name === 'aiRoutePlanner')

function historicalProfile(feedback = []) {
  return buildProfile({ ownerKey: 'private-owner', lastUpdatedAt: '2026-10-07T00:00:00Z',
    walks: [{ ownerKey: 'private-owner', walkId: 'walk-1', status: 'completed',
      endTime: '2026-10-06T00:00:00Z', actualDurationSeconds: 2400,
      preferences: { durationMinutes: 40, crowdPreference: 'low',
        environmentPreferences: ['公园', '水边', '街道', '商街'] } }], feedback })
}

const compactHistory = {
  environmentWeights: { park: 1, water: 0.67, street: 0.33, shoppingStreet: 0 },
  preferredDurationMinutes: 40, crowdPreferenceSignal: -1,
  likedTags: [], dislikedTags: [], evidenceWalkCount: 1
}

test('first-time user refreshes once and omits history from successful AI planning', async () => {
  expect((await generateRoutes(preferences)).source).toBe('ai')
  expect(refreshProfile).toHaveBeenCalledTimes(1)
  expect(refreshProfile).toHaveBeenCalledWith()
  expect(aiCalls()[0][1]).not.toHaveProperty('historicalPreferenceProfile')
})

test('public history is projected into a detached six-field snapshot without changing current intent', async () => {
  const profile = historicalProfile()
  refreshProfile.mockResolvedValue(profile)
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai')
  const input = aiCalls()[0][1]
  expect(result.historicalPreferenceProfile).toBe(input.historicalPreferenceProfile)
  expect(input.preferences).toEqual(preferences)
  expect(input.historicalPreferenceProfile).toEqual(compactHistory)
  profile.environmentWeights.park = 0
  profile.likedTags.push('quiet')
  expect(input.historicalPreferenceProfile).toEqual(compactHistory)
  for (const key of ['evidence', 'source', 'fingerprint', 'lastUpdatedAt', 'completedWalkCount',
    'endedEarlyWalkCount', 'feedbackCount', 'ownerKey', 'revision', 'history', 'comments']) {
    expect(JSON.stringify(input.historicalPreferenceProfile)).not.toContain(`"${key}"`)
  }
})

test.each([undefined, {}, { ...historicalProfile(), ownerKey: 'private-owner' },
  { ...historicalProfile(), preferredDurationMinutes: 31 }])('malformed public history is non-fatal: %#', async profile => {
  refreshProfile.mockResolvedValue(profile)
  expect((await generateRoutes(preferences)).source).toBe('ai')
  expect(aiCalls()[0][1]).not.toHaveProperty('historicalPreferenceProfile')
})

test('refresh failure is non-fatal and logs only a fixed safe code', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    refreshProfile.mockRejectedValue(Object.assign(new Error('private prompt GPS OPENID'), {
      code: { ownerKey: 'private-owner', profile: historicalProfile(), coordinates: location }
    }))
    expect((await generateRoutes(preferences)).source).toBe('ai')
    expect(aiCalls()[0][1]).not.toHaveProperty('historicalPreferenceProfile')
    expect(warn.mock.calls).toEqual([['[Route Generation] Preference profile unavailable:',
      { code: 'PREFERENCE_PROFILE_UNAVAILABLE' }]])
  } finally { warn.mockRestore() }
})

test('replanning reuses one history snapshot and still updates failure context', async () => {
  refreshProfile.mockResolvedValue(historicalProfile())
  sequencePlans([planSets(['A', 'B']), planSets(['A', 'C'])])
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: from.nodeId === 'B' || to.nodeId === 'B' ? 100 : 1350,
    distanceMeters: 200, polyline: [from, to]
  }))
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai-replanned')
  expect(result.historicalPreferenceProfile).toBe(aiCalls()[0][1].historicalPreferenceProfile)
  expect(refreshProfile).toHaveBeenCalledTimes(1)
  expect(aiCalls()).toHaveLength(2)
  expect(aiCalls()[0][1].historicalPreferenceProfile).toEqual(compactHistory)
  expect(aiCalls()[1][1].historicalPreferenceProfile).toBe(aiCalls()[0][1].historicalPreferenceProfile)
  expect(aiCalls()[0][1]).not.toHaveProperty('replanningContext')
  expect(aiCalls()[1][1].replanningContext).toMatchObject({ attempt: 2,
    previousFailures: [{ attempt: 1, waypointIds: ['A', 'B'], failure: { type: 'DURATION_TOO_SHORT' } }] })
})

test.each(['empty', 'error'])('AI %s uses identical fallback selection and walking facts with or without history', async mode => {
  callCloudFunction.mockImplementation(async name => {
    if (name === 'mapProvider') return { poisByCategory: { park: pois } }
    if (mode === 'error') throw Object.assign(new Error('AI unavailable'), { code: 'AI_REQUEST_FAILED' })
    return { plan: { candidates: [] } }
  })
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 1000, polyline: [from, to]
  }))
  const baseline = await generateRoutes(preferences)
  const baselineSegments = getWalkingSegment.mock.calls.map(([from, to]) => [from.nodeId, to.nodeId])
  getWalkingSegment.mockClear()
  refreshProfile.mockResolvedValue(historicalProfile())
  const personalized = await generateRoutes(preferences)
  expect(personalized.source).toBe('fallback')
  expect(personalized.historicalPreferenceProfile).toBe(aiCalls()[1][1].historicalPreferenceProfile)
  const facts = route => ({ ids: route.recommendedWaypointIds, duration: route.durationSeconds,
    distance: route.distanceMeters, polyline: route.polyline })
  expect(facts(personalized.routes[0])).toEqual(facts(baseline.routes[0]))
  expect(getWalkingSegment.mock.calls.map(([from, to]) => [from.nodeId, to.nodeId])).toEqual(baselineSegments)
  expect(aiCalls()[1][1].historicalPreferenceProfile).toEqual(compactHistory)
})

test('empty POIs and invalid locations never refresh history', async () => {
  callCloudFunction.mockResolvedValue({ poisByCategory: {} })
  expect(await generateRoutes(preferences)).toEqual({ status: 'empty', reason: 'NO_VALID_POI' })
  getCurrentLocation.mockResolvedValue(null)
  await expect(generateRoutes(preferences)).rejects.toMatchObject({ code: 'INVALID_LOCATION' })
  expect(refreshProfile).not.toHaveBeenCalled()
})

test('the next planning invocation refreshes feedback changes into the AI prompt', async () => {
  const changed = historicalProfile([{ ownerKey: 'private-owner', walkId: 'walk-1',
    createdAt: '2026-10-06T01:00:00Z', positiveTags: ['nice_view'], negativeTags: ['duration_too_long'] }])
  refreshProfile.mockResolvedValueOnce(historicalProfile()).mockResolvedValueOnce(changed)
  await generateRoutes(preferences)
  await generateRoutes(preferences)
  expect(refreshProfile).toHaveBeenCalledTimes(2)
  expect(aiCalls()[1][1].historicalPreferenceProfile).toMatchObject({
    likedTags: ['nice_view'], dislikedTags: ['duration_too_long'], preferredDurationMinutes: 35
  })
  const { buildRoutePlanningPrompt } = require('../cloudfunctions/aiRoutePlanner/routePlanningPrompt')
  const promptFor = call => buildRoutePlanningPrompt({ ...call[1], preferences: {
    ...preferences, crowdPreference: 'high', environmentPreferences: ['商街', '街道', '水边', '公园']
  } }).data.prompt
  expect(promptFor(aiCalls()[0])).not.toContain('nice_view')
  expect(promptFor(aiCalls()[1])).toContain('nice_view')
})

test('non-replannable provider failure stops remaining AI candidates and uses existing fallback', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  try {
    getWalkingSegment.mockResolvedValue({ success: false, error: 'WALKING_SEGMENT_FAILED', causeCode: 'CONFIG_MISSING' })
    const result = await generateRoutes(preferences)
    expect(aiCalls()).toHaveLength(1)
    const starts = log.mock.calls.filter(([message]) => message === '[Route Generation] Candidate start:')
    expect(starts).toHaveLength(1)
    expect(starts[0][1].waypointIds).toEqual(['B', 'A'])
    expect(result).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE', planningMetadata: {
      attemptCount: 1, replanned: false, fallbackUsed: true, failureTypes: ['ROUTE_BUILD_FAILED']
    } })
  } finally { log.mockRestore() }
})

test('invalid candidate scope is local and does not prevent another candidate from succeeding', async () => {
  cloudPlan(planSets(['unknown'], ['A', 'B']))
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai')
  expect(aiCalls()).toHaveLength(1)
  expect(result.planningMetadata).toEqual({ attemptCount: 1, replanned: false,
    fallbackUsed: false, failureTypes: ['INVALID_AI_PLAN'] })
  expect(getWalkingSegment.mock.calls.some(([from, to]) => from.nodeId === 'unknown' || to.nodeId === 'unknown')).toBe(false)
})

test('total failure retains unique safe AI-loop categories in first-occurrence order', async () => {
  sequencePlans([planSets(['A', 'B'], ['A', 'C']), planSets(['A', 'D']), planSets(['B', 'C'])])
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: from.nodeId === 'D' || to.nodeId === 'D' ? 4000 : 100,
    distanceMeters: 200, polyline: [from, to], rawPayload: 'private-data'
  }))
  const result = await generateRoutes(preferences)
  expect(result).toEqual({ status: 'empty', reason: 'NO_VALID_ROUTE', planningMetadata: {
    attemptCount: 3, replanned: true, fallbackUsed: true,
    failureTypes: ['DURATION_TOO_SHORT', 'DURATION_TOO_LONG']
  } })
  expect(aiCalls()).toHaveLength(3)
})

test('first attempt succeeds with metadata and no retry context', async () => {
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai')
  expect(result.planningMetadata).toEqual({ attemptCount: 1, replanned: false, fallbackUsed: false, failureTypes: [] })
  expect(aiCalls()).toHaveLength(1)
  expect(aiCalls()[0][1]).not.toHaveProperty('replanningContext')
})

test('all candidates are used before replanning, with shared directed cache and current alternatives', async () => {
  sequencePlans([planSets(['A', 'B'], ['A', 'D']), planSets(['B', 'A'], ['A', 'C'], ['A', 'E'])])
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true,
    durationSeconds: ['B', 'D'].includes(from.nodeId) || ['B', 'D'].includes(to.nodeId) ? 100 : 1350,
    distanceMeters: 200, polyline: [from, to]
  }))
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai-replanned')
  expect(result.planningMetadata).toEqual({ attemptCount: 2, replanned: true, fallbackUsed: false, failureTypes: ['DURATION_TOO_SHORT'] })
  expect(aiCalls()).toHaveLength(2)
  expect(aiCalls()[1][1].replanningContext).toEqual({ attempt: 2, previousFailures: [
    { attempt: 1, waypointIds: ['A', 'B'], failure: { type: 'DURATION_TOO_SHORT', actualDurationSeconds: 1450, targetDurationSeconds: 2700 } },
    { attempt: 1, waypointIds: ['A', 'D'], failure: { type: 'DURATION_TOO_SHORT', actualDurationSeconds: 1450, targetDurationSeconds: 2700 } }
  ] })
  expect(result.waypointCandidateCache.getAllCandidates().map(c => c.status)).toEqual(['failed', 'success', 'unused'])
  expect(result.waypointCandidateCache.getUnusedCandidates()[0].waypointIds).toEqual(['A', 'E'])
  expect(getWalkingSegment.mock.calls.filter(([from, to]) => from.nodeId === 'START' && to.nodeId === 'A')).toHaveLength(1)
  expect(getWalkingSegment).toHaveBeenCalledTimes(10)
  expect(getCurrentLocation).toHaveBeenCalledTimes(1)
})

test('repeated sets in another order stop at attempt two and fallback reuses resolved edges', async () => {
  sequencePlans([planSets(['A', 'B']), planSets(['B', 'A'])])
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 100, distanceMeters: 200, polyline: [from, to]
  }))
  const result = await generateRoutes(preferences)
  expect(aiCalls()).toHaveLength(2)
  expect(result).toMatchObject({ status: 'empty', reason: 'NO_VALID_ROUTE' })
  expect(getWalkingSegment.mock.calls.filter(([from, to]) => from.nodeId === 'START' && to.nodeId === 'A')).toHaveLength(1)
})

test('three distinct failed attempts exhaust the budget before deterministic fallback', async () => {
  sequencePlans([planSets(['A', 'B']), planSets(['A', 'C']), planSets(['A', 'D'])])
  getWalkingSegment.mockImplementation(async (from, to) => ({
    success: true, durationSeconds: 2700, distanceMeters: 200, polyline: [from, to]
  }))
  const result = await generateRoutes(preferences)
  expect(aiCalls()).toHaveLength(3)
  expect(result.source).toBe('fallback')
  expect(result.planningMetadata).toEqual({ attemptCount: 3, replanned: true, fallbackUsed: true, failureTypes: ['DURATION_TOO_LONG'] })
  expect(aiCalls()[2][1].replanningContext.previousFailures.map(o => o.failure.type))
    .toEqual(['DURATION_TOO_LONG', 'DURATION_TOO_LONG'])
})

test('invalid model output can recover on the next planning call', async () => {
  sequencePlans([{ candidates: null }, planSets(['A', 'B'])])
  const result = await generateRoutes(preferences)
  expect(result.source).toBe('ai-replanned')
  expect(aiCalls()[1][1].replanningContext.previousFailures).toEqual([
    { attempt: 1, waypointIds: [], failure: { type: 'INVALID_AI_PLAN' } }
  ])
})

test('fallback logs the final route failure after an earlier invalid AI plan', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    sequencePlans([{ candidates: null }, planSets(['A', 'B']), planSets(['A', 'C'])])
    getWalkingSegment.mockImplementation(async (from, to) => ({
      success: true, durationSeconds: 2700, distanceMeters: 200, polyline: [from, to]
    }))
    const result = await generateRoutes(preferences)
    expect(result.source).toBe('fallback')
    expect(aiCalls()).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith('[Route Generation] Falling back:',
      expect.objectContaining({ trigger: 'NO_VALID_AI_ROUTE' }))
    expect(warn).not.toHaveBeenCalledWith('[Route Generation] Falling back:',
      expect.objectContaining({ trigger: 'INVALID_AI_ROUTE_PLAN' }))
  } finally { warn.mockRestore() }
})

test('directed unwalkable observations omit provider data and precise location', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    sequencePlans([planSets(['A', 'B']), planSets(['A', 'C'])])
    getWalkingSegment.mockImplementation(async (from, to) => from.nodeId === 'B' || to.nodeId === 'B'
      ? { success: false, error: 'ROUTE_NOT_FOUND', rawPayload: 'private-provider-data', latitude: 30 }
      : { success: true, durationSeconds: 1350, distanceMeters: 200, polyline: [from, to] })
    expect((await generateRoutes(preferences)).source).toBe('ai-replanned')
    const observations = aiCalls()[1][1].replanningContext.previousFailures
    expect(observations[0].failure).toMatchObject({ type: 'UNWALKABLE_SEGMENT' })
    const safe = JSON.stringify([observations, log.mock.calls, warn.mock.calls])
    for (const forbidden of ['latitude', 'longitude', 'polyline', 'private-provider-data']) expect(safe).not.toContain(forbidden)
  } finally { log.mockRestore(); warn.mockRestore() }
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])('rate limiting stops before another candidate, another AI call, or fallback', async code => {
  jest.useFakeTimers()
  try {
    getWalkingSegment.mockResolvedValue({ success: false, error: code })
    const assertion = expect(generateRoutes(preferences)).rejects.toMatchObject({ code: code })
    await jest.runAllTimersAsync()
    await assertion
    expect(aiCalls()).toHaveLength(1)
    expect(getWalkingSegment.mock.calls.every(([from, to]) =>
      ['START', 'A', 'B'].includes(from.nodeId) && ['START', 'A', 'B'].includes(to.nodeId))).toBe(true)
  } finally { jest.useRealTimers() }
})
