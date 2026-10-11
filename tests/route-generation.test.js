jest.mock('../miniprogram/services/preference-profile-records', () => ({ refreshProfile: jest.fn(async () => null) }))

jest.mock(
  '../miniprogram/services/location',
  () => ({
    getCurrentLocation: jest.fn()
  })
)

const locationService = require(
  '../miniprogram/services/location'
)

const routeGenerationService = require(
  '../miniprogram/services/route-generation'
)

const TEST_LOCATION = {
  latitude: 23.129158,
  longitude: 113.264939
}

const PARK_POI = {
  poiId: 'park-1',
  name: '人民公园',
  category: 'park',
  latitude: 23.127159,
  longitude: 113.264345,
  distanceInMeters: 279
}

const WATER_POI = {
  poiId: 'water-1',
  name: '测试水边',
  category: 'water',
  latitude: 23.13,
  longitude: 113.27,
  distanceInMeters: 500
}

const SHOPPING_POI = {
  poiId: 'shopping-1',
  name: '测试商街',
  category: 'shoppingStreet',
  latitude: 23.131,
  longitude: 113.271,
  distanceInMeters: 700
}

const WALKING_ROUTE = {
  distanceMeters: 279,
  durationSeconds: 240,

  polyline: [
    {
      latitude: 23.129158,
      longitude: 113.264939
    },
    {
      latitude: 23.127159,
      longitude: 113.264345
    }
  ],

  environmentStats: {
    totalStepDistanceMeters: 279,
    analyzedDistanceMeters: 279,
    unknownWalkTypeDistanceMeters: 0,
    normalRoadDistanceMeters: 279,
    normalRoadRatio: 1,
    walkTypeCoverageRatio: 1,
    walkTypeDistanceMeters: {
      '0': 279
    }
  }
}

function createPoisByCategory() {
  return {
    park: [PARK_POI],
    water: [WATER_POI],
    shoppingStreet: [SHOPPING_POI]
  }
}

function createWalkingRouteBetween(
  start,
  destination,
  {
    distanceMeters = 100,
    durationSeconds = 60
  } = {}
) {
  return {
    distanceMeters,
    durationSeconds,
    polyline: [
      {
        latitude: start.latitude,
        longitude: start.longitude
      },
      {
        latitude: destination.latitude,
        longitude: destination.longitude
      }
    ]
  }
}

beforeEach(() => {
  jest.clearAllMocks()

  global.wx = {
    cloud: {
      callFunction: jest.fn()
    }
  }

  locationService.getCurrentLocation.mockResolvedValue(
    TEST_LOCATION
  )
})

afterEach(() => {
  delete global.wx
})

test.each(['transport', 'missing', 'empty', 'invalid-failure', 'business'])(
  'POI gateway boundary preserves the distinction for %s', async mode => {
    if (mode === 'transport') wx.cloud.callFunction.mockRejectedValue(new Error('private network details'))
    else wx.cloud.callFunction.mockResolvedValue({
      missing: undefined,
      empty: {},
      'invalid-failure': { result: { success: false } },
      business: { result: { success: false, error: { code: 'POI_SEARCH_FAILED', message: 'Unable to retrieve nearby places' } } }
    }[mode])
    await expect(routeGenerationService.generateRoutes({ durationMinutes: 45, routeType: 'point_to_point' }))
      .rejects.toMatchObject({ code: mode === 'business' ? 'POI_SEARCH_FAILED' : 'PROVIDER_GATEWAY_FAILED' })
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
      name: 'mapProvider', data: expect.objectContaining({ action: 'nearbyPois' })
    }))
  })

