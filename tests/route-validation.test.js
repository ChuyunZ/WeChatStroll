const {
  getAllowedDurationRange,
  validateGeneratedWalkingRoute
} = require(
  '../miniprogram/services/route-validation'
)

const {
  ROUTE_TYPES
} = require(
  '../miniprogram/constants/route-types'
)

const START = {
  latitude: 31.2304,
  longitude: 121.4737
}

const WAYPOINT_A = {
  poiId: 'poi-a',
  name: '公园 A',
  category: 'park',
  latitude: 31.231,
  longitude: 121.475
}

const WAYPOINT_B = {
  poiId: 'poi-b',
  name: '水边 B',
  category: 'water',
  latitude: 31.233,
  longitude: 121.478
}

function createSegment({
  from,
  to,
  startPoint,
  endPoint,
  distanceMeters = 500,
  durationSeconds = 450
}) {
  return {
    from,
    to,
    distanceMeters,
    durationSeconds,

    polyline: [
      {
        latitude: startPoint.latitude,
        longitude: startPoint.longitude
      },
      {
        latitude: endPoint.latitude,
        longitude: endPoint.longitude
      }
    ]
  }
}

function createPointToPointRoute({
  durationSeconds = 900,
  distanceMeters = 1000
} = {}) {
  const firstSegmentDuration =
    durationSeconds / 2

  const secondSegmentDuration =
    durationSeconds -
    firstSegmentDuration

  const firstSegmentDistance =
    distanceMeters / 2

  const secondSegmentDistance =
    distanceMeters -
    firstSegmentDistance

  const segments = [
    createSegment({
      from: 'START',
      to: WAYPOINT_A.poiId,
      startPoint: START,
      endPoint: WAYPOINT_A,
      distanceMeters:
        firstSegmentDistance,
      durationSeconds:
        firstSegmentDuration
    }),

    createSegment({
      from: WAYPOINT_A.poiId,
      to: WAYPOINT_B.poiId,
      startPoint: WAYPOINT_A,
      endPoint: WAYPOINT_B,
      distanceMeters:
        secondSegmentDistance,
      durationSeconds:
        secondSegmentDuration
    })
  ]

  return {
    success: true,

    distanceMeters,
    durationSeconds,

    durationMinutes:
      Math.ceil(
        durationSeconds / 60
      ),

    polyline: [
      START,
      WAYPOINT_A,
      WAYPOINT_B
    ].map(
      ({ latitude, longitude }) => ({
        latitude,
        longitude
      })
    ),

    waypoints: [
      { ...WAYPOINT_A },
      { ...WAYPOINT_B }
    ],

    segments,

    routeType:
      ROUTE_TYPES.POINT_TO_POINT,

    returnsToStart: false,

    routeOrder: {
      orderedWaypointIds: [
        WAYPOINT_A.poiId,
        WAYPOINT_B.poiId
      ],

      source: 'optimized'
    }
  }
}

function createLoopRoute() {
  const segments = [
    createSegment({
      from: 'START',
      to: WAYPOINT_A.poiId,
      startPoint: START,
      endPoint: WAYPOINT_A
    }),

    createSegment({
      from: WAYPOINT_A.poiId,
      to: 'START',
      startPoint: WAYPOINT_A,
      endPoint: START
    })
  ]

  return {
    success: true,

    distanceMeters: 1000,
    durationSeconds: 900,
    durationMinutes: 15,

    polyline: [
      START,
      WAYPOINT_A,
      START
    ].map(
      ({ latitude, longitude }) => ({
        latitude,
        longitude
      })
    ),

    waypoints: [
      { ...WAYPOINT_A }
    ],

    segments,

    routeType:
      ROUTE_TYPES.LOOP,

    returnsToStart: true,

    routeOrder: {
      orderedWaypointIds: [
        WAYPOINT_A.poiId
      ],

      source: 'optimized'
    }
  }
}

