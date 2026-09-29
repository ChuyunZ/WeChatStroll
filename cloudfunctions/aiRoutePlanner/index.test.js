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
