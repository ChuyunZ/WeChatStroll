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
  durationMinutes: 4,

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
          walkingRoute: WALKING_ROUTE,
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
        'generated_park-1_'
      )

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
        {
          name: '人民公园',
          type: 'park',
          latitude: 23.127159,
          longitude: 113.264345
        }
      ])

      expect(route.environmentStats).toEqual(
        WALKING_ROUTE.environmentStats
      )

      expect(
        Number.isNaN(
          Date.parse(route.updatedAt)
        )
      ).toBe(false)
    }
  )

  test(
    'generateFirstRoute runs the real pipeline and returns success',
    async () => {
      wx.cloud.callFunction.mockImplementation(
        async ({ name }) => {
          if (name === 'getNearbyPois') {
            return {
              result: {
                success: true,
                poisByCategory:
                  createPoisByCategory()
              }
            }
          }

          if (name === 'getWalkingRoute') {
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

      expect(
        locationService.getCurrentLocation
      ).toHaveBeenCalledTimes(1)

      expect(
        wx.cloud.callFunction
      ).toHaveBeenNthCalledWith(
        1,
        {
          name: 'getNearbyPois',
          data: {
            longitude: 113.264939,
            latitude: 23.129158
          }
        }
      )

      expect(
        wx.cloud.callFunction
      ).toHaveBeenNthCalledWith(
        2,
        {
          name: 'getWalkingRoute',
          data: {
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
        async ({ name }) => {
          if (name === 'getNearbyPois') {
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
})