function createOutAndBackRoute() {
  const segments = [
    createSegment({
      from: 'START',
      to: WAYPOINT_A.poiId,
      startPoint: START,
      endPoint: WAYPOINT_A
    }),

    createSegment({
      from: WAYPOINT_A.poiId,
      to: WAYPOINT_B.poiId,
      startPoint: WAYPOINT_A,
      endPoint: WAYPOINT_B
    }),

    createSegment({
      from: WAYPOINT_B.poiId,
      to: WAYPOINT_A.poiId,
      startPoint: WAYPOINT_B,
      endPoint: WAYPOINT_A
    }),

    createSegment({
      from: WAYPOINT_A.poiId,
      to: 'START',
      startPoint: WAYPOINT_A,
      endPoint: START
    })
  ]

  return {
    success: true,

    distanceMeters: 2000,
    durationSeconds: 1800,
    durationMinutes: 30,

    polyline: [
      START,
      WAYPOINT_A,
      WAYPOINT_B,
      WAYPOINT_A,
      START
    ].map(
      ({ latitude, longitude }) => ({
        latitude,
        longitude
      })
    ),

    waypoints: [
      { ...WAYPOINT_A },
      { ...WAYPOINT_B }
    ],

    segments,

    routeType:
      ROUTE_TYPES.OUT_AND_BACK,

    returnsToStart: true,

    routeOrder: {
      orderedWaypointIds: [
        WAYPOINT_A.poiId,
        WAYPOINT_B.poiId
      ],

      source: 'optimized'
    }
  }
}

