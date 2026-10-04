const {
  getWalkingSegment
} = require(
  '../miniprogram/services/walking-segment'
)

const originalWx = global.wx

test.each([
  [{ result: { success: false, error: { code: 'WALKING_ROUTE_FAILED', message: 'Unable to generate walking route' } } }, 'WALKING_SEGMENT_FAILED', 'WALKING_ROUTE_FAILED'],
  [undefined, 'PROVIDER_GATEWAY_FAILED', 'PROVIDER_GATEWAY_FAILED'],
  [{}, 'PROVIDER_GATEWAY_FAILED', 'PROVIDER_GATEWAY_FAILED'],
  [{ result: { success: false } }, 'PROVIDER_GATEWAY_FAILED', 'PROVIDER_GATEWAY_FAILED']
])('walking boundary distinguishes business failures from unusable envelopes (%j)', async (response, error, causeCode) => {
  global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue(response) } }
  try {
    expect(await getWalkingSegment(
      { latitude: 30, longitude: 120 }, { latitude: 31, longitude: 121 }
    )).toEqual({ success: false, error, causeCode })
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
  } finally { global.wx = originalWx }
})

function createSuccessfulWalkingResult() {
  return {
    success: true,

    route: {
      distanceMeters: 820,
      durationSeconds: 661,

      polyline: [
        {
          latitude: 31.2304,
          longitude: 121.4737
        },
        {
          latitude: 31.231,
          longitude: 121.4745
        }
      ],

      environmentStats: {
        totalStepDistanceMeters: 820,
        analyzedDistanceMeters: 820,
        unknownWalkTypeDistanceMeters: 0,
        normalRoadDistanceMeters: 600,
        normalRoadRatio: 600 / 820,
        walkTypeCoverageRatio: 1,

        walkTypeDistanceMeters: {
          '0': 600,
          '6': 220
        }
      }
    }
  }
}

describe('walking-segment', () => {
  afterEach(() => {
    global.wx = originalWx
  })

  test(
    'normalizes a successful walking route',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result:
              createSuccessfulWalkingResult()
          })
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: true,

        distanceMeters: 820,
        durationSeconds: 661,

        polyline: [
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        ],


      })

      expect(
        result
      ).not.toHaveProperty(
        'durationMinutes'
      )
    }
  )

  test(
    'sends only action and trusted coordinates to mapProvider',
    async () => {
      let receivedRequest

      global.wx = {
        cloud: {
          callFunction: async (
            request
          ) => {
            receivedRequest = request

            return {
              result:
                createSuccessfulWalkingResult()
            }
          }
        }
      }

      await getWalkingSegment(
        {
          latitude: 31.2304,
          longitude: 121.4737,
          name: 'Start metadata'
        },
        {
          latitude: 31.231,
          longitude: 121.4745,
          poiId: 'poi-A',
          name: 'Waypoint A'
        }
      )

      expect(receivedRequest).toEqual({
        name: 'mapProvider',

        data: {
          action: 'walkingRoute',
          start: {
            latitude: 31.2304,
            longitude: 121.4737
          },

          destination: {
            latitude: 31.231,
            longitude: 121.4745
          }
        }
      })
    }
  )

  test(
    'rejects invalid segment coordinates without calling the provider',
    async () => {
      let callCount = 0

      global.wx = {
        cloud: {
          callFunction: async () => {
            callCount++

            return {
              result:
                createSuccessfulWalkingResult()
            }
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 200,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: false,
        error:
          'INVALID_WALKING_SEGMENT_INPUT'
      })

      expect(callCount).toBe(0)
    }
  )

  test(
    'returns a normalized failure when the cloud function fails',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result: {
              success: false,

              error: {
                code:
                  'ROUTE_NOT_FOUND',

                message:
                  'No walking route was found.'
              }
            }
          })
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: false,
        error:
          'WALKING_SEGMENT_FAILED',
        causeCode:
          'ROUTE_NOT_FOUND'
      })
    }
  )

  test(
    'returns a normalized failure when wx.cloud throws',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => {
            throw new Error(
              'Network failure'
            )
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: false,
        error:
          'PROVIDER_GATEWAY_FAILED',
        causeCode:
          'PROVIDER_GATEWAY_FAILED'
      })
    }
  )

  test.each([
    {
      field: 'distanceMeters',
      value: -1
    },
    {
      field: 'distanceMeters',
      value: NaN
    },
    {
      field: 'durationSeconds',
      value: -1
    },
    {
      field: 'durationSeconds',
      value: Infinity
    }
  ])(
    'rejects invalid core route value: $field = $value',
    async ({
      field,
      value
    }) => {
      global.wx = {
        cloud: {
          callFunction: async () => {
            const result =
              createSuccessfulWalkingResult()

            result.route[field] = value

            return {
              result
            }
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: false,
        error:
          'INVALID_WALKING_SEGMENT_RESPONSE'
      })
    }
  )

  test(
    'rejects an invalid polyline',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => {
            const result =
              createSuccessfulWalkingResult()

            result.route.polyline = [
              {
                latitude: 31.2304,
                longitude: 121.4737
              }
            ]

            return {
              result
            }
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result).toEqual({
        success: false,
        error:
          'INVALID_WALKING_SEGMENT_RESPONSE'
      })
    }
  )

  test(
    'keeps the segment valid when environment stats are missing',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => {
            const result =
              createSuccessfulWalkingResult()

            delete result
              .route
              .environmentStats

            return {
              result
            }
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result.success).toBe(true)

      expect(
        result
      ).not.toHaveProperty(
        'environmentStats'
      )
    }
  )

  test(
    'keeps the segment valid when environment stats are malformed',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => {
            const result =
              createSuccessfulWalkingResult()

            result
              .route
              .environmentStats = {
                normalRoadRatio: 999
              }

            return {
              result
            }
          }
        }
      }

      const result =
        await getWalkingSegment(
          {
            latitude: 31.2304,
            longitude: 121.4737
          },
          {
            latitude: 31.231,
            longitude: 121.4745
          }
        )

      expect(result.success).toBe(true)

      expect(
        result
      ).not.toHaveProperty(
        'environmentStats'
      )
    }
  )
  test(
  'drops inconsistent environment stats while keeping the segment valid',
  async () => {
    global.wx = {
      cloud: {
        callFunction: async () => {
          const result =
            createSuccessfulWalkingResult()

          result.route.environmentStats = {
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

          return {
            result
          }
        }
      }
    }

    const result =
      await getWalkingSegment(
        {
          latitude: 31.2304,
          longitude: 121.4737
        },
        {
          latitude: 31.231,
          longitude: 121.4745
        }
      )

    expect(result.success).toBe(true)

    expect(result).toEqual({
      success: true,

      distanceMeters: 820,
      durationSeconds: 661,

      polyline: [
        {
          latitude: 31.2304,
          longitude: 121.4737
        },
        {
          latitude: 31.231,
          longitude: 121.4745
        }
      ]
    })

    expect(
      result
    ).not.toHaveProperty(
      'environmentStats'
    )
  }
)
})
