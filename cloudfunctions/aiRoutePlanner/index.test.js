jest.mock("wx-server-sdk", () => ({
  init: jest.fn(),
  DYNAMIC_CURRENT_ENV: "test-env",
  ai: jest.fn()
}))

const {
  generateWaypointPlan
} = require("./index")

const VALID_EVENT = {
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
      poiId: "park-1",
      name: "Park A",
      category: "park",
      latitude: 45.501,
      longitude: -73.571,
      distanceInMeters: 350
    },
    {
      poiId: "water-1",
      name: "River B",
      category: "water",
      latitude: 45.503,
      longitude: -73.572,
      distanceInMeters: null
    }
  ]
}

describe("AI waypoint planner integration", () => {
  const history = {
    environmentWeights: { park: 1, water: 0, street: 0, shoppingStreet: 0 },
    preferredDurationMinutes: 40, crowdPreferenceSignal: -1,
    likedTags: ['quiet'], dislikedTags: [], evidenceWalkCount: 1
  }

  test.each(['park-1', 'invented-poi'])('history preserves verified POI validation: %s', async poiId => {
    const client = { request: jest.fn().mockResolvedValue({ success: true,
      data: { text: JSON.stringify({ candidates: [{ waypoints: [{ poiId }] }] }) } }) }
    const result = await generateWaypointPlan({ ...VALID_EVENT,
      historicalPreferenceProfile: { ...history, ownerKey: 'PRIVATE_SENTINEL', source: 'PRIVATE_SENTINEL' }
    }, client)
    expect(result).toEqual(poiId === 'park-1'
      ? { success: true, plan: { candidates: [{ waypoints: [{ poiId }] }] } }
      : { success: false, error: 'INVALID_AI_ROUTE_PLAN' })
    expect(client.request.mock.calls[0][0]).toContain(JSON.stringify(history, null, 2))
    expect(client.request.mock.calls[0][0]).not.toContain('PRIVATE_SENTINEL')
  })

  test('malformed history still requests a normal plan while invalid core inputs remain errors', async () => {
    const client = { request: jest.fn().mockResolvedValue({ success: true, data: { text: '{"candidates":[]}' } }) }
    const event = { ...VALID_EVENT, historicalPreferenceProfile: { ...history, likedTags: ['injected'] } }
    expect(await generateWaypointPlan(event, client)).toEqual({ success: true, plan: { candidates: [] } })
    expect(client.request.mock.calls[0][0]).not.toContain('HISTORICAL PREFERENCE PROFILE')
    expect(await generateWaypointPlan({ ...event, startPoint: null }, client))
      .toEqual({ success: false, error: 'INVALID_AI_ROUTE_INPUT' })
    expect(client.request).toHaveBeenCalledTimes(1)
  })
  test('returns an explicit empty plan as a successful no-result response', async () => {
    const client = { request: jest.fn().mockResolvedValue({
      success: true, data: { text: '{"candidates":[]}' }
    }) }
    expect(await generateWaypointPlan(VALID_EVENT, client)).toEqual({
      success: true, plan: { candidates: [] }
    })
  })
  test("returns a validated waypoint plan from a mocked AI response", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        success: true,
        data: {
          text: JSON.stringify({
            candidates: [
              {
                waypoints: [
                  { poiId: 'park-1' },
                  { poiId: 'water-1' }
                ]
              }
            ]
          })
        }
      })
    }

    const result =
      await generateWaypointPlan(
        VALID_EVENT,
        client
      )

    expect(result).toEqual({
      success: true,
      plan: {
        candidates: [
          {
            waypoints: [
              { poiId: 'park-1' },
              { poiId: 'water-1' }
            ]
          }
        ]
      }
    })

    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.request.mock.calls[0][0]).toContain(
      '"poiId": "park-1"'
    )
  })

  test("returns AI request failures without validating them as plans", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        success: false,
        error: "AI_REQUEST_FAILED"
      })
    }

    const result =
      await generateWaypointPlan(
        VALID_EVENT,
        client
      )

    expect(result).toEqual({
      success: false,
      error: "AI_REQUEST_FAILED"
    })
  })

  test("rejects an AI plan containing an unknown POI id", async () => {
    const client = {
      request: jest.fn().mockResolvedValue({
        success: true,
        data: {
          text: JSON.stringify({
            candidates: [
              {
                waypoints: [
                  { poiId: 'invented-poi' }
                ]
              }
            ]
          })
        }
      })
    }

    const result =
      await generateWaypointPlan(
        VALID_EVENT,
        client
      )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test.each([
    null,
    undefined,
    []
  ])(
    "returns invalid input for a non-object event: %p",
    async (event) => {
      const client = {
        request: jest.fn()
      }

      const result =
        await generateWaypointPlan(
          event,
          client
        )

      expect(result).toEqual({
        success: false,
        error: "INVALID_AI_ROUTE_INPUT"
      })

      expect(
        client.request
      ).not.toHaveBeenCalled()
    }
  )

  test("does not call AI when planner input is invalid", async () => {
    const client = {
      request: jest.fn()
    }

    const result =
      await generateWaypointPlan(
        {
          ...VALID_EVENT,
          nearbyPois: []
        },
        client
      )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    })

    expect(client.request).not.toHaveBeenCalled()
  })
})