test('walking transport failure stops generation without retry, AI replanning or fallback', async () => {
  wx.cloud.callFunction.mockImplementation(async ({ name, data }) => {
    if (name === 'aiRoutePlanner') return { result: { success: true, plan: {
      candidates: [
        { waypoints: [{ poiId: PARK_POI.poiId }] },
        { waypoints: [{ poiId: WATER_POI.poiId }] }
      ]
    } } }
    if (name === 'mapProvider' && data.action === 'nearbyPois') {
      return { result: { success: true, poisByCategory: createPoisByCategory() } }
    }
    throw new Error('private transport details')
  })
  await expect(routeGenerationService.generateRoutes({ durationMinutes: 45, routeType: 'point_to_point' }))
    .rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED', message: 'Route service is temporarily unavailable.' })
  expect(wx.cloud.callFunction.mock.calls.map(([{ name, data }]) => data.action || name))
    .toEqual(['nearbyPois', 'aiRoutePlanner', 'walkingRoute'])
})

describe('route-generation service', () => {
  test(
    'selectNearestPoi returns the nearest valid POI',
    () => {
      const result =
        routeGenerationService.selectNearestPoi([
          {
            ...PARK_POI,
            poiId: 'far',
            distanceInMeters: 900
          },
          {
            ...PARK_POI,
            poiId: 'near',
            distanceInMeters: 200
          },
          {
            ...PARK_POI,
            poiId: 'middle',
            distanceInMeters: 500
          }
        ])

      expect(result.poiId).toBe('near')
    }
  )

  test(
    'selectNearestPoi ignores POIs with invalid coordinates',
    () => {
      const result =
        routeGenerationService.selectNearestPoi([
          {
            ...PARK_POI,
            poiId: 'invalid',
            latitude: 200,
            distanceInMeters: 10
          },
          {
            ...PARK_POI,
            poiId: 'valid',
            distanceInMeters: 300
          }
        ])

      expect(result.poiId).toBe('valid')
    }
  )

  test(
    'selectCandidatePoi respects environment ranking and skips street',
    () => {
      const poisByCategory =
        createPoisByCategory()

      const result =
        routeGenerationService.selectCandidatePoi(
          poisByCategory,
          {
            environmentPreferences: [
              '街道',
              '水边',
              '公园',
              '商街'
            ]
          }
        )

      expect(result).toEqual(WATER_POI)
    }
  )

  test(
    'selectCandidatePoi moves to the next preference when a category is empty',
    () => {
      const poisByCategory =
        createPoisByCategory()

      poisByCategory.water = []

      const result =
        routeGenerationService.selectCandidatePoi(
          poisByCategory,
          {
            environmentPreferences: [
              '街道',
              '水边',
              '公园',
              '商街'
            ]
          }
        )

      expect(result).toEqual(PARK_POI)
    }
  )

  test(
    'selectCandidatePoi falls back to the nearest available POI',
    () => {
      const result =
        routeGenerationService.selectCandidatePoi(
          createPoisByCategory(),
          {
            environmentPreferences: [
              '街道'
            ]
          }
        )

      expect(result).toEqual(PARK_POI)
    }
  )

  test(
    'buildGeneratedRoute follows the shared Route contract',
    () => {
      const route =
        routeGenerationService.buildGeneratedRoute({
          location: TEST_LOCATION,
          selectedPoi: PARK_POI,
          walkingRoute: {
            ...WALKING_ROUTE,
            durationMinutes: 4
          },
          preferences: {
            environmentPreferences: [
              '公园',
              '水边',
              '商街',
              '街道'
            ]
          }
        })

      expect(route.routeId).toContain(
        'generated_fallback_'
      )
      expect(route.routeId).not.toContain('park-1')

      expect(route.title).toBe(
        '前往人民公园的散步路线'
      )

      expect(route.durationMinutes).toBe(4)
      expect(route.distanceMeters).toBe(279)

      expect(route.routeType).toBe(
        'point_to_point'
      )

      expect(route.returnsToStart).toBe(false)

      expect(route.crowdLevel).toBe(
        'unknown'
      )

      expect(route.tags).toEqual([
        '公园'
      ])

      expect(route.description).toBe(
        '从当前位置步行前往人民公园的真实路线。'
      )

      expect(route.startPoint).toEqual({
        name: '当前位置',
        latitude: 23.129158,
        longitude: 113.264939
      })

      expect(route.endPoint).toEqual({
        name: '人民公园',
        latitude: 23.127159,
        longitude: 113.264345
      })

      expect(route.polyline).toEqual(
        WALKING_ROUTE.polyline
      )

      expect(route.pointsOfInterest).toEqual([
        expect.objectContaining({
          name: '人民公园',
          type: 'park',
          latitude: 23.127159,
          longitude: 113.264345
        })
      ])

      expect(route).not.toHaveProperty('environmentStats')

      expect(
        Number.isNaN(
          Date.parse(route.updatedAt)
        )
      ).toBe(false)
    }
  )

  test(
    'buildGeneratedRoute represents returning route types with the start location as the endpoint',
    () => {
      const route =
        routeGenerationService.buildGeneratedRoute({
          location: TEST_LOCATION,
          selectedPoi: PARK_POI,
          walkingRoute: {
            ...WALKING_ROUTE,
            durationMinutes: 8,
            routeType: 'out_and_back',
            returnsToStart: true,
            polyline: [
              TEST_LOCATION,
              {
                latitude: PARK_POI.latitude,
                longitude: PARK_POI.longitude
              },
              TEST_LOCATION
            ]
          }
        })

      expect(route.routeType).toBe(
        'out_and_back'
      )

      expect(route.returnsToStart).toBe(true)

      expect(route.endPoint).toEqual({
        name: '当前位置',
        latitude: TEST_LOCATION.latitude,
        longitude: TEST_LOCATION.longitude
      })

      expect(route.description).toBe(
        '从当前位置步行前往人民公园并返回起点的真实路线。'
      )
    }
  )

  test(
    'generateFirstRoute runs the real pipeline and passes the duration-aware capped POI radius',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }

          if (name === 'mapProvider' && data.action === 'walkingRoute') {
            return {
              result: {
                success: true,
                route: WALKING_ROUTE
              }
            }
          }

          throw new Error(
            `Unexpected Cloud Function: ${name}`
          )
        }
      )

      const result =
        await routeGenerationService
          .generateFirstRoute({
            durationMinutes: 20,
            environmentPreferences: [
              '公园',
              '水边',
              '商街',
              '街道'
            ]
          })

      expect(result.status).toBe('success')

      expect(result.route.endPoint.name).toBe(
        '人民公园'
      )

      expect(result.route.routeType).toBe(
        'point_to_point'
      )

      expect(result.route.returnsToStart).toBe(
        false
      )

      expect(
        locationService.getCurrentLocation
      ).toHaveBeenCalledTimes(1)

      expect(
        wx.cloud.callFunction
      ).toHaveBeenNthCalledWith(
        1,
        {
          name: 'mapProvider',
          data: {
            action: 'nearbyPois', requestId: expect.any(String),
            longitude: 113.264939,
            latitude: 23.129158,
            radius: 750
          }
        }
      )

      expect(
        wx.cloud.callFunction
      ).toHaveBeenNthCalledWith(
        2,
        {
          name: 'mapProvider',
          data: {
            action: 'walkingRoute', requestId: expect.any(String),
            start: {
              latitude: 23.129158,
              longitude: 113.264939
            },
            destination: {
              latitude: 23.127159,
              longitude: 113.264345
            }
          }
        }
      )
    }
  )

  test(
    'generateFirstRoute returns the live planning session with the first route cache still available',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }

          if (name === 'mapProvider' && data.action === 'walkingRoute') {
            return {
              result: {
                success: true,
                route: WALKING_ROUTE
              }
            }
          }

          throw new Error(
            `Unexpected Cloud Function: ${name}`
          )
        }
      )

      const result =
        await routeGenerationService
          .generateFirstRoute({
            environmentPreferences: [
              '公园'
            ]
          })

      expect(result.status).toBe('success')

      expect(
        typeof result
          .routePlanningSession
          .registerVerifiedWaypoints
      ).toBe('function')

      expect(
        typeof result
          .routePlanningSession
          .prefetchSegments
      ).toBe('function')

      expect(
        typeof result
          .routePlanningSession
          .buildRouteForOrder
      ).toBe('function')

      expect(
        wx.cloud.callFunction
      ).toHaveBeenCalledTimes(2)

      const rebuiltRoute =
        await result
          .routePlanningSession
          .buildRouteForOrder({
            allowedWaypointIds: [
              PARK_POI.poiId
            ],
            orderedWaypointIds: [
              PARK_POI.poiId
            ],
            source: 'revisited'
          })

      expect(rebuiltRoute.success).toBe(true)

      expect(
        rebuiltRoute.routeOrder.source
      ).toBe('revisited')

      /*
       * getNearbyPois + the original START→park
       * request are the only cloud calls.
       * Rebuilding the same route uses the
       * planning session's existing L1 cache.
       */
      expect(
        wx.cloud.callFunction
      ).toHaveBeenCalledTimes(2)
    }
  )

  test(
    'generateFirstRoute passes the requested loop route type through the engine',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }

          if (name === 'mapProvider' && data.action === 'walkingRoute') {
            return {
              result: {
                success: true,
                route:
                  createWalkingRouteBetween(
                    data.start,
                    data.destination
                  )
              }
            }
          }

          throw new Error(
            `Unexpected Cloud Function: ${name}`
          )
        }
      )

      const result =
        await routeGenerationService
          .generateFirstRoute({
            routeType: 'loop',
            environmentPreferences: [
              '公园'
            ]
          })

      expect(result.status).toBe('success')

      expect(result.route.routeType).toBe(
        'loop'
      )

      expect(result.route.returnsToStart).toBe(
        true
      )

      expect(result.route.endPoint).toEqual({
        name: '当前位置',
        latitude: TEST_LOCATION.latitude,
        longitude: TEST_LOCATION.longitude
      })

      expect(result.route.description).toBe(
        '从当前位置步行前往人民公园并返回起点的真实路线。'
      )

      /*
       * One POI loop:
       * START→park→START
       *
       * Plus the initial getNearbyPois call.
       */
      expect(
        wx.cloud.callFunction
      ).toHaveBeenCalledTimes(3)

      const walkingCalls =
        wx.cloud.callFunction.mock.calls
          .map(([request]) => request)
          .filter(
            request =>
              request.name === 'mapProvider' && request.data.action === 'walkingRoute'
          )

      expect(walkingCalls).toHaveLength(2)

      /*
       * Segment resolution is concurrent,
       * so the test checks membership rather
       * than depending on provider-call order.
       */
      expect(walkingCalls).toEqual(
        expect.arrayContaining([
          {
            name: 'mapProvider',
            data: {
              action: 'walkingRoute', requestId: expect.any(String),
              start: {
                latitude: TEST_LOCATION.latitude,
                longitude: TEST_LOCATION.longitude
              },
              destination: {
                latitude: PARK_POI.latitude,
                longitude: PARK_POI.longitude
              }
            }
          },
          {
            name: 'mapProvider',
            data: {
              action: 'walkingRoute', requestId: expect.any(String),
              start: {
                latitude: PARK_POI.latitude,
                longitude: PARK_POI.longitude
              },
              destination: {
                latitude: TEST_LOCATION.latitude,
                longitude: TEST_LOCATION.longitude
              }
            }
          }
        ])
      )
    }
  )

  test(
    'generateFirstRoute uses the fixed POI radius when duration is missing',
    async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          poisByCategory: {
            park: [],
            water: [],
            shoppingStreet: []
          }
        }
      })

      const result =
        await routeGenerationService
          .generateFirstRoute({
            environmentPreferences: [
              '公园',
              '水边',
              '商街',
              '街道'
            ]
          })

      expect(result).toEqual({
        status: 'empty',
        reason: 'NO_VALID_POI'
      })

      expect(
        wx.cloud.callFunction
      ).toHaveBeenCalledWith({
        name: 'mapProvider',
        data: {
          action: 'nearbyPois', requestId: expect.any(String),
          longitude: 113.264939,
          latitude: 23.129158,
          radius: 1000
        }
      })
    }
  )

  test(
    'generateFirstRoute returns an explicit empty result when no valid POI exists',
    async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: true,
          poisByCategory: {
            park: [],
            water: [],
            shoppingStreet: []
          }
        }
      })

      const result =
        await routeGenerationService
          .generateFirstRoute({
            environmentPreferences: [
              '公园',
              '水边',
              '商街',
              '街道'
            ]
          })

      expect(result).toEqual({
        status: 'empty',
        reason: 'NO_VALID_POI'
      })

      expect(
        wx.cloud.callFunction
      ).toHaveBeenCalledTimes(1)
    }
  )

  test(
    'generateFirstRoute throws when POI search fails',
    async () => {
      wx.cloud.callFunction.mockResolvedValue({
        result: {
          success: false,
          error: {
            code: 'POI_SEARCH_FAILED',
            message:
              'Unable to retrieve nearby places'
          }
        }
      })

      await expect(
        routeGenerationService
          .generateFirstRoute()
      ).rejects.toMatchObject({
        code: 'POI_SEARCH_FAILED'
      })
    }
  )

  test(
    'generateFirstRoute rejects an invalid walking route response',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }

          return {
            result: {
              success: true,
              route: {
                ...WALKING_ROUTE,
                polyline: []
              }
            }
          }
        }
      )

      await expect(
        routeGenerationService
          .generateFirstRoute({
            environmentPreferences: [
              '公园',
              '水边',
              '商街',
              '街道'
            ]
          })
      ).rejects.toMatchObject({
        code: 'INVALID_WALKING_ROUTE'
      })
    }
  )

  test(
    'generateFirstRoute rejects an invalid current location',
    async () => {
      locationService
        .getCurrentLocation
        .mockResolvedValue({
          latitude: 200,
          longitude: 113
        })

      await expect(
        routeGenerationService
          .generateFirstRoute()
      ).rejects.toMatchObject({
        code: 'INVALID_LOCATION'
      })

      expect(
        wx.cloud.callFunction
      ).not.toHaveBeenCalled()
    }
  )

  test(
    'generateRoutes returns the first real route and leaves candidates for background fill',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }
  
          if (name === 'aiRoutePlanner') {
            return {
              result: {
                success: true,
                plan: {
                  candidates: [
                    {
                      waypoints: [
                        { poiId: 'park-1' }
                      ]
                    },
                    {
                      waypoints: [
                        { poiId: 'water-1' }
                      ]
                    },
                    {
                      waypoints: [
                        { poiId: 'shopping-1' }
                      ]
                    }
                  ]
                }
              }
            }
          }
  
          if (name === 'mapProvider' && data.action === 'walkingRoute') {
            return {
              result: {
                success: true,
                route:
                  createWalkingRouteBetween(
                    data.start,
                    data.destination
                  )
              }
            }
          }
  
          throw new Error(
            `Unexpected Cloud Function: ${name}`
          )
        }
      )
  
      const result =
        await routeGenerationService
          .generateRoutes({
            routeType: 'point_to_point'
          })
  
      expect(result.status).toBe('success')
  
      expect(result.routes).toHaveLength(1)
  
      expect(
        result.routes.map(
          route =>
            route.pointsOfInterest[0].name
        )
      ).toEqual([
        '人民公园'
      ])
  
      expect(
        typeof result
          .routePlanningSession
          .buildRouteForOrder
      ).toBe('function')
    }
  )

  test(
    'generateRoutes stops after the first successful route',
    async () => {
      const extraPoi = {
        ...PARK_POI,
        poiId: 'park-2',
        name: '第二公园',
        latitude: 23.128,
        longitude: 113.266
      }
  
      wx.cloud.callFunction.mockImplementation(
        async ({ name, data }) => {
          if (name === 'mapProvider' && data.action === 'nearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory: {
                  ...createPoisByCategory(),
                  park: [
                    PARK_POI,
                    extraPoi
                  ]
                }
              }
            }
          }
  
          if (name === 'aiRoutePlanner') {
            return {
              result: {
                success: true,
                plan: {
                  candidates: [
                    { waypoints: [{ poiId: 'park-1' }] },
                    { waypoints: [{ poiId: 'water-1' }] },
                    { waypoints: [{ poiId: 'shopping-1' }] },
                    { waypoints: [{ poiId: 'park-2' }] }
                  ]
                }
              }
            }
          }
  
          if (name === 'mapProvider' && data.action === 'walkingRoute') {
            return {
              result: {
                success: true,
                route:
                  createWalkingRouteBetween(
                    data.start,
                    data.destination
                  )
              }
            }
          }
  
          throw new Error(
            `Unexpected Cloud Function: ${name}`
          )
        }
      )
  
      const result =
        await routeGenerationService
          .generateRoutes()
  
      expect(result.status).toBe('success')
      expect(result.routes).toHaveLength(1)
      expect(result.waypointCandidateCache.getUnusedCandidates()).toHaveLength(3)
    }
  )
})


