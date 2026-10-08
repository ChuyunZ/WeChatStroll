const { scoreRoute, rankRoutes, RANKING_CONFIG } = require('../miniprogram/services/route-ranking')
const { rememberStreetEvidence } = require('../miniprogram/services/street-evidence')

const preferences = { durationMinutes: 30, environmentPreferences: ['公园', '水边', '街道', '商街'] }
const route = (id, minutes = 30, categories = ['park']) => ({
  routeId: `random-${id}`, durationSeconds: minutes * 60,
  recommendedWaypointIds: [id], pointsOfInterest: categories.map(category => ({ category }))
})
const context = { preferences, historicalPreferenceProfile: null }

test.each([0, 1, 2, 3])('Street rank %i is a separate positive-only bonus and preserves base components', index => {
  const labels = ['公园', '水边', '商街']
  labels.splice(index, 0, '街道')
  const input = { preferences: { ...preferences, environmentPreferences: labels },
    historicalPreferenceProfile: { environmentWeights: { park: 0.4, water: 0.6, street: 1 } } }
  for (const category of ['park', 'water']) {
    const candidate = { ...route('a', 30, [category]), distanceMeters: 1000 }
    const unknown = scoreRoute(candidate, input)
    for (const ratio of [0, 0.2, 1]) {
      rememberStreetEvidence(candidate, { coverageRatio: 1, ordinaryRoadRatio: ratio })
      const scored = scoreRoute(candidate, input)
      expect(scored.streetBonus).toBeCloseTo(0.05 * [1, 0.5, 0, 0][index] * ratio)
      expect(scored.baseScore).toBe(unknown.baseScore)
      expect(scored.components).toEqual(unknown.components)
      expect(scored.effectiveWeights).toEqual(unknown.effectiveWeights)
      expect(scored.totalScore).toBeGreaterThanOrEqual(unknown.totalScore)
      expect(candidate.pointsOfInterest).toEqual([{ category }])
    }
  }
})

test('trusted Street evidence changes ties deterministically without mutating or persisting routes', () => {
  const input = { preferences: { ...preferences, environmentPreferences: ['街道', '公园', '水边', '商街'] } }
  const a = Object.freeze({ ...route('a'), distanceMeters: 1000 })
  const b = Object.freeze({ ...route('b'), distanceMeters: 1000 })
  const before = JSON.stringify([a, b])
  rememberStreetEvidence(b, { coverageRatio: 1, ordinaryRoadRatio: 1 })
  expect(rankRoutes([a, b], input)).toEqual([b, a])
  expect(rankRoutes([b, a], input)).toEqual([b, a])
  expect(JSON.stringify([a, b])).toBe(before)
  expect(scoreRoute(JSON.parse(JSON.stringify(b)), input).streetEvidence).toBeNull()
  rememberStreetEvidence(a, { coverageRatio: 1, ordinaryRoadRatio: 1 })
  expect(rankRoutes([b, a], input)).toEqual([a, b])
  // Even the maximum bonus cannot overturn a sufficiently large base gap.
  const worse = rememberStreetEvidence({ ...route('c', 40), distanceMeters: 1000 }, { coverageRatio: 1, ordinaryRoadRatio: 1 })
  expect(rankRoutes([worse, a], input)).toEqual([a, worse])
})

test('Street cannot invent a base score or consume historical street as a second bonus', () => {
  const candidate = rememberStreetEvidence({ distanceMeters: 1000 }, { coverageRatio: 1, ordinaryRoadRatio: 1 })
  const input = { preferences: { environmentPreferences: ['街道', '公园', '水边', '商街'] },
    historicalPreferenceProfile: { environmentWeights: { street: 1 } } }
  expect(scoreRoute(candidate, input)).toMatchObject({ baseScore: null, totalScore: null, streetBonus: 0,
    components: { historyEnvironmentFit: null, currentEnvironmentFit: null } })
})

test.each([undefined, null, {}, { coverageRatio: 0, ordinaryRoadRatio: 1 },
  { coverageRatio: 1, ordinaryRoadRatio: -1 }, { coverageRatio: 2, ordinaryRoadRatio: 1 },
  { coverageRatio: '1', ordinaryRoadRatio: 1 }, { coverageRatio: 1, ordinaryRoadRatio: Infinity }
])('missing or invalid evidence never earns a bonus: %p', evidence => {
  const candidate = { ...route('a'), distanceMeters: 1000, streetEvidence: { coverageRatio: 1, ordinaryRoadRatio: 1 } }
  const input = { preferences: { ...preferences, environmentPreferences: ['街道', '公园', '水边', '商街'] } }
  expect(scoreRoute(candidate, input).streetEvidence).toBeNull()
  rememberStreetEvidence(candidate, evidence)
  expect(scoreRoute(candidate, input).streetBonus).toBe(0)
})

