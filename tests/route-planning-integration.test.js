const {
  parseAndValidateRoutePlan
} = require(
  '../cloudfunctions/aiRoutePlanner/routePlanContract'
)

const {
  buildRoutePlanningPrompt
} = require(
  '../cloudfunctions/aiRoutePlanner/routePlanningPrompt'
)

const {
  createRoutePlanningSession
} = require(
  '../miniprogram/services/route-engine'
)

const START = {
  latitude: 23.129158,
  longitude: 113.264939
}

const PREFERENCES = {
  durationMinutes: 30,

  routeType:
    'point_to_point',

  crowdPreference:
    'low',

  environmentPreferences: [
    '公园',
    '水边',
    '商街',
    '街道'
  ]
}

const POIS = {
  A: {
    poiId: 'A',
    name: '公园 A',
    category: 'park',
    latitude: 23.1301,
    longitude: 113.2651,
    distanceMeters: 180
  },

  B: {
    poiId: 'B',
    name: '水边 B',
    category: 'water',
    latitude: 23.1312,
    longitude: 113.2662,
    distanceMeters: 320
  },

  C: {
    poiId: 'C',
    name: '商街 C',
    category: 'shoppingStreet',
    latitude: 23.1323,
    longitude: 113.2673,
    distanceMeters: 470
  },

  D: {
    poiId: 'D',
    name: '公园 D',
    category: 'park',
    latitude: 23.1334,
    longitude: 113.2684,
    distanceMeters: 620
  },

  E: {
    poiId: 'E',
    name: '水边 E',
    category: 'water',
    latitude: 23.1345,
    longitude: 113.2695,
    distanceMeters: 760
  },

  F: {
    poiId: 'F',
    name: '商街 F',
    category: 'shoppingStreet',
    latitude: 23.1356,
    longitude: 113.2706,
    distanceMeters: 910
  }
}

function createSegmentResolver() {
  return jest.fn(
    async (
      fromNode,
      toNode
    ) => ({
      success: true,

      distanceMeters: 100,

      durationSeconds: 60,

      polyline: [
        {
          latitude:
            fromNode.latitude,

          longitude:
            fromNode.longitude
        },
        {
          latitude:
            toNode.latitude,

          longitude:
            toNode.longitude
        }
      ]
    })
  )
}

function getCandidateContract(
  nearbyPois,
  rawAiOutput
) {
  const aiResult =
    parseAndValidateRoutePlan(
      rawAiOutput,
      nearbyPois
    )

  expect(
    aiResult.success
  ).toBe(true)

  return {
    allowedWaypointIds:
      nearbyPois.map(
        poi => poi.poiId
      ),

    orderedWaypointIds:
      aiResult.data.waypoints.map(
        waypoint =>
          waypoint.poiId
      )
  }
}

