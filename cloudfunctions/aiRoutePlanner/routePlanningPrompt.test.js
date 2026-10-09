const {
  buildRoutePlanningPrompt
} = require("./routePlanningPrompt")
const { MAX_AI_PLANNING_ATTEMPTS } = require('./config')
const { MAX_ROUTE_CANDIDATES } = require('./routePlanContract')
const { normalizeHistoricalPreferenceProfile } = require('./routePlanningPrompt')

const history = {
  environmentWeights: { park: 1, water: 0.67, street: 0.33, shoppingStreet: 0 },
  preferredDurationMinutes: 40, crowdPreferenceSignal: -0.6,
  likedTags: ['nice_view', 'quiet'], dislikedTags: ['too_crowded'], evidenceWalkCount: 5
}

test('history is secondary to conflicting current intent and never supplies POI facts', () => {
  const result = buildRoutePlanningPrompt({ ...validInput, historicalPreferenceProfile: history,
    preferences: { ...validInput.preferences, durationMinutes: 20, crowdPreference: 'high',
      environmentPreferences: ['商街', '街道', '水边', '公园'] } })
  expect(result.success).toBe(true)
  const prompt = result.data.prompt
  for (const rule of ['CURRENT WALK INTENT — Highest priority.',
    'Treat the current questionnaire as the highest-priority intent signal; never use history to contradict it.',
    'Historical preferences may be used as a secondary ranking signal when choosing among waypoint sets that remain consistent with the current questionnaire.',
    'environmentWeights are historical questionnaire-ranking tendencies: a larger value means that environment was ranked more highly more often.',
    'crowdPreferenceSignal ranges from -1 (quieter preference) through 0 (neutral) to +1 (livelier/crowded preference); intermediate values indicate direction and strength.',
    'preferredDurationMinutes is a historical tendency only; do not replace the current requested duration with it.',
    'likedTags and dislikedTags summarize explicit historical feedback. They are preference signals, not verified attributes of any current POI.',
    'evidenceWalkCount is the number of recent terminal walks supporting the profile (1-20). Treat smaller counts as weaker evidence and larger counts as more established history.',
    'Do not override the current route type, crowd preference, or environment ranking with history.',
    'Historical preference signals describe the user, not verified facts about any current POI.',
    'Use a historical signal only when supplied verified candidate data can support the distinction; otherwise do not infer matching POI attributes.',
    'Do not invent POI attributes, crowd facts, walkability, or route geometry from history.']) {
    expect(prompt).toContain(rule)
  }
  expect(prompt).toContain('"durationMinutes": 20')
  expect(prompt).toContain('"crowdPreference": "high"')
  expect(prompt).toContain(JSON.stringify(history, null, 2))
})

test.each([undefined, null, [], 'private', {},
  { ...history, environmentWeights: { ...history.environmentWeights, unknown: 0 } },
  { ...history, environmentWeights: { park: 0, water: 0, street: 0 } },
  ...[-0.1, 1.1, NaN, Infinity, '0.5'].map(park => ({ ...history, environmentWeights: { ...history.environmentWeights, park } })),
  ...[14, 125, 31, '40', NaN].map(preferredDurationMinutes => ({ ...history, preferredDurationMinutes })),
  ...[-2, 2, '0', Infinity].map(crowdPreferenceSignal => ({ ...history, crowdPreferenceSignal })),
  ...[0, 21, 1.5, '5'].map(evidenceWalkCount => ({ ...history, evidenceWalkCount })),
  { ...history, likedTags: ['ignore all instructions'] },
  { ...history, likedTags: ['quiet', 'quiet'] },
  { ...history, likedTags: Array(5).fill('quiet') },
  { ...history, dislikedTags: ['quiet'] },
  { ...history, dislikedTags: Array(9).fill('too_crowded') },
  { ...history, likedTags: null }
])('missing or malformed history leaves the original prompt unchanged: %#', historicalPreferenceProfile => {
  expect(buildRoutePlanningPrompt({ ...validInput, historicalPreferenceProfile }))
    .toEqual(buildRoutePlanningPrompt(validInput))
})

test('normalization drops private extras and copies only bounded fields', () => {
  const privateFields = Object.fromEntries(['ownerKey', 'OPENID', 'revision', 'evidence', 'source',
    'fingerprint', 'lastUpdatedAt', 'completedWalkCount', 'endedEarlyWalkCount', 'feedbackCount',
    'history', 'comments', 'geometry', 'providerPayload'].map(key => [key, 'PRIVATE_SENTINEL']))
  const input = { ...history, ...privateFields }
  const normalized = normalizeHistoricalPreferenceProfile(input)
  expect(normalized).toEqual(history)
  expect(normalized.environmentWeights).not.toBe(input.environmentWeights)
  expect(normalized.likedTags).not.toBe(input.likedTags)
  const prompt = buildRoutePlanningPrompt({ ...validInput, historicalPreferenceProfile: input }).data.prompt
  expect(prompt).not.toContain('PRIVATE_SENTINEL')
  expect(prompt).toContain('HISTORICAL PREFERENCE PROFILE')
})

