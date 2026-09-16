const {
  parseRoutePlan,
  validateRoutePlan,
  parseAndValidateRoutePlan
} = require("./routePlanContract")

const nearbyPois = [
  {
    poiId: "poi-1",
    name: "Park A"
  },
  {
    poiId: "poi-2",
    name: "River B"
  },
  {
    poiId: "poi-3",
    name: "Street C"
  },
  {
    poiId: "poi-4",
    name: "Mall D"
  }
]

describe("route plan contract", () => {
  test("parses valid JSON route plan", () => {
    const result = parseRoutePlan(
      '{"waypoints":[{"poiId":"poi-1"}]}'
    )

    expect(result).toEqual({
      success: true,
      data: {
        waypoints: [
          {
            poiId: "poi-1"
          }
        ]
      }
    })
  })

  test("rejects malformed JSON", () => {
    const result = parseRoutePlan(
      "not valid JSON"
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("accepts a valid structured waypoint plan", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          { poiId: "poi-1" },
          { poiId: "poi-2" }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: true,
      data: {
        waypoints: [
          { poiId: "poi-1" },
          { poiId: "poi-2" }
        ]
      }
    })
  })

  test("rejects missing waypoints", () => {
    const result = validateRoutePlan(
      {},
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects empty waypoint list", () => {
    const result = validateRoutePlan(
      {
        waypoints: []
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects too many waypoints", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          { poiId: "poi-1" },
          { poiId: "poi-2" },
          { poiId: "poi-3" },
          { poiId: "poi-4" }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects duplicate waypoint IDs", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          { poiId: "poi-1" },
          { poiId: "poi-1" }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects unknown waypoint IDs", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          { poiId: "poi-999" }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects waypoint without poiId", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          {
            name: "Park A"
          }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects unexpected top-level fields", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          { poiId: "poi-1" }
        ],
        reason: "nice park"
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("rejects unexpected waypoint fields", () => {
    const result = validateRoutePlan(
      {
        waypoints: [
          {
            poiId: "poi-1",
            latitude: 45.5
          }
        ]
      },
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })

  test("parses and validates a valid mocked AI response", () => {
    const result = parseAndValidateRoutePlan(
      '{"waypoints":[{"poiId":"poi-1"},{"poiId":"poi-3"}]}',
      nearbyPois
    )

    expect(result).toEqual({
      success: true,
      data: {
        waypoints: [
          { poiId: "poi-1" },
          { poiId: "poi-3" }
        ]
      }
    })
  })

  test("rejects malformed mocked AI response", () => {
    const result = parseAndValidateRoutePlan(
      "Here are your waypoints: poi-1",
      nearbyPois
    )

    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    })
  })
})