describe(
  'route validation',
  () => {
    describe(
      'getAllowedDurationRange',
      () => {
        test(
          'uses a 25 percent tolerance for a normal 30 minute request',
          () => {
            expect(
              getAllowedDurationRange(30)
            ).toEqual({
              valid: true,
              constrained: true,

              targetSeconds: 1800,
              toleranceSeconds: 450,

              minSeconds: 1350,
              maxSeconds: 2250
            })
          }
        )

        test(
          'uses the minimum five minute tolerance for short routes',
          () => {
            expect(
              getAllowedDurationRange(15)
            ).toEqual({
              valid: true,
              constrained: true,

              targetSeconds: 900,
              toleranceSeconds: 300,

              minSeconds: 600,
              maxSeconds: 1200
            })
          }
        )

        test(
          'caps tolerance at thirty minutes for long routes',
          () => {
            expect(
              getAllowedDurationRange(300)
            ).toEqual({
              valid: true,
              constrained: true,

              targetSeconds: 18000,
              toleranceSeconds: 1800,

              minSeconds: 16200,
              maxSeconds: 19800
            })
          }
        )

        test(
          'allows duration validation to be omitted',
          () => {
            expect(
              getAllowedDurationRange()
            ).toEqual({
              valid: true,
              constrained: false
            })
          }
        )

        test.each([
          0,
          -1,
          NaN,
          Infinity,
          '30'
        ])(
          'rejects invalid requested duration %p',
          value => {
            expect(
              getAllowedDurationRange(value)
            ).toEqual({
              valid: false,
              error:
                'INVALID_REQUESTED_DURATION'
            })
          }
        )
      }
    )

    test(
      'accepts a valid point-to-point route',
      () => {
        const route =
          createPointToPointRoute({
            durationSeconds: 1800
          })

        const result =
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId,
                WAYPOINT_B.poiId
              ],

              requestedDurationMinutes: 30
            }
          )

        expect(result).toEqual({
          valid: true,

          durationRange: {
            targetSeconds: 1800,
            toleranceSeconds: 450,
            minSeconds: 1350,
            maxSeconds: 2250
          }
        })
      }
    )

    test(
      'accepts optimizer reordering when the waypoint set is unchanged',
      () => {
        const route =
          createPointToPointRoute({
            durationSeconds: 1800
          })

        const result =
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_B.poiId,
                WAYPOINT_A.poiId
              ],

              requestedDurationMinutes: 30
            }
          )

        expect(result.valid).toBe(true)
      }
    )

    test(
      'accepts a valid loop route',
      () => {
        const route =
          createLoopRoute()

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId
              ],

              requestedDurationMinutes: 15
            }
          )
        ).toMatchObject({
          valid: true
        })
      }
    )

    test(
      'accepts a valid out-and-back route',
      () => {
        const route =
          createOutAndBackRoute()

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId,
                WAYPOINT_B.poiId
              ],

              requestedDurationMinutes: 30
            }
          )
        ).toMatchObject({
          valid: true
        })
      }
    )

    test(
      'rejects a route outside the requested duration range',
      () => {
        const route =
          createPointToPointRoute({
            durationSeconds: 600
          })

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId,
                WAYPOINT_B.poiId
              ],

              requestedDurationMinutes: 30
            }
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_DURATION_OUT_OF_RANGE',

          actualDurationSeconds: 600,
          targetDurationSeconds: 1800,
          minDurationSeconds: 1350,
          maxDurationSeconds: 2250
        })
      }
    )

    test(
      'accepts a valid route when no requested duration is supplied',
      () => {
        const route =
          createPointToPointRoute({
            durationSeconds: 600
          })

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId,
                WAYPOINT_B.poiId
              ]
            }
          )
        ).toEqual({
          valid: true
        })
      }
    )

    test(
      'rejects an invalid requested duration',
      () => {
        const route =
          createPointToPointRoute()

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId,
                WAYPOINT_B.poiId
              ],

              requestedDurationMinutes: 0
            }
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'INVALID_REQUESTED_DURATION'
        })
      }
    )

    test(
      'rejects a route with an unexpected waypoint',
      () => {
        const route =
          createPointToPointRoute()

        expect(
          validateGeneratedWalkingRoute(
            route,
            {
              allowedWaypointIds: [
                WAYPOINT_A.poiId
              ]
            }
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_WAYPOINT_SCOPE_MISMATCH'
        })
      }
    )

    test(
      'rejects duplicate route waypoints',
      () => {
        const route =
          createPointToPointRoute()

        route.waypoints = [
          { ...WAYPOINT_A },
          { ...WAYPOINT_A }
        ]

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'DUPLICATE_ROUTE_WAYPOINT',
          poiId: WAYPOINT_A.poiId
        })
      }
    )

    test(
      'rejects route order that disagrees with the final waypoint order',
      () => {
        const route =
          createPointToPointRoute()

        route.routeOrder
          .orderedWaypointIds = [
            WAYPOINT_B.poiId,
            WAYPOINT_A.poiId
          ]

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_ORDER_MISMATCH'
        })
      }
    )

    test(
      'rejects a missing segment',
      () => {
        const route =
          createPointToPointRoute()

        route.segments =
          route.segments.slice(0, 1)

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_SEGMENT_COUNT_MISMATCH',

          expectedSegmentCount: 2,
          actualSegmentCount: 1
        })
      }
    )

    test(
      'rejects a segment that connects the wrong route nodes',
      () => {
        const route =
          createPointToPointRoute()

        route.segments[1] = {
          ...route.segments[1],
          from: 'unexpected-poi'
        }

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_SEGMENT_ORDER_MISMATCH',

          segmentIndex: 1,
          expectedFrom:
            WAYPOINT_A.poiId,
          expectedTo:
            WAYPOINT_B.poiId,
          actualFrom:
            'unexpected-poi',
          actualTo:
            WAYPOINT_B.poiId
        })
      }
    )

    test(
      'rejects route distance that disagrees with segment totals',
      () => {
        const route =
          createPointToPointRoute()

        route.distanceMeters += 100

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_DISTANCE_MISMATCH'
        })
      }
    )

    test(
      'rejects route duration that disagrees with segment totals',
      () => {
        const route =
          createPointToPointRoute()

        route.durationSeconds += 100

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_DURATION_MISMATCH'
        })
      }
    )

    test(
      'rejects a final polyline that disagrees with segment polylines',
      () => {
        const route =
          createPointToPointRoute()

        route.polyline = [
          {
            latitude: START.latitude,
            longitude: START.longitude
          },
          {
            latitude: WAYPOINT_B.latitude,
            longitude: WAYPOINT_B.longitude
          }
        ]

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_POLYLINE_MISMATCH'
        })
      }
    )

    test(
      'rejects zero-distance routes from being displayed as real walks',
      () => {
        const route =
          createPointToPointRoute()

        route.distanceMeters = 0

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'INVALID_ROUTE_METRICS'
        })
      }
    )

    test(
      'rejects zero-duration routes from being displayed as real walks',
      () => {
        const route =
          createPointToPointRoute()

        route.durationSeconds = 0

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'INVALID_ROUTE_METRICS'
        })
      }
    )

    test(
      'rejects an invalid final route polyline',
      () => {
        const route =
          createPointToPointRoute()

        route.polyline = []

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'INVALID_ROUTE_POLYLINE'
        })
      }
    )

    test(
      'rejects invalid loop return behavior',
      () => {
        const route =
          createLoopRoute()

        route.returnsToStart = false

        expect(
          validateGeneratedWalkingRoute(
            route
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'ROUTE_RETURN_BEHAVIOR_MISMATCH'
        })
      }
    )

    test(
      'rejects malformed route results',
      () => {
        expect(
          validateGeneratedWalkingRoute(
            {
              success: false
            }
          )
        ).toEqual({
          valid: false,
          error:
            'ROUTE_VALIDATION_FAILED',
          reason:
            'INVALID_ROUTE_RESULT'
        })
      }
    )
  }
)