test('current duration uses real seconds and prefers 29 minutes to 35', () => {
  const a = route('a', 29), b = route('b', 35)
  expect(rankRoutes([b, a], context)).toEqual([a, b])
  expect(scoreRoute(a, context).components.durationFit).toBeCloseTo(1 - 1 / 30)
  expect(scoreRoute({ ...a, durationMinutes: 99 }, context)).toEqual(scoreRoute(a, context))
})

test('current environment uses fixed rank scores and unique verified categories', () => {
  const park = route('p'), water = route('w', 30, ['water'])
  expect(rankRoutes([water, park], context)).toEqual([park, water])
  for (const [category, expected] of [['park', 1], ['water', 0.67], ['shoppingStreet', 0]]) {
    expect(scoreRoute(route('a', 30, [category]), context).components.currentEnvironmentFit).toBe(expected)
  }
  const unique = scoreRoute(route('a', 30, ['park', 'water']), context)
  const duplicate = scoreRoute(route('a', 30, ['park', 'park', 'water']), context)
  expect(duplicate.components).toEqual(unique.components)
  expect(duplicate.totalScore).toBe(unique.totalScore)
  expect(unique.components.currentEnvironmentFit).toBe(0.835)
})

test('history environment breaks current ties, averaging only available unique categories', () => {
  const historicalPreferenceProfile = { environmentWeights: { park: 1, water: 0.67, shoppingStreet: 0 } }
  const input = { preferences: { durationMinutes: 30 }, historicalPreferenceProfile }
  const park = route('p'), water = route('w', 30, ['water'])
  expect(rankRoutes([water, park], input)).toEqual([park, water])
  expect(scoreRoute(route('a', 30, ['water', 'park', 'park']), input).components).toMatchObject({
    historyFit: 0.835, historyEnvironmentFit: 0.835, historyDurationFit: null
  })
})

test('historical duration breaks equidistant current ties but does not override clear current duration intent', () => {
  const input = { preferences, historicalPreferenceProfile: { preferredDurationMinutes: 40 } }
  const short = route('a', 25), long = route('b', 35)
  expect(rankRoutes([short, long], input)).toEqual([long, short])
  expect(scoreRoute(long, input).components.historyDurationFit).toBe(0.875)
  for (const historyMinutes of [45, 60]) {
    const current = route('a', 30), historical = route('b', 35)
    expect(rankRoutes([historical, current], { preferences,
      historicalPreferenceProfile: { preferredDurationMinutes: historyMinutes } })).toEqual([current, historical])
  }
})

test('weights are inspectable; absent history is excluded rather than scored zero', () => {
  const score = scoreRoute(route('a', 30, ['water']), context)
  expect(RANKING_CONFIG.weights).toEqual({ durationFit: 0.5, currentEnvironmentFit: 0.3, historyFit: 0.2 })
  expect(score.effectiveWeights).toEqual({ durationFit: 0.625, currentEnvironmentFit: 0.37499999999999994 })
  expect(score.components.historyFit).toBeNull()
  expect(score.totalScore).toBeCloseTo((0.5 + 0.3 * 0.67) / 0.8)
  const historyScore = scoreRoute(route('a'), { preferences,
    historicalPreferenceProfile: { environmentWeights: { park: 0.4 }, preferredDurationMinutes: 60 } })
  expect(historyScore.components.historyFit).toBe(0.45)
  expect(historyScore.totalScore).toBeCloseTo(0.5 + 0.3 + 0.2 * 0.45)
})

test('unknown facts and street are unavailable; tags, crowd, road metadata and prose are ignored', () => {
  const unknown = { ...route('u', 30, ['street', 'unknown']), tags: ['公园'], environmentStats: { park: 1 } }
  const score = scoreRoute(unknown, context)
  expect(score.components.currentEnvironmentFit).toBeNull()
  expect(score.totalScore).toBe(1)
  expect(score.effectiveWeights).toEqual({ durationFit: 1 })
  const input = { preferences, historicalPreferenceProfile: {
    crowdPreferenceSignal: 1, likedTags: ['quiet'], dislikedTags: ['too_crowded'],
    environmentWeights: { street: 1 }, preferredDurationMinutes: 40
  } }
  expect(scoreRoute(unknown, input).components).toMatchObject({
    historyEnvironmentFit: null, historyDurationFit: 0.75, historyFit: 0.75
  })
  const a = route('a'), b = route('b', 31)
  const ignored = { historicalPreferenceProfile: { crowdPreferenceSignal: -1, likedTags: ['nice_view'], dislikedTags: ['quiet'] }, preferences }
  expect(scoreRoute(a, ignored)).toEqual(scoreRoute(a, context))
  expect(rankRoutes([a, b], ignored)).toEqual(rankRoutes([a, b], context))
})

test('missing or invalid numbers stay unavailable and all-missing score is inspectable', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '30']) {
    const score = scoreRoute({ durationSeconds: value }, context)
    expect(score.totalScore).toBeNull()
    expect(score.tieBreak.durationErrorSeconds).toBeNull()
  }
  expect(scoreRoute(route('a'), { preferences: {}, historicalPreferenceProfile: { environmentWeights: { park: -1 } } }).totalScore).toBeNull()
})

