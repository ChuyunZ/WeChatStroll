const axios = require('axios')

const { createWalkingHandler } = require('./walking')
const main = createWalkingHandler({ apiKey: 'test-api-key', request: (...args) => axios.get(...args) })

const originalAxiosGet = axios.get

function createAMapRouteResponse() {
  return {
    data: {
      status: '1',
      info: 'OK',
      infocode: '10000',
      count: '1',

      route: {
        paths: [
          {
            distance: '2400',

            cost: {
              duration: '1920'
            },

            steps: [
              {
                step_distance: '800',
                polyline:
                  '121.456000,31.123000;121.458000,31.124000',
                navi: {
                  walk_type: '0'
                }
              },
              {
                step_distance: '1600',
                polyline:
                  '121.458000,31.124000;121.470000,31.130000',
                navi: {
                  walk_type: '6'
                }
              }
            ]
          }
        ]
      }
    }
  }
}

function createValidEvent() {
  return {
    start: {
      latitude: 31.123,
      longitude: 121.456
    },

    destination: {
      latitude: 31.13,
      longitude: 121.47
    }
  }
}

function expectWalkingRouteFailure(result, code = 'INVALID_WALKING_ROUTE_RESPONSE') {
  expect(result).toEqual({
    success: false,
    error: {
      code,
      message: 'Unable to generate walking route'
    }
  })
}

