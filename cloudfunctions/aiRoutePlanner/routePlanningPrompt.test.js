const {
  buildRoutePlanningPrompt
} = require("./routePlanningPrompt")

const validInput = {
  preferences: {
    durationMinutes: 45,
    routeType: "loop",
    crowdPreference: "low",
    environmentPreferences: [
      "park",
      "water",
      "street",
      "shopping_mall"
    ]
  },

  nearbyPois: [
    {
      poiId: "poi-1",
      name: "Park A",
      category: "park",
      latitude: 45.501,
      longitude: -73.57,
      distanceMeters: 350
    },
    {
      poiId: "poi-2",
      name: "River B",
      category: "water",
      latitude: 45.503,
      longitude: -73.572,
      distanceMeters: 600
    }
  ]
}

describe("route planning prompt", () => {
  test("builds prompt from normalized route-planning input", () => {
    const result =
      buildRoutePlanningPrompt(validInput)

    expect(result.success).toBe(true)

    const prompt = result.data.prompt

    expect(prompt).toContain(
      "SYSTEM / PLANNING RULES"
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

  test("requires JSON-only waypoint output", () => {
    const result =
      buildRoutePlanningPrompt(validInput)

    const prompt = result.data.prompt

    expect(prompt).toContain(
      "Return JSON only."
    )

    expect(prompt).toContain(
      '{"waypoints":[{"poiId":"verified-poi-id"}]}'
    )
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
      "Do not select the same POI more than once."
    )
  })
})