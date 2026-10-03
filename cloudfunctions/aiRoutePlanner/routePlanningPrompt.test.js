const {
  buildRoutePlanningPrompt
} = require("./routePlanningPrompt")
const { MAX_AI_PLANNING_ATTEMPTS } = require('./config')
const { MAX_ROUTE_CANDIDATES } = require('./routePlanContract')

test('AI planning attempt limits stay synchronized across deployments', () => {
  expect(MAX_AI_PLANNING_ATTEMPTS).toBe(
    require('../../miniprogram/config/route-planning').MAX_AI_PLANNING_ATTEMPTS
  )
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
