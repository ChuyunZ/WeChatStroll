// Synthetic tests skip real-time pacing; fake-timer tests cover production intervals.
jest.mock('../miniprogram/config/route-planning', () => ({
  ...jest.requireActual('../miniprogram/config/route-planning'), WALKING_PROVIDER_MIN_INTERVAL_MS: 0
}))

const {
  START_NODE_ID,
  createRoutePlanningSession
} = require(
  '../miniprogram/services/route-engine'
)

const START = {
  latitude: 31.2304,
  longitude: 121.4737
}

const WAYPOINTS = [
  {
    poiId: 'A',
    name: 'Waypoint A',
    latitude: 31.231,
    longitude: 121.474,
    category: 'park'
  },
  {
    poiId: 'B',
    name: 'Waypoint B',
    latitude: 31.232,
    longitude: 121.475,
    category: 'water'
  },
  {
    poiId: 'C',
    name: 'Waypoint C',
    latitude: 31.233,
    longitude: 121.476,
    category: 'shoppingStreet'
  },
  {
    poiId: 'D',
    name: 'Waypoint D',
    latitude: 31.234,
    longitude: 121.477,
    category: 'park'
  },
  {
    poiId: 'E',
    name: 'Waypoint E',
    latitude: 31.235,
    longitude: 121.478,
    category: 'water'
  }
]

const ALL_WAYPOINT_IDS = [
  'A',
  'B',
  'C',
  'D',
  'E'
]

const SMALL_ROUTE_WAYPOINT_IDS = [
  'A',
  'B',
  'C'
]

function createEnvironmentStats() {
  return {
    totalStepDistanceMeters: 100,
    analyzedDistanceMeters: 80,
    unknownWalkTypeDistanceMeters: 20,
    normalRoadDistanceMeters: 60,
    normalRoadRatio: 0.6,
    walkTypeCoverageRatio: 0.8,

    walkTypeDistanceMeters: {
      '0': 60,
      '6': 20
    }
  }
}

function createSuccessfulSegment(
  fromNode,
  toNode,
  overrides = {}
) {
  return {
    success: true,

    distanceMeters: 100,
    durationSeconds: 61,

    polyline: [
      {
        latitude: fromNode.latitude,
        longitude: fromNode.longitude
      },
      {
        latitude: toNode.latitude,
        longitude: toNode.longitude
      }
    ],

    environmentStats:
      createEnvironmentStats(),

    ...overrides
  }
}

function createMockResolver({
  failedEdges = [],
  delayMilliseconds = 0
} = {}) {
  const failedEdgeSet =
    new Set(failedEdges)

  const resolver =
    jest.fn(
      async (
        fromNode,
        toNode
      ) => {
        const edge =
          `${fromNode.nodeId}->${toNode.nodeId}`

        if (delayMilliseconds > 0) {
          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                delayMilliseconds
              )
          )
        }

        if (
          failedEdgeSet.has(edge)
        ) {
          return {
            success: false,
            error:
              'WALKING_SEGMENT_FAILED',
            causeCode:
              'ROUTE_NOT_FOUND'
          }
        }

        return createSuccessfulSegment(
          fromNode,
          toNode
        )
      }
    )

  return resolver
}

function getRequestedEdges(resolver) {
  return resolver.mock.calls.map(
    ([fromNode, toNode]) =>
      `${fromNode.nodeId}->${toNode.nodeId}`
  )
}

function createSession({
  waypointPool = WAYPOINTS,
  routeType = 'point_to_point',
  segmentResolver =
    createMockResolver()
} = {}) {
  return createRoutePlanningSession({
    start: START,

    verifiedWaypointPool:
      waypointPool,

    routeType,

    segmentResolver
  })
}

