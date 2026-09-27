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
  },
  {
    poiId: "poi-5",
    name: "Park E"
  },
  {
    poiId: "poi-6",
    name: "River F"
  }
]

describe("route plan contract", () => {
  test(
    "parses valid JSON multi-candidate route plan",
    () => {
      const result = parseRoutePlan(
        JSON.stringify({
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-2"
                }
              ]
            }
          ]
        })
      )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-2"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "rejects malformed JSON",
    () => {
      const result =
        parseRoutePlan(
          "not valid JSON"
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "accepts valid structured route candidates",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  },
                  {
                    poiId: "poi-4"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-5"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-3"
                },
                {
                  poiId: "poi-4"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-5"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "rejects missing candidates",
    () => {
      const result =
        validateRoutePlan(
          {},
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "rejects empty candidate list",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: []
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "rejects more than five candidates",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-4"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-5"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-6"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "discards a candidate with duplicate waypoint IDs while preserving valid candidates",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  },
                  {
                    poiId: "poi-3"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-4"
                  },
                  {
                    poiId: "poi-5"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-4"
                },
                {
                  poiId: "poi-5"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "discards a candidate with an unknown POI while preserving valid candidates",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId:
                      "unknown-poi"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "discards candidates with unexpected fields while preserving valid candidates",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  }
                ],
                reason:
                  "nice route"
              },
              {
                waypoints: [
                  {
                    poiId: "poi-4",
                    latitude: 45.5
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "rejects the plan when all candidates are invalid",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId:
                      "unknown-poi"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-1"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "selects the largest compatible candidate set instead of greedily keeping the first subset",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-3"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-4"
                  },
                  {
                    poiId: "poi-5"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-3"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-4"
                },
                {
                  poiId: "poi-5"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "treats candidates with the same POI set in a different order as conflicting",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-2"
                  },
                  {
                    poiId: "poi-1"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  },
                  {
                    poiId: "poi-4"
                  }
                ]
              }
            ]
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-3"
                },
                {
                  poiId: "poi-4"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "rejects unexpected top-level fields",
    () => {
      const result =
        validateRoutePlan(
          {
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  }
                ]
              }
            ],
            reason:
              "extra top-level field"
          },
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )

  test(
    "parses and validates a valid mocked AI response",
    () => {
      const result =
        parseAndValidateRoutePlan(
          JSON.stringify({
            candidates: [
              {
                waypoints: [
                  {
                    poiId: "poi-1"
                  },
                  {
                    poiId: "poi-2"
                  }
                ]
              },
              {
                waypoints: [
                  {
                    poiId: "poi-3"
                  },
                  {
                    poiId: "poi-4"
                  }
                ]
              }
            ]
          }),
          nearbyPois
        )

      expect(result).toEqual({
        success: true,
        data: {
          candidates: [
            {
              waypoints: [
                {
                  poiId: "poi-1"
                },
                {
                  poiId: "poi-2"
                }
              ]
            },
            {
              waypoints: [
                {
                  poiId: "poi-3"
                },
                {
                  poiId: "poi-4"
                }
              ]
            }
          ]
        }
      })
    }
  )

  test(
    "rejects malformed mocked AI response",
    () => {
      const result =
        parseAndValidateRoutePlan(
          "Here are your waypoint candidates",
          nearbyPois
        )

      expect(result).toEqual({
        success: false,
        error:
          "INVALID_AI_ROUTE_PLAN"
      })
    }
  )
})