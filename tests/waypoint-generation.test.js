// Synthetic tests skip real-time pacing; fake-timer tests cover production intervals.
jest.mock('../miniprogram/config/route-planning', () => ({
  ...jest.requireActual('../miniprogram/config/route-planning'), WALKING_PROVIDER_MIN_INTERVAL_MS: 0
}))

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
  latitude: 45.5,
  longitude: -73.57
}

const PREFERENCES = {
  durationMinutes: 45,
  routeType: 'loop',
  crowdPreference: 'low',
  environmentPreferences: [
    '公园',
    '水边',
    '街道',
    '商街'
  ]
}

const PARK_POI = {
  poiId: 'park-1',
  name: 'Park A',
  category: 'park',
  latitude: 45.501,
  longitude: -73.571,
  distanceInMeters: 350,
  address: 'internal address',
  providerMeta: {
    typecode: '110101'
  }
}

const WATER_POI = {
  poiId: 'water-1',
  name: 'River B',
  category: 'water',
  latitude: 45.503,
  longitude: -73.572,
  distanceInMeters: null,
  address: 'another internal address'
}

function createPoisByCategory() {
  return {
    park: [PARK_POI],
    water: [WATER_POI],
    shoppingStreet: []
  }
}

beforeEach(() => {
  jest.clearAllMocks()

  global.wx = {
    cloud: {
      callFunction: jest.fn()
    }
  }

  locationService.getCurrentLocation
    .mockResolvedValue(TEST_LOCATION)
})

afterEach(() => {
  delete global.wx
})

describe('waypoint generation service', () => {
  test('buildPoiCandidates flattens categories and keeps only planning fields', () => {
    const candidates =
      routeGenerationService.buildPoiCandidates(
        createPoisByCategory()
      )

    expect(candidates).toEqual([
      {
        poiId: 'park-1',
        name: 'Park A',
        category: 'park',
        latitude: 45.501,
        longitude: -73.571,
        distanceInMeters: 350
      },
      {
        poiId: 'water-1',
        name: 'River B',
        category: 'water',
        latitude: 45.503,
        longitude: -73.572,
        distanceInMeters: null
      }
    ])
  })

  test('generateWaypointPlan sends verified flattened POIs to aiRoutePlanner', async () => {
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

        if (name === 'aiRoutePlanner') {
          return {
            result: {
              success: true,
              plan: {
                waypoints: [
                  { poiId: 'park-1' },
                  { poiId: 'water-1' }
                ]
              }
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
        .generateWaypointPlan(PREFERENCES)

    expect(result.status).toBe('success')
    expect(result.plan).toEqual({
      waypoints: [
        { poiId: 'park-1' },
        { poiId: 'water-1' }
      ]
    })

    expect(result.nearbyPois).toHaveLength(2)

    expect(wx.cloud.callFunction)
      .toHaveBeenNthCalledWith(
        2,
        {
          name: 'aiRoutePlanner',
          data: {
            startPoint: TEST_LOCATION,
            preferences: PREFERENCES,
            nearbyPois: [
              {
                poiId: 'park-1',
                name: 'Park A',
                category: 'park',
                latitude: 45.501,
                longitude: -73.571,
                distanceInMeters: 350
              },
              {
                poiId: 'water-1',
                name: 'River B',
                category: 'water',
                latitude: 45.503,
                longitude: -73.572,
                distanceInMeters: null
              }
            ]
          }
        }
      )
  })

  test('generateWaypointPlan does not call AI when no nearby POIs exist', async () => {
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
        .generateWaypointPlan(PREFERENCES)

    expect(result).toEqual({
      status: 'empty',
      reason: 'NO_VALID_POI'
    })

    expect(wx.cloud.callFunction)
      .toHaveBeenCalledTimes(1)
  })

  test('generateWaypointPlan preserves string AI error codes', async () => {
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
            success: false,
            error: {
              code: 'INVALID_AI_ROUTE_PLAN',
              message:
                'AI returned an invalid route plan.'
            }
          }
        }
      }
    )

    await expect(
      routeGenerationService
        .generateWaypointPlan(PREFERENCES)
    ).rejects.toMatchObject({
      code: 'INVALID_AI_ROUTE_PLAN'
    })
  })
})