describe(
  'route-engine',
  () => {
    test(
      'builds a point-to-point route and aggregates real segment data',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ],

              source:
                'recommended'
            })

        expect(result.success).toBe(
          true
        )

        expect(
          result.segments.map(
            segment => [
              segment.from,
              segment.to
            ]
          )
        ).toEqual([
          [
            START_NODE_ID,
            'A'
          ],
          [
            'A',
            'B'
          ],
          [
            'B',
            'C'
          ]
        ])

        expect(
          result.distanceMeters
        ).toBe(300)

        expect(
          result.durationSeconds
        ).toBe(183)

        expect(
          result.durationMinutes
        ).toBe(4)

        expect(
          result.routeType
        ).toBe(
          'point_to_point'
        )

        expect(
          result.returnsToStart
        ).toBe(false)

        expect(
          result.routeOrder
        ).toEqual({
          orderedWaypointIds: [
            'A',
            'B',
            'C'
          ],

          source:
            'recommended'
        })
      }
    )

    test(
      'merges segment polylines without duplicate boundary points',
      async () => {
        const session =
          createSession()

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ]
            })

        expect(
          result.polyline
        ).toEqual([
          {
            latitude:
              START.latitude,
            longitude:
              START.longitude
          },
          {
            latitude:
              WAYPOINTS[0]
                .latitude,
            longitude:
              WAYPOINTS[0]
                .longitude
          },
          {
            latitude:
              WAYPOINTS[1]
                .latitude,
            longitude:
              WAYPOINTS[1]
                .longitude
          },
          {
            latitude:
              WAYPOINTS[2]
                .latitude,
            longitude:
              WAYPOINTS[2]
                .longitude
          }
        ])
      }
    )

    test(
      'aggregates environment stats from all available segments',
      async () => {
        const session =
          createSession()

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ]
            })

        expect(
          result.environmentStats
        ).toEqual({
          totalStepDistanceMeters:
            300,

          analyzedDistanceMeters:
            240,

          unknownWalkTypeDistanceMeters:
            60,

          normalRoadDistanceMeters:
            180,

          normalRoadRatio:
            0.6,

          walkTypeCoverageRatio:
            0.8,

          walkTypeDistanceMeters: {
            '0': 180,
            '6': 60
          }
        })
      }
    )
    test(
      'drops inconsistent environment stats instead of producing invalid aggregate ratios',
      async () => {
        const resolver = jest.fn(
          async (fromNode, toNode) => {
            const segment = createSuccessfulSegment(
              fromNode,
              toNode
            )

            if (
              fromNode.nodeId === 'A' &&
              toNode.nodeId === 'B'
            ) {
              segment.environmentStats = {
                totalStepDistanceMeters: 1,
                analyzedDistanceMeters: 100,
                unknownWalkTypeDistanceMeters: 0,
                normalRoadDistanceMeters: 100,
                normalRoadRatio: 1,
                walkTypeCoverageRatio: 1,

                walkTypeDistanceMeters: {
                  '0': 100
                }
              }
            }

            return segment
          }
        )

        const session = createSession({
          segmentResolver: resolver
        })

        const result =
          await session.buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'B'
            ]
          })

        expect(result.success).toBe(true)

        expect(
          result.segments[1]
        ).not.toHaveProperty(
          'environmentStats'
        )

        expect(
          result
        ).not.toHaveProperty(
          'environmentStats'
        )
      }
    )
    test(
      'builds a loop route with a real final edge back to start',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            routeType: 'loop',
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(
          result.segments.map(
            segment => [
              segment.from,
              segment.to
            ]
          )
        ).toEqual([
          [
            START_NODE_ID,
            'A'
          ],
          [
            'A',
            'B'
          ],
          [
            'B',
            START_NODE_ID
          ]
        ])

        expect(
          result.returnsToStart
        ).toBe(true)
      }
    )

    test(
      'builds an out-and-back route using real reverse directed edges',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            routeType:
              'out_and_back',

            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ]
            })

        expect(
          result.segments.map(
            segment => [
              segment.from,
              segment.to
            ]
          )
        ).toEqual([
          [
            START_NODE_ID,
            'A'
          ],
          [
            'A',
            'B'
          ],
          [
            'B',
            'C'
          ],
          [
            'C',
            'B'
          ],
          [
            'B',
            'A'
          ],
          [
            'A',
            START_NODE_ID
          ]
        ])

        expect(
          result.returnsToStart
        ).toBe(true)
      }
    )

    test(
      'allows the active route to use only a subset of the verified waypoint pool',
      async () => {
        const session =
          createSession()

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'C',
                'A'
              ],

              source: 'user'
            })

        expect(result.success).toBe(
          true
        )

        expect(
          result.waypoints.map(
            waypoint =>
              waypoint.poiId
          )
        ).toEqual([
          'C',
          'A'
        ])

        expect(
          result.routeOrder
        ).toEqual({
          orderedWaypointIds: [
            'C',
            'A'
          ],

          source: 'user'
        })
      }
    )

    test(
      'allows a deleted waypoint to be added back later because the verified pool is preserved',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const firstRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'C'
              ]
            })

        expect(
          firstRoute.success
        ).toBe(true)

        expect(
          resolver
        ).toHaveBeenCalledTimes(2)

        const secondRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ]
            })

        expect(
          secondRoute.success
        ).toBe(true)

        /*
         * START→A was already cached.
         * Only A→B and B→C are new.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(4)

        expect(
          secondRoute
            .routeOrder
            .orderedWaypointIds
        ).toEqual([
          'A',
          'B',
          'C'
        ])
      }
    )

    test(
      'rejects a session waypoint that does not belong to the current candidate route',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'D'
              ]
            })

        expect(result).toEqual({
          success: false,

          error:
            'INVALID_ROUTE_ORDER',

          reason:
            'WAYPOINT_NOT_ALLOWED_FOR_ROUTE',

          poiId: 'D'
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'registers trusted waypoints later without losing the existing segment cache',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            waypointPool:
              WAYPOINTS.slice(0, 3),

            segmentResolver:
              resolver
          })

        const firstRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A',
                'B'
              ],

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(
          firstRoute.success
        ).toBe(true)

        expect(
          resolver
        ).toHaveBeenCalledTimes(2)

        const registration =
          session.registerVerifiedWaypoints([
            WAYPOINTS[3],
            WAYPOINTS[4]
          ])

        expect(registration).toEqual({
          registeredWaypointIds: [
            'D',
            'E'
          ],

          existingWaypointIds: [],
          totalWaypointCount: 5
        })

        const secondRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A',
                'E'
              ],

              orderedWaypointIds: [
                'A',
                'E'
              ]
            })

        expect(
          secondRoute.success
        ).toBe(true)

        /*
         * START→A was already cached.
         * Only A→E is new.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(3)

        const callCountBeforeRevisit =
          resolver.mock.calls.length

        const revisitedRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A',
                'B'
              ],

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(
          revisitedRoute.success
        ).toBe(true)

        expect(
          resolver.mock.calls.length
        ).toBe(
          callCountBeforeRevisit
        )
      }
    )

    test(
      'treats re-registering the same trusted waypoint as safe but rejects conflicting coordinates atomically',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            waypointPool: [
              WAYPOINTS[0]
            ],

            segmentResolver:
              resolver
          })

        expect(
          session.registerVerifiedWaypoints([
            {
              ...WAYPOINTS[0]
            }
          ])
        ).toEqual({
          registeredWaypointIds: [],
          existingWaypointIds: [
            'A'
          ],
          totalWaypointCount: 1
        })

        expect(() =>
          session.registerVerifiedWaypoints([
            WAYPOINTS[3],
            {
              ...WAYPOINTS[0],
              latitude:
                WAYPOINTS[0].latitude + 0.01
            }
          ])
        ).toThrow(
          expect.objectContaining({
            code:
              'CONFLICTING_VERIFIED_WAYPOINT'
          })
        )

        /*
         * Registration is atomic.
         * D appeared earlier in the rejected batch,
         * but it must not have been committed.
         */
        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'D'
              ],

              orderedWaypointIds: [
                'D'
              ]
            })

        expect(result).toEqual({
          success: false,
          error:
            'INVALID_ROUTE_ORDER',
          reason:
            'INVALID_ALLOWED_WAYPOINT_SCOPE',
          validationReason:
            'UNKNOWN_WAYPOINT_ID',
          poiId: 'D'
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'supports more than three candidate route builds in one planning session',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const candidateOrders = [
          [
            'A',
            'B',
            'C'
          ],
          [
            'B',
            'D',
            'E'
          ],
          [
            'A',
            'E'
          ],
          [
            'C',
            'D'
          ],
          [
            'E',
            'B',
            'A'
          ]
        ]

        for (
          const orderedWaypointIds
          of candidateOrders
        ) {
          const result =
            await session
              .buildRouteForOrder({
                allowedWaypointIds:
                  orderedWaypointIds,

                orderedWaypointIds,
                source: 'recommended'
              })

          expect(
            result.success
          ).toBe(true)
        }

        const callCountBeforeRevisit =
          resolver.mock.calls.length

        const revisitedRoute =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                candidateOrders[0],

              orderedWaypointIds:
                candidateOrders[0],

              source: 'recommended'
            })

        expect(
          revisitedRoute.success
        ).toBe(true)

        expect(
          resolver.mock.calls.length
        ).toBe(
          callCountBeforeRevisit
        )
      }
    )

    test(
      'rejects a waypoint that is outside the verified waypoint pool',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'UNKNOWN'
              ]
            })

        expect(result).toEqual({
          success: false,

          error:
            'INVALID_ROUTE_ORDER',

          reason:
            'UNKNOWN_WAYPOINT_ID',

          poiId:
            'UNKNOWN'
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'rejects duplicate waypoint ids in one active route',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'A'
              ]
            })

        expect(result).toEqual({
          success: false,

          error:
            'INVALID_ROUTE_ORDER',

          reason:
            'DUPLICATE_WAYPOINT_ID',

          poiId: 'A'
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'accepts an empty waypoint order as valid input but reports that no route segments exist',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: []
            })

        expect(result).toEqual({
          success: false,
          error:
            'NO_ROUTE_SEGMENTS'
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'treats A to B and B to A as different directed cache entries',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        await session
          .buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'B'
            ]
          })

        await session
          .buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'B',
              'A'
            ]
          })

        const requestedEdges =
          getRequestedEdges(
            resolver
          )

        expect(
          requestedEdges.filter(
            edge =>
              edge === 'A->B'
          )
        ).toHaveLength(1)

        expect(
          requestedEdges.filter(
            edge =>
              edge === 'B->A'
          )
        ).toHaveLength(1)

        expect(
          requestedEdges
        ).toEqual(
          expect.arrayContaining([
            `${START_NODE_ID}->A`,
            'A->B',
            `${START_NODE_ID}->B`,
            'B->A'
          ])
        )
      }
    )

    test(
      'reuses cached segments when a later route order needs the same edge',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        await session
          .buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'B',
              'C'
            ]
          })

        expect(
          resolver
        ).toHaveBeenCalledTimes(3)

        await session
          .buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'C'
            ]
          })

        /*
         * START→A already exists.
         * Only A→C is new.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(4)

        expect(
          getRequestedEdges(
            resolver
          ).filter(
            edge =>
              edge === 'A->C'
          )
        ).toHaveLength(1)
      }
    )

    test(
      'deduplicates concurrent requests for the same directed edges',
      async () => {
        const resolver =
          createMockResolver({
            delayMilliseconds: 10
          })

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const firstRequest =
          session.buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'B'
            ]
          })

        const secondRequest =
          session.buildRouteForOrder({
            allowedWaypointIds:
              ALL_WAYPOINT_IDS,

            orderedWaypointIds: [
              'A',
              'B'
            ]
          })

        const [
          firstResult,
          secondResult
        ] = await Promise.all([
          firstRequest,
          secondRequest
        ])

        expect(
          firstResult.success
        ).toBe(true)

        expect(
          secondResult.success
        ).toBe(true)

        /*
         * Required edges are only:
         * START→A
         * A→B
         *
         * Both route builds share
         * the same in-flight Promises.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(2)
      }
    )

    test(
      'prefetches only the complete small-N candidate graph even when the session knows more waypoints',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .prefetchSegments(
              SMALL_ROUTE_WAYPOINT_IDS
            )

        expect(result).toEqual({
          prefetched: true,

          edgeCount: 9,

          failedEdges: [],

          allEdgesAvailable: true
        })

        expect(
          new Set(
            getRequestedEdges(
              resolver
            )
          )
        ).toEqual(
          new Set([
            `${START_NODE_ID}->A`,
            `${START_NODE_ID}->B`,
            `${START_NODE_ID}->C`,

            'A->B',
            'A->C',

            'B->A',
            'B->C',

            'C->A',
            'C->B'
          ])
        )
      }
    )

    test(
      'rebuilds another small-N order entirely from prefetched cache',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        await session
          .prefetchSegments(
            SMALL_ROUTE_WAYPOINT_IDS
          )

        expect(
          resolver
        ).toHaveBeenCalledTimes(9)

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'C',
                'B',
                'A'
              ]
            })

        expect(result.success).toBe(
          true
        )

        expect(
          resolver
        ).toHaveBeenCalledTimes(9)
      }
    )

    test(
      'does not let one failed prefetched edge invalidate an unrelated valid route',
      async () => {
        const resolver =
          createMockResolver({
            failedEdges: [
              'A->B'
            ]
          })

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const prefetch =
          await session
            .prefetchSegments(
              SMALL_ROUTE_WAYPOINT_IDS
            )

        expect(
          prefetch.prefetched
        ).toBe(true)

        expect(
          prefetch
            .allEdgesAvailable
        ).toBe(false)

        expect(
          prefetch.failedEdges
        ).toContainEqual({
          from: 'A',
          to: 'B',

          error:
            'WALKING_SEGMENT_FAILED',

          causeCode:
            'ROUTE_NOT_FOUND'
        })

        const callCountAfterPrefetch =
          resolver.mock.calls.length

        /*
         * This route does not need A→B.
         */
        const route =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                SMALL_ROUTE_WAYPOINT_IDS,

              orderedWaypointIds: [
                'B',
                'C',
                'A'
              ]
            })

        expect(route.success).toBe(
          true
        )

        /*
         * Every required edge was
         * already prefetched.
         */
        expect(
          resolver.mock.calls.length
        ).toBe(
          callCountAfterPrefetch
        )
      }
    )

    test(
      'skips complete graph prefetch above the exact-ordering threshold and loads route edges lazily',
      async () => {
        const resolver =
          createMockResolver()

        const session =
          createSession({
            waypointPool:
              WAYPOINTS.slice(0, 5),

            segmentResolver:
              resolver
          })

        const prefetch =
          await session
            .prefetchSegments(
              ALL_WAYPOINT_IDS
            )

        expect(prefetch).toEqual({
          prefetched: false,

          reason:
            'ABOVE_EXACT_ORDERING_THRESHOLD',

          edgeCount: 0,

          failedEdges: []
        })

        expect(
          resolver
        ).not.toHaveBeenCalled()

        const route =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C',
                'D',
                'E'
              ]
            })

        expect(route.success).toBe(
          true
        )

        /*
         * Point-to-point:
         * START→A→B→C→D→E
         *
         * Only five required edges
         * are loaded.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(5)
      }
    )

    test(
      'limits simultaneous provider requests during prefetch',
      async () => {
        let activeRequests = 0
        let maximumActiveRequests = 0

        const resolver =
          jest.fn(
            async (
              fromNode,
              toNode
            ) => {
              activeRequests++

              maximumActiveRequests =
                Math.max(
                  maximumActiveRequests,
                  activeRequests
                )

              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    10
                  )
              )

              activeRequests--

              return createSuccessfulSegment(
                fromNode,
                toNode
              )
            }
          )

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        await session
          .prefetchSegments(
            SMALL_ROUTE_WAYPOINT_IDS
          )

        expect(
          maximumActiveRequests
        ).toBe(4)
      }
    )

    test(
      'normalizes a malformed successful resolver payload into a cached segment failure',
      async () => {
        const resolver =
          jest.fn(
            async () => ({
              success: true
            })
          )

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const firstResult =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A'
              ],

              orderedWaypointIds: [
                'A'
              ]
            })

        expect(firstResult).toEqual({
          success: false,
          error:
            'MULTI_SEGMENT_ROUTE_FAILED',

          failedSegment: {
            from: START_NODE_ID,
            to: 'A',
            error:
              'INVALID_WALKING_SEGMENT_RESPONSE'
          }
        })

        expect(
          resolver
        ).toHaveBeenCalledTimes(1)

        const secondResult =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A'
              ],

              orderedWaypointIds: [
                'A'
              ]
            })

        expect(
          secondResult.success
        ).toBe(false)

        /*
         * The normalized failed Promise
         * stays in the session L1 cache.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(1)
      }
    )

    test(
      'fails the whole route when one required walking segment fails',
      async () => {
        const resolver =
          createMockResolver({
            failedEdges: [
              'B->C'
            ]
          })

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B',
                'C'
              ]
            })

        expect(result).toEqual({
          success: false,

          error:
            'MULTI_SEGMENT_ROUTE_FAILED',

          failedSegment: {
            from: 'B',
            to: 'C',

            error:
              'WALKING_SEGMENT_FAILED',

            causeCode:
              'ROUTE_NOT_FOUND'
          }
        })

        expect(
          result
        ).not.toHaveProperty(
          'distanceMeters'
        )

        expect(
          result
        ).not.toHaveProperty(
          'polyline'
        )
      }
    )

    test(
      'caches a failed directed edge for the lifetime of the session',
      async () => {
        const resolver =
          createMockResolver({
            failedEdges: [
              'A->B'
            ]
          })

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const firstResult =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(
          firstResult.success
        ).toBe(false)

        expect(
          resolver
        ).toHaveBeenCalledTimes(2)

        const secondResult =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(
          secondResult.success
        ).toBe(false)

        /*
         * The failed A→B Promise and
         * successful START→A Promise
         * were both already cached.
         */
        expect(
          resolver
        ).toHaveBeenCalledTimes(2)
      }
    )

    test(
      'omits aggregate environment stats when one required segment has no environment metadata',
      async () => {
        const resolver =
          jest.fn(
            async (
              fromNode,
              toNode
            ) => {
              const segment =
                createSuccessfulSegment(
                  fromNode,
                  toNode
                )

              if (
                fromNode.nodeId ===
                  'A' &&
                toNode.nodeId ===
                  'B'
              ) {
                delete segment
                  .environmentStats
              }

              return segment
            }
          )

        const session =
          createSession({
            segmentResolver:
              resolver
          })

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A',
                'B'
              ]
            })

        expect(result.success).toBe(
          true
        )

        expect(
          result
        ).not.toHaveProperty(
          'environmentStats'
        )
      }
    )

    test(
      'normalizes an empty route source to unknown without restricting future source types',
      async () => {
        const session =
          createSession()

        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A'
              ],

              source: '   '
            })

        expect(
          result.routeOrder.source
        ).toBe('unknown')

        const secondResult =
          await session
            .buildRouteForOrder({
              allowedWaypointIds:
                ALL_WAYPOINT_IDS,

              orderedWaypointIds: [
                'A'
              ],

              source:
                'history'
            })

        expect(
          secondResult
            .routeOrder
            .source
        ).toBe('history')
      }
    )

    test(
      'rejects invalid session configuration immediately',
      () => {
        expect(() =>
          createRoutePlanningSession({
            start: {
              latitude: 999,
              longitude: 121
            },

            verifiedWaypointPool:
              []
          })
        ).toThrow(
          expect.objectContaining({
            code:
              'INVALID_ROUTE_START'
          })
        )

        expect(() =>
          createRoutePlanningSession({
            start: START,

            verifiedWaypointPool:
              [],

            routeType:
              'not-a-route-type'
          })
        ).toThrow(
          expect.objectContaining({
            code:
              'INVALID_ROUTE_TYPE'
          })
        )

        expect(() =>
          createRoutePlanningSession({
            start: START,

            verifiedWaypointPool: [
              WAYPOINTS[0],
              {
                ...WAYPOINTS[0]
              }
            ]
          })
        ).toThrow(
          expect.objectContaining({
            code:
              'DUPLICATE_VERIFIED_WAYPOINT'
          })
        )
      }
    )
  }
)