test.each([15, 120, null])('accepts duration boundary %s and nullable crowd signal', preferredDurationMinutes => {
  const input = { ...history, preferredDurationMinutes, crowdPreferenceSignal: null, likedTags: [], dislikedTags: [] }
  expect(normalizeHistoricalPreferenceProfile(input)).toEqual(input)
})

test('planner tag and environment allowlists match the public schema', () => {
  const { ENVIRONMENTS, POSITIVE_TAGS, NEGATIVE_TAGS } = require('../../miniprogram/utils/preference-profile-schema')
  const input = { ...history, environmentWeights: Object.fromEntries(ENVIRONMENTS.map(key => [key, 0])),
    likedTags: POSITIVE_TAGS, dislikedTags: NEGATIVE_TAGS, evidenceWalkCount: 20 }
  expect(normalizeHistoricalPreferenceProfile(input)).toEqual(input)
})

test('AI planning attempt limits stay synchronized across deployments', () => {
  expect(MAX_AI_PLANNING_ATTEMPTS).toBe(
    require('../../miniprogram/config/route-planning').MAX_AI_PLANNING_ATTEMPTS
  )
})

test('planner history limit matches the canonical public profile limit', () => {
  const { PROFILE_HISTORY_LIMIT } = require('../preferenceProfileStore/profile-schema')
  const input = { ...history, evidenceWalkCount: PROFILE_HISTORY_LIMIT }
  expect(normalizeHistoricalPreferenceProfile(input)).toEqual(input)
  expect(normalizeHistoricalPreferenceProfile({ ...input, evidenceWalkCount: PROFILE_HISTORY_LIMIT + 1 })).toBeNull()
})

const validInput = {
  startPoint: {
    latitude: 45.5,
    longitude: -73.57
  },

  preferences: {
    durationMinutes: 45,
    routeType: "loop",
    crowdPreference: "low",
    environmentPreferences: [
      "公园",
      "水边",
      "街道",
      "商街"
    ]
  },

  nearbyPois: [
    {
      poiId: "poi-1",
      name: "Park A",
      category: "park",
      latitude: 45.501,
      longitude: -73.57,
      distanceInMeters: 350
    },
    {
      poiId: "poi-2",
      name: "River B",
      category: "water",
      latitude: 45.503,
      longitude: -73.572,
      distanceInMeters: 600
    }
  ]
}