describe(
  'AI route planning contract + route planning session integration',
  () => {

    test(
      'preserves AI waypoint order from prompt contract through the route engine',
      async () => {
        const nearbyPois = [
          POIS.A,
          POIS.B,
          POIS.C
        ]

        const promptResult =
          buildRoutePlanningPrompt({
            startPoint:
              START,

            preferences:
              PREFERENCES,

            nearbyPois
          })

        expect(
          promptResult.success
        ).toBe(true)

        expect(
          promptResult.data.prompt
        ).toContain(
          JSON.stringify(
            START,
            null,
            2
          )
        )

        const candidate =
          getCandidateContract(
            nearbyPois,

            JSON.stringify({
              waypoints: [
                {
                  poiId: 'B'
                },
                {
                  poiId: 'A'
                },
                {
                  poiId: 'C'
                }
              ]
            })
          )

        const segmentResolver =
          createSegmentResolver()

        const session =
          createRoutePlanningSession({
            start:
              START,

            verifiedWaypointPool:
              nearbyPois,

            routeType:
              PREFERENCES.routeType,

            segmentResolver
          })

        const route =
          await session
            .buildRouteForOrder({
              ...candidate,

              source:
                'ai'
            })

        expect(
          route.success
        ).toBe(true)

        expect(
          route.routeOrder
        ).toEqual({
          orderedWaypointIds: [
            'B',
            'A',
            'C'
          ],

          source:
            'ai'
        })

        expect(
          route.waypoints.map(
            waypoint =>
              waypoint.poiId
          )
        ).toEqual([
          'B',
          'A',
          'C'
        ])

        expect(
          route.segments.map(
            segment =>
              `${segment.from}->${segment.to}`
          )
        ).toEqual([
          'START->B',
          'B->A',
          'A->C'
        ])
      }
    )

    test(
      'adds newly verified AI candidate POIs to the same session and reuses cached edges across recommendations',
      async () => {
        const segmentResolver =
          createSegmentResolver()

        const session =
          createRoutePlanningSession({
            start:
              START,

            verifiedWaypointPool: [
              POIS.A,
              POIS.B,
              POIS.C
            ],

            routeType:
              'point_to_point',

            segmentResolver
          })

        const firstCandidate =
          getCandidateContract(
            [
              POIS.A,
              POIS.B,
              POIS.C
            ],

            JSON.stringify({
              waypoints: [
                {
                  poiId: 'A'
                },
                {
                  poiId: 'B'
                },
                {
                  poiId: 'C'
                }
              ]
            })
          )

        const firstRoute =
          await session
            .buildRouteForOrder({
              ...firstCandidate,

              source:
                'ai-recommendation-1'
            })

        expect(
          firstRoute.success
        ).toBe(true)

        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          3
        )

        const registration =
          session
            .registerVerifiedWaypoints([
              POIS.A,
              POIS.B,
              POIS.D
            ])

        expect(
          registration
        ).toEqual({
          registeredWaypointIds: [
            'D'
          ],

          existingWaypointIds: [
            'A',
            'B'
          ],

          totalWaypointCount:
            4
        })

        const secondCandidate =
          getCandidateContract(
            [
              POIS.A,
              POIS.B,
              POIS.D
            ],

            JSON.stringify({
              waypoints: [
                {
                  poiId: 'A'
                },
                {
                  poiId: 'B'
                },
                {
                  poiId: 'D'
                }
              ]
            })
          )

        const secondRoute =
          await session
            .buildRouteForOrder({
              ...secondCandidate,

              source:
                'ai-recommendation-2'
            })

        expect(
          secondRoute.success
        ).toBe(true)

        /*
         * Route 1:
         *
         * START→A
         * A→B
         * B→C
         *
         * Route 2:
         *
         * START→A  cached
         * A→B      cached
         * B→D      new
         */
        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          4
        )

        const revisitedFirstRoute =
          await session
            .buildRouteForOrder({
              ...firstCandidate,

              source:
                'revisited'
            })

        expect(
          revisitedFirstRoute.success
        ).toBe(true)

        /*
         * Reopening Route 1 must
         * use the same L1 cache.
         */
        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          4
        )
      }
    )

    test(
      'keeps candidate-specific allowed waypoint scopes isolated inside one shared session',
      async () => {
        const segmentResolver =
          createSegmentResolver()

        const session =
          createRoutePlanningSession({
            start:
              START,

            verifiedWaypointPool: [
              POIS.A,
              POIS.B,
              POIS.C,
              POIS.D
            ],

            routeType:
              'point_to_point',

            segmentResolver
          })

        const secondCandidate =
          getCandidateContract(
            [
              POIS.A,
              POIS.D
            ],

            JSON.stringify({
              waypoints: [
                {
                  poiId: 'A'
                },
                {
                  poiId: 'D'
                }
              ]
            })
          )

        /*
         * D is trusted by the session,
         * but NOT allowed for Candidate 1.
         */
        const result =
          await session
            .buildRouteForOrder({
              allowedWaypointIds: [
                'A',
                'B',
                'C'
              ],

              orderedWaypointIds:
                secondCandidate
                  .orderedWaypointIds,

              source:
                'wrong-candidate-scope'
            })

        expect(result).toEqual({
          success:
            false,

          error:
            'INVALID_ROUTE_ORDER',

          reason:
            'WAYPOINT_NOT_ALLOWED_FOR_ROUTE',

          poiId:
            'D'
        })

        expect(
          segmentResolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'supports more than three AI recommendations in one planning session',
      async () => {
        const segmentResolver =
          createSegmentResolver()

        const session =
          createRoutePlanningSession({
            start:
              START,

            verifiedWaypointPool: [
              POIS.A
            ],

            routeType:
              'point_to_point',

            segmentResolver
          })

        const candidates = [
          POIS.A,
          POIS.B,
          POIS.C,
          POIS.D
        ]

        const routes = []

        for (
          const poi
          of candidates
        ) {
          session
            .registerVerifiedWaypoints([
              poi
            ])

          const candidate =
            getCandidateContract(
              [
                poi
              ],

              JSON.stringify({
                waypoints: [
                  {
                    poiId:
                      poi.poiId
                  }
                ]
              })
            )

          routes.push(
            await session
              .buildRouteForOrder({
                ...candidate,

                source:
                  `ai-${poi.poiId}`
              })
          )
        }

        expect(
          routes
        ).toHaveLength(4)

        expect(
          routes.every(
            route =>
              route.success === true
          )
        ).toBe(true)

        expect(
          routes.map(
            route =>
              route.routeOrder
                .orderedWaypointIds[0]
          )
        ).toEqual([
          'A',
          'B',
          'C',
          'D'
        ])

        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          4
        )
      }
    )

    test(
      'rejects an AI-invented POI before any walking segment is resolved',
      async () => {
        const nearbyPois = [
          POIS.A,
          POIS.B,
          POIS.C
        ]

        const aiResult =
          parseAndValidateRoutePlan(
            JSON.stringify({
              waypoints: [
                {
                  poiId:
                    'INVENTED'
                }
              ]
            }),

            nearbyPois
          )

        expect(
          aiResult
        ).toEqual({
          success:
            false,

          error:
            'INVALID_AI_ROUTE_PLAN'
        })

        const segmentResolver =
          createSegmentResolver()

        createRoutePlanningSession({
          start:
            START,

          verifiedWaypointPool:
            nearbyPois,

          routeType:
            'point_to_point',

          segmentResolver
        })

        expect(
          segmentResolver
        ).not.toHaveBeenCalled()
      }
    )

    test(
      'uses the AI candidate scope for prefetch and builds the selected order entirely from the prefetched cache',
      async () => {
        const segmentResolver =
          createSegmentResolver()

        const session =
          createRoutePlanningSession({
            start:
              START,

            verifiedWaypointPool: [
              POIS.A,
              POIS.B,
              POIS.C,
              POIS.D
            ],

            routeType:
              'point_to_point',

            segmentResolver
          })

        const candidate =
          getCandidateContract(
            [
              POIS.A,
              POIS.B,
              POIS.C
            ],

            JSON.stringify({
              waypoints: [
                {
                  poiId: 'B'
                },
                {
                  poiId: 'A'
                },
                {
                  poiId: 'C'
                }
              ]
            })
          )

        const prefetchResult =
          await session
            .prefetchSegments(
              candidate
                .allowedWaypointIds
            )

        expect(
          prefetchResult
        ).toEqual({
          prefetched:
            true,

          edgeCount:
            9,

          failedEdges:
            [],

          allEdgesAvailable:
            true
        })

        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          9
        )

        const route =
          await session
            .buildRouteForOrder({
              ...candidate,

              source:
                'ai-prefetched'
            })

        expect(
          route.success
        ).toBe(true)

        expect(
          route.routeOrder
        ).toEqual({
          orderedWaypointIds: [
            'B',
            'A',
            'C'
          ],

          source:
            'ai-prefetched'
        })

        /*
         * START→B, B→A and A→C
         * were already included in
         * the candidate prefetch graph.
         */
        expect(
          segmentResolver
        ).toHaveBeenCalledTimes(
          9
        )
      }
    )
  }
)