test('later attempts keep the verified POI output contract', async () => {
  const client = { request: jest.fn().mockResolvedValue({ success: true,
    data: { text: JSON.stringify({ candidates: [{ waypoints: [{ poiId: 'unknown-poi' }] }] }) }
  }) }
  const result = await generateWaypointPlan({ ...VALID_EVENT, replanningContext: {
    attempt: 2, previousFailures: [{ attempt: 1, waypointIds: ['park-1'], failure: { type: 'NO_COMPLETE_ROUTE' } }]
  } }, client)
  expect(client.request.mock.calls[0][0]).toContain('PREVIOUS FAILED ATTEMPTS')
  expect(result).toEqual({ success: false, error: 'INVALID_AI_ROUTE_PLAN' })
})

describe('sanitized contract diagnostics', () => {
  let log, warn, error
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    error = jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  test.each(['mixed', 'malformed-json', 'malformed-plan', 'all-invalid', 'empty'])
  ('logs only aggregate counts and fixed codes for %s responses', async kind => {
    const privateId = 'PRIVATE_POI_SENTINEL'
    const event = { ...VALID_EVENT, nearbyPois: [
      { ...VALID_EVENT.nearbyPois[0], poiId: privateId, name: 'PRIVATE_NAME_SENTINEL',
        latitude: 23.123456789, longitude: 113.987654321 }
    ] }
    const valid = { waypoints: [{ poiId: privateId }] }
    const invalid = { waypoints: [{ poiId: 'PRIVATE_UNKNOWN_SENTINEL' }] }
    const texts = {
      mixed: JSON.stringify({ candidates: [valid, valid, invalid,
        { waypoints: [{ poiId: privateId, latitude: 23.123456789 }] }] }),
      'malformed-json': 'PRIVATE_RAW_SENTINEL invalid JSON',
      'malformed-plan': JSON.stringify({ candidates: [], text: 'PRIVATE_RAW_SENTINEL' }),
      'all-invalid': JSON.stringify({ candidates: [invalid] }),
      empty: '{"candidates":[]}'
    }
    const client = { request: jest.fn().mockResolvedValue({ success: true, data: { text: texts[kind] } }) }
    const result = await generateWaypointPlan(event, client)
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    const [label, summary] = log.mock.calls[0]
    expect(label).toBe('[AI Route Planner] Contract summary:')
    expect(summary).toMatchObject({ schemaVersion: 1 })
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]))
      .not.toMatch(/PRIVATE_|23\.123456789|113\.987654321|waypointIds|"poiId"/)
    if (kind === 'mixed') {
      expect(result).toEqual({ success: true, plan: { candidates: [valid] } })
      expect(summary).toMatchObject({ rawCandidateCount: 4, structurallyValidCount: 2,
        retainedCandidateCount: 1, removedCandidateCount: 3,
        removedByReason: { malformed_structure: 1, unverified_poi: 1, duplicate_set: 1 } })
    } else if (kind === 'empty') {
      expect(result).toEqual({ success: true, plan: { candidates: [] } })
      expect(summary.planRejectionReason).toBeNull()
    } else {
      expect(result).toEqual({ success: false, error: 'INVALID_AI_ROUTE_PLAN' })
      expect(summary.planRejectionReason).not.toBeNull()
    }
  })
})