describe('walkingRoute adapter', () => {
  afterEach(() => {
    axios.get = originalAxiosGet
  })

  test('Case 1: Valid walking route + normalization', async () => {
    axios.get = async () => {
      return createAMapRouteResponse()
    }

    const result = await main(createValidEvent())

    expect(result.success).toBe(true)

    expect(result.route.distanceMeters).toBe(2400)
    expect(result.route.durationSeconds).toBe(1920)
    expect(result.route).not.toHaveProperty('durationMinutes')

    expect(result.route.polyline).toEqual([
      {
        latitude: 31.123,
        longitude: 121.456
      },
      {
        latitude: 31.124,
        longitude: 121.458
      },
      {
        latitude: 31.124,
        longitude: 121.458
      },
      {
        latitude: 31.13,
        longitude: 121.47
      }
    ])

    expect(result.route.environmentStats).toEqual({
      totalStepDistanceMeters: 2400,
      analyzedDistanceMeters: 2400,
      unknownWalkTypeDistanceMeters: 0,
      normalRoadDistanceMeters: 800,
      normalRoadRatio: 800 / 2400,
      walkTypeCoverageRatio: 1,
      walkTypeDistanceMeters: {
        '0': 800,
        '6': 1600
      }
    })
  })

  test('Case 2: Sends correct request to AMap', async () => {
    let requestedUrl
    let requestedConfig

    axios.get = async (url, config) => {
      requestedUrl = url
      requestedConfig = config

      return createAMapRouteResponse()
    }

    await main(createValidEvent())

    expect(requestedUrl).toBe(
      'https://restapi.amap.com/v5/direction/walking'
    )

    expect(requestedConfig).toEqual({
      params: {
        key: 'test-api-key',
        origin: '121.456000,31.123000',
        destination: '121.470000,31.130000',
        show_fields: 'cost,polyline,navi'
      }
    })
  })

  test('Case 3: Missing start or destination', async () => {
    axios.get = async () => {
      throw new Error('Axios should not be called')
    }

    const result = await main({
      start: {
        latitude: 31.123,
        longitude: 121.456
      }
    })

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Missing start or destination'
      }
    })
  })

  test('Case 4: Invalid coordinates', async () => {
    axios.get = async () => {
      throw new Error('Axios should not be called')
    }

    const result = await main({
      start: {
        latitude: 31.123,
        longitude: 121.456
      },

      destination: {
        latitude: 200,
        longitude: 121.47
      }
    })

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Invalid start or destination coordinates'
      }
    })
  })

  test('Case 5: Route not found', async () => {
    axios.get = async () => {
      return {
        data: {
          status: '1',
          info: 'OK',
          infocode: '10000',
          count: '0',
          route: {
            paths: []
          }
        }
      }
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'No walking route was found'
      }
    })
  })

  test('Case 6: AMap provider error', async () => {
    axios.get = async () => {
      return {
        data: {
          status: '0',
          info: 'INVALID_USER_KEY',
          infocode: '10001'
        }
      }
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result, 'WALKING_ROUTE_FAILED')
  })

  test('Case 7: Network or Axios failure', async () => {
    axios.get = async () => {
      throw new Error('Network failure')
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result, 'WALKING_ROUTE_FAILED')
  })

  test('Case 8: Invalid response data', async () => {
    axios.get = async () => {
      return {
        data: null
      }
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 9: Invalid route count', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.count = null

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 10: Route count is positive but paths are missing', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 11: Invalid path object', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths = [null]

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 12: Invalid walking distance', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].distance = ''

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 13: Invalid walking duration', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths[0].cost.duration

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 14: Missing route steps', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps = []

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 15: Step is missing polyline', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths[0].steps[0].polyline

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 16: Polyline coordinate has invalid format', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        '121.456000,31.123000,999;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 17: Polyline coordinate contains empty value', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        ',31.123000;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 18: Polyline coordinate is outside valid range', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        '999.000000,31.123000;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 19: Polyline contains fewer than two points', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps = [
        {
          step_distance: '2400',
          polyline: '121.456000,31.123000',
          navi: {
            walk_type: '0'
          }
        }
      ]

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 20: Duration preserves exact seconds', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].cost.duration = '1921'

      return response
    }

    const result = await main(createValidEvent())

    expect(result.success).toBe(true)
    expect(result.route.durationSeconds).toBe(1921)
    expect(result.route).not.toHaveProperty('durationMinutes')
  })

  test(
    'Case 21: Normal-road ratio is based on distance, not step count',
    async () => {
      axios.get = async () => {
        const response = createAMapRouteResponse()

        response.data.route.paths[0].distance = '1000'

        response.data.route.paths[0].steps = [
          {
            step_distance: '10',
            polyline:
              '121.456000,31.123000;121.457000,31.123500',
            navi: {
              walk_type: '0'
            }
          },
          {
            step_distance: '10',
            polyline:
              '121.457000,31.123500;121.458000,31.124000',
            navi: {
              walk_type: '0'
            }
          },
          {
            step_distance: '10',
            polyline:
              '121.458000,31.124000;121.459000,31.124500',
            navi: {
              walk_type: '0'
            }
          },
          {
            step_distance: '970',
            polyline:
              '121.459000,31.124500;121.470000,31.130000',
            navi: {
              walk_type: '6'
            }
          }
        ]

        return response
      }

      const result = await main(createValidEvent())

      expect(result.success).toBe(true)

      expect(
        result.route.environmentStats.normalRoadDistanceMeters
      ).toBe(30)

      expect(
        result.route.environmentStats.normalRoadRatio
      ).toBe(0.03)

      expect(
        result.route.environmentStats.walkTypeDistanceMeters
      ).toEqual({
        '0': 30,
        '6': 970
      })
    }
  )

  test(
    'Case 22: Missing walk_type is tracked as unknown coverage',
    async () => {
      axios.get = async () => {
        const response = createAMapRouteResponse()

        delete response.data.route.paths[0].steps[0].navi

        response.data.route.paths[0].steps[1].navi.walk_type =
          '0'

        return response
      }

      const result = await main(createValidEvent())

      expect(result.success).toBe(true)

      expect(result.route.environmentStats).toEqual({
        totalStepDistanceMeters: 2400,
        analyzedDistanceMeters: 1600,
        unknownWalkTypeDistanceMeters: 800,
        normalRoadDistanceMeters: 1600,
        normalRoadRatio: 1600 / 2400,
        walkTypeCoverageRatio: 1600 / 2400,
        walkTypeDistanceMeters: {
          '0': 1600
        }
      })
    }
  )

  test(
    'Case 23: Numeric walk_type is normalized to a string key',
    async () => {
      axios.get = async () => {
        const response = createAMapRouteResponse()

        response.data.route.paths[0].steps[0].navi.walk_type =
          0

        return response
      }

      const result = await main(createValidEvent())

      expect(result.success).toBe(true)

      expect(
        result.route.environmentStats.normalRoadDistanceMeters
      ).toBe(800)

      expect(
        result.route.environmentStats.walkTypeDistanceMeters
      ).toEqual({
        '0': 800,
        '6': 1600
      })
    }
  )

  test('Case 24: Missing step distance', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths[0].steps[0].step_distance

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })

  test('Case 25: Invalid negative step distance', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].step_distance = '-1'

      return response
    }

    const result = await main(createValidEvent())

    expectWalkingRouteFailure(result)
  })
})