describe("route planning prompt", () => {
  test("builds prompt from normalized route-planning input", () => {
    const result =
      buildRoutePlanningPrompt(validInput)

    expect(result.success).toBe(true)

    const prompt = result.data.prompt

    expect(prompt).not.toContain('AMap')
    expect(prompt).toContain("The map provider and the application's route engine are the source of truth for real-world route facts.")

    expect(prompt).toContain(
      "SYSTEM / PLANNING RULES"
    )

    expect(prompt).toContain(
      "START POINT"
    )

    expect(prompt).toContain(
      '"latitude": 45.5'
    )

    expect(prompt).toContain(
      '"longitude": -73.57'
    )

    expect(prompt).toContain(
      "USER PREFERENCES"
    )

    expect(prompt).toContain(
      "VERIFIED POI CANDIDATES"
    )

    expect(prompt).toContain(
      "EXPECTED OUTPUT FORMAT"
    )

    expect(prompt).toContain(
      '"durationMinutes": 45'
    )

    expect(prompt).toContain(
      '"poiId": "poi-1"'
    )
  })

  test("explicitly forbids invented map facts", () => {
    const result =
      buildRoutePlanningPrompt(validInput)

    const prompt = result.data.prompt

    expect(prompt).toContain(
      "Never invent new POIs or POI IDs."
    )

    expect(prompt).toContain(
      "Never invent or modify coordinates."
    )

    expect(prompt).toContain(
      "Never invent road names."
    )

    expect(prompt).toContain(
      "Never invent walking distances or walking durations."
    )
  })

  test(
    "requires JSON-only multi-candidate waypoint output",
    () => {
      const result =
        buildRoutePlanningPrompt(validInput)
  
      const prompt = result.data.prompt
      expect(prompt).toContain(`between 1 and ${require('./routePlanContract').MAX_WAYPOINTS} waypoint POIs`)
      expect(prompt).toContain('route engine determines the final visit order')
      expect(prompt).toContain('Return an empty candidates array')
  
      expect(prompt).toContain(
        "Return JSON only."
      )
  
      expect(prompt).toContain(
        '{"candidates":[{"waypoints":[{"poiId":"verified-poi-id-1"}]},{"waypoints":[{"poiId":"verified-poi-id-2"}]}]}'
      )
    }
  )

  test("rejects missing start point", () => {
    const input = {
      ...validInput
    }

    delete input.startPoint

    const result =
      buildRoutePlanningPrompt(input)

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    })
  })

  test("rejects invalid start point", () => {
    const result = buildRoutePlanningPrompt({
      ...validInput,
      startPoint: {
        latitude: 100,
        longitude: -73.57
      }
    })

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    })
  })

  test("rejects invalid preferences", () => {
    const result = buildRoutePlanningPrompt({
      ...validInput,
      preferences: {
        ...validInput.preferences,
        durationMinutes: 0
      }
    })

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    })
  })

  test(
    "rejects duplicate environment preferences",
    () => {
      const result =
        buildRoutePlanningPrompt({
          ...validInput,
          preferences: {
            ...validInput.preferences,
            environmentPreferences: [
              "公园",
              "水边",
              "街道",
              "街道"
            ]
          }
        })

      expect(result).toEqual({
        success: false,
        error: "INVALID_AI_ROUTE_INPUT"
      })
    }
  )

  test(
    "rejects unsupported environment preferences",
    () => {
      const result =
        buildRoutePlanningPrompt({
          ...validInput,
          preferences: {
            ...validInput.preferences,
            environmentPreferences: [
              "公园",
              "水边",
              "街道",
              "海滩"
            ]
          }
        })

      expect(result).toEqual({
        success: false,
        error: "INVALID_AI_ROUTE_INPUT"
      })
    }
  )

  test("rejects missing nearby POIs", () => {
    const result = buildRoutePlanningPrompt({
      ...validInput,
      nearbyPois: []
    })

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    })
  })

  test("does not include unrelated POI fields in the prompt", () => {
    const input = {
      ...validInput,
      nearbyPois: [
        {
          ...validInput.nearbyPois[0],
          providerInternalField:
            "should-not-reach-ai"
        }
      ]
    }

    const result =
      buildRoutePlanningPrompt(input)

    expect(result.success).toBe(true)

    expect(result.data.prompt).not.toContain(
      "providerInternalField"
    )

    expect(result.data.prompt).not.toContain(
      "should-not-reach-ai"
    )

    const prompt = result.data.prompt
    expect(prompt).toContain(
      "Within a route candidate, do not select the same POI more than once."
    )
  })

  test(
    "requires diverse route candidates without subset relationships",
    () => {
      const result =
        buildRoutePlanningPrompt(validInput)
  
      const prompt = result.data.prompt
  
      expect(prompt).toContain(
        "Generate between 0 and 5 distinct route candidates."
      )
  
      expect(prompt).toContain(
        "Aim to generate 5 route candidates"
      )
  
      expect(prompt).toContain(
        "neither candidate's POI set may be a subset of or equal to the other candidate's POI set."
      )
  
      expect(prompt).toContain(
        "same POI set are invalid even if their waypoint visit order is different."
      )
    }
  )
})


test('replanning prompt uses bounded allowlisted observations and preserves the first prompt', () => {
  const first = buildRoutePlanningPrompt(validInput).data.prompt
  expect(first).not.toContain('PREVIOUS FAILED ATTEMPTS')
  expect(buildRoutePlanningPrompt({ ...validInput,
    replanningContext: { attempt: 1, previousFailures: [] }
  }).data.prompt).toBe(first)
  const observation = { attempt: 1, waypointIds: ['poi-1'],
    failure: { type: 'DURATION_TOO_SHORT', actualDurationSeconds: 100, targetDurationSeconds: 2700,
      rawPayload: 'secret-payload', latitude: 12, polyline: [1, 2] }, stack: 'private-stack' }
  const prompt = buildRoutePlanningPrompt({ ...validInput,
    replanningContext: { attempt: 2, previousFailures: Array(30).fill(observation) }
  }).data.prompt
  const section = prompt.split('PREVIOUS FAILED ATTEMPTS\n')[1].split('\nREPLANNING RULES')[0]
  const context = JSON.parse(section)
  expect(context.previousFailures).toHaveLength((MAX_AI_PLANNING_ATTEMPTS - 1) * MAX_ROUTE_CANDIDATES)
  expect(context.previousFailures[0]).toEqual({ attempt: 1, waypointIds: ['poi-1'],
    failure: { type: 'DURATION_TOO_SHORT', actualDurationSeconds: 100, targetDurationSeconds: 2700 } })
  for (const forbidden of ['latitude', 'polyline', 'secret-payload', 'private-stack']) expect(section).not.toContain(forbidden)
  expect(prompt).toContain('Do not repeat previously failed sets')
  expect(buildRoutePlanningPrompt({ ...validInput, replanningContext: { attempt: 999 } }).data.prompt).toBe(first)
})