test('tie break is canonical and independent of input order, generated identity and property insertion order', () => {
  const a = route('a'), b = route('b')
  expect(rankRoutes([b, a], context)).toEqual([a, b])
  expect(rankRoutes([a, b], context)).toEqual([a, b])
  expect(scoreRoute({ ...a, routeId: 'new-random', updatedAt: 'later' }, context)).toEqual(scoreRoute(a, context))
  expect(scoreRoute({ ...a, recommendedWaypointIds: ['b', 'a'] }, context).tieBreak.canonicalWaypointKey)
    .toBe(scoreRoute({ ...a, recommendedWaypointIds: ['a', 'b'] }, context).tieBreak.canonicalWaypointKey)
})

test.each(['fallback', 'legacy', 'shared-ids'])('%s tie uses stable facts when canonical IDs cannot distinguish routes', kind => {
  const a = { durationSeconds: 1800, distanceMeters: 1500, polyline: [{ latitude: 30, longitude: 120 }] }
  if (kind === 'fallback') a.pointsOfInterest = [{ poiId: 'verified', category: 'park' }]
  if (kind === 'shared-ids') a.recommendedWaypointIds = ['same']
  const b = { ...a, distanceMeters: 1600 }
  expect(rankRoutes([b, a], context)).toEqual(rankRoutes([a, b], context))
  expect(scoreRoute(a, context).tieBreak.canonicalRouteFactKey).not.toBe(scoreRoute(b, context).tieBreak.canonicalRouteFactKey)
})

test('ranking is pure and does not attach runtime metadata to routes', () => {
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
    return value
  }
  const routes = freeze([route('b'), route('a')])
  const input = freeze({ preferences: { ...preferences }, historicalPreferenceProfile: { environmentWeights: { park: 1 } } })
  const before = JSON.stringify({ routes, input })
  const ranked = rankRoutes(routes, input)
  expect(ranked).not.toBe(routes)
  expect(ranked[0]).toBe(routes[1])
  expect(JSON.stringify({ routes, input })).toBe(before)
  expect(ranked[0]).not.toHaveProperty('totalScore')
  expect(rankRoutes([], context)).toEqual([])
})


test.each([
  [1, 0.2, 1, 0.01],
  [1, 0.9, 1, 0.045],
  [1, 0.9, 0.5, 0.0225],
  [1, 1209 / 1213, 1, 0.05 * 1209 / 1213],
  [1, 1247 / 1252, 1, 0.05 * 1247 / 1252],
  [1, 1, 1, 0.05],
  [0.5, 0.2, 1, 0.005],
  [0, 0.2, 1, 0]
])('partial Street evidence gives proportional positive-only bonus: strength %p, coverage %p, ordinary %p', (strength, coverageRatio, ordinaryRoadRatio, expected) => {
  const positions = strength === 1 ? ['街道', '公园', '水边', '商街']
    : strength === 0.5 ? ['公园', '街道', '水边', '商街']
      : ['公园', '水边', '街道', '商街']
  const ctx = { preferences: { ...preferences, environmentPreferences: positions } }
  const candidate = { ...route('partial', 30), distanceMeters: 1000 }
  const baseline = scoreRoute(candidate, ctx)
  rememberStreetEvidence(candidate, { coverageRatio, ordinaryRoadRatio })
  const scored = scoreRoute(candidate, ctx)
  expect(scored.streetBonus).toBeCloseTo(expected)
  expect(scored.baseScore).toBe(baseline.baseScore)
  expect(scored.components).toEqual(baseline.components)
  expect(scored.effectiveWeights).toEqual(baseline.effectiveWeights)
  expect(scored.totalScore).toBeCloseTo(scored.baseScore + expected)
  expect(JSON.stringify(candidate)).not.toMatch(/coverageRatio|ordinaryRoadRatio|streetBonus/)
})

test('coverage near an old threshold does not create a sudden scoring jump', () => {
  const ctx = { preferences: { ...preferences,
    environmentPreferences: ['街道', '公园', '水边', '商街'] } }
  const bonuses = [0.198, 0.2, 0.899, 0.9, 0.995, 0.999, 1].map(coverageRatio => {
    const candidate = rememberStreetEvidence({ ...route('threshold'), distanceMeters: 1000 },
      { coverageRatio, ordinaryRoadRatio: 1, classificationComplete: true })
    expect(require('../miniprogram/services/street-evidence').getStreetEvidence(candidate)).toEqual({ coverageRatio, ordinaryRoadRatio: 1 })
    return scoreRoute(candidate, ctx).streetBonus
  })
  expect(bonuses).toEqual([...bonuses].sort((a, b) => a - b))
  expect(bonuses[1] - bonuses[0]).toBeCloseTo(0.05 * 0.002)
  expect(bonuses[3] - bonuses[2]).toBeCloseTo(0.05 * 0.001)
})