test('generated route IDs remain unique within the same millisecond and never embed provider IDs', () => {
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1791324000000)
  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5)

  try {
    const fallbackOne = routeGenerationService.buildGeneratedRoute({
      location: TEST_LOCATION,
      selectedPoi: PARK_POI,
      walkingRoute: {
        ...WALKING_ROUTE,
        durationMinutes: 4,
        routeType: 'point_to_point',
        returnsToStart: false
      },
      preferences: {}
    })

    const fallbackTwo = routeGenerationService.buildGeneratedRoute({
      location: TEST_LOCATION,
      selectedPoi: PARK_POI,
      walkingRoute: {
        ...WALKING_ROUTE,
        durationMinutes: 4,
        routeType: 'point_to_point',
        returnsToStart: false
      },
      preferences: {}
    })

    const aiWalkingRoute = {
      success: true,
      waypoints: [PARK_POI],
      routeOrder: {
        source: 'recommended',
        orderedWaypointIds: [PARK_POI.poiId]
      },
      durationSeconds: 240,
      durationMinutes: 4,
      distanceMeters: 279,
      routeType: 'point_to_point',
      returnsToStart: false,
      polyline: WALKING_ROUTE.polyline
    }

    const aiOne = routeGenerationService.buildGeneratedRouteFromAiCandidate({
      location: TEST_LOCATION,
      walkingRoute: aiWalkingRoute,
      candidateIndex: 0
    })
    const aiTwo = routeGenerationService.buildGeneratedRouteFromAiCandidate({
      location: TEST_LOCATION,
      walkingRoute: aiWalkingRoute,
      candidateIndex: 0
    })

    expect(fallbackOne.routeId).not.toBe(fallbackTwo.routeId)
    expect(aiOne.routeId).not.toBe(aiTwo.routeId)
    expect(new Set([
      fallbackOne.routeId,
      fallbackTwo.routeId,
      aiOne.routeId,
      aiTwo.routeId
    ])).toHaveProperty('size', 4)

    expect(fallbackOne.routeId).toMatch(
      /^generated_fallback_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/
    )
    expect(aiOne.routeId).toMatch(
      /^generated_ai_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/
    )

    for (const routeId of [
      fallbackOne.routeId,
      fallbackTwo.routeId,
      aiOne.routeId,
      aiTwo.routeId
    ]) {
      expect(routeId).not.toContain(PARK_POI.poiId)
      expect(routeId).not.toContain(String(PARK_POI.latitude))
      expect(routeId).not.toContain(String(PARK_POI.longitude))
    }
  } finally {
    nowSpy.mockRestore()
    randomSpy.mockRestore()
  }
})