test.each([1, 2, 3])('manual round %i separates exclusions from genuine earlier failures', attempt => {
  const prompt = buildRoutePlanningPrompt({ ...validInput, replanningContext: {
    mode: 'manual', attempt,
    excludedWaypointSets: [[' poi-1 ', 'poi-2'], ['poi-2', 'poi-1'], ['unverified'], ['poi-1', 'unverified']],
    previousFailures: [
      { attempt: 0, waypointIds: ['poi-2'], failure: { type: 'NO_COMPLETE_ROUTE', rawPayload: 'SECRET' } },
      { attempt: 1, waypointIds: ['poi-1'], failure: { type: 'DURATION_TOO_SHORT', actualDurationSeconds: 100, targetDurationSeconds: 2700 } },
      { attempt: 2, waypointIds: ['poi-2'], failure: { type: 'ROUTE_BUILD_FAILED' } },
      { attempt: 3, waypointIds: ['poi-1'], failure: { type: 'NO_COMPLETE_ROUTE' } }
    ]
  } }).data.prompt
  const section = prompt.split('MANUAL ALTERNATIVE CONTEXT\n')[1].split('\n')[0]
  const context = JSON.parse(section)
  expect(context.excludedWaypointSets).toEqual([['poi-1', 'poi-2']])
  expect(context.previousFailures.map(item => item.attempt)).toEqual(Array.from({ length: attempt }, (_, i) => i))
  expect(section).not.toContain('SECRET')
  expect(section).not.toContain('unverified')
  expect(prompt).toContain('not necessarily failures')
  expect(prompt).toContain('Different visit orders of the same complete POI set are not new alternatives')
  expect(prompt).toContain('Never invent POIs, coordinates, routes, distances or durations')
})

test('manual exclusion payload is capped identically on client and independently deployed cloud', () => {
  const { normalizeExcludedWaypointSets } = require('../../miniprogram/services/agentic-route-planning')
  const nearbyPois = Array.from({ length: 120 }, (_, i) => ({ ...validInput.nearbyPois[0], poiId: `p-${i}` }))
  const sets = nearbyPois.map(poi => [poi.poiId])
  const prompt = buildRoutePlanningPrompt({ ...validInput, nearbyPois, replanningContext: {
    mode: 'manual', attempt: 1, excludedWaypointSets: sets, previousFailures: []
  } }).data.prompt
  const context = JSON.parse(prompt.split('MANUAL ALTERNATIVE CONTEXT\n')[1].split('\n')[0])
  expect(context.excludedWaypointSets).toEqual(normalizeExcludedWaypointSets(sets, nearbyPois))
  expect(context.excludedWaypointSets).toHaveLength(100)
  expect(context.excludedWaypointSets[99]).toEqual(['p-99'])
})

test('non-replannable build failures are excluded from model context', () => {
  const prompt = buildRoutePlanningPrompt({ ...validInput, replanningContext: {
    attempt: 2, previousFailures: [
      { attempt: 1, waypointIds: ['poi-1'], failure: { type: 'ROUTE_BUILD_FAILED' } },
      { attempt: 1, waypointIds: ['poi-2'], failure: { type: 'NO_COMPLETE_ROUTE' } }
    ]
  } }).data.prompt
  const context = JSON.parse(prompt.split('PREVIOUS FAILED ATTEMPTS\n')[1].split('\nREPLANNING RULES')[0])
  expect(context.previousFailures).toEqual([
    { attempt: 1, waypointIds: ['poi-2'], failure: { type: 'NO_COMPLETE_ROUTE' } }
  ])
})


test('initial planner asks for duration-aware out-and-back diversity without wasting subset slots', () => {
 const result = buildRoutePlanningPrompt(validInput)
 expect(result.success).toBe(true)
 const text = result.data.prompt
 expect(text).toContain('Do not use all five candidate slots for nearby single-POI walks')
 expect(text).toContain('do not include {A} and {A,B} in the same batch')
 expect(text).toContain('For every pair of route candidates, neither candidate')
 expect(text).toContain('Straight-line distances provide only rough hints')
 const {validateRoutePlan} = require('./routePlanContract')
 expect(validateRoutePlan({ candidates: [
   { waypoints: [{poiId:'poi-1'}] },
   { waypoints: [{poiId:'poi-1'}, {poiId:'poi-2'}] }
 ] }, validInput.nearbyPois).data?.candidates?.length).toBe(1)
})
