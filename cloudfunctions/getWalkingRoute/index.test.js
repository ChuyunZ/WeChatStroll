const axios = require('axios')

process.env.AMAP_API_KEY = 'test-api-key'

const { main } = require('./index')

const originalAxiosGet = axios.get
const originalConsoleError = console.error

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
                polyline:
                  '121.456000,31.123000;121.458000,31.124000'
              },
              {
                polyline:
                  '121.458000,31.124000;121.470000,31.130000'
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

describe('getWalkingRoute', () => {
  beforeEach(() => {
    // Expected failure tests intentionally trigger console.error.
    // Silence it so the Jest output stays readable.
    console.error = () => {}
  })

  afterEach(() => {
    axios.get = originalAxiosGet
    console.error = originalConsoleError
  })

  test('Case 1: Valid walking route + normalization', async () => {
    axios.get = async () => {
      return createAMapRouteResponse()
    }

    const result = await main(createValidEvent())

    expect(result.success).toBe(true)

    expect(result.route.distanceMeters).toBe(2400)
    expect(result.route.durationMinutes).toBe(32)

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
        show_fields: 'cost,polyline'
      },
      timeout: 2000
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

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 7: Network or Axios failure', async () => {
    axios.get = async () => {
      throw new Error('Network failure')
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 8: Invalid response data', async () => {
    axios.get = async () => {
      return {
        data: null
      }
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 9: Invalid route count', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.count = null

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 10: Route count is positive but paths are missing', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 11: Invalid path object', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths = [null]

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 12: Invalid walking distance', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].distance = ''

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 13: Invalid walking duration', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths[0].cost.duration

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 14: Missing route steps', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps = []

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 15: Step is missing polyline', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      delete response.data.route.paths[0].steps[0].polyline

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 16: Polyline coordinate has invalid format', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        '121.456000,31.123000,999;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 17: Polyline coordinate contains empty value', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        ',31.123000;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 18: Polyline coordinate is outside valid range', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps[0].polyline =
        '999.000000,31.123000;121.458000,31.124000'

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 19: Polyline contains fewer than two points', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].steps = [
        {
          polyline: '121.456000,31.123000'
        }
      ]

      return response
    }

    const result = await main(createValidEvent())

    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    })
  })

  test('Case 20: Duration rounds up to whole minutes', async () => {
    axios.get = async () => {
      const response = createAMapRouteResponse()

      response.data.route.paths[0].cost.duration = '1921'

      return response
    }

    const result = await main(createValidEvent())

    expect(result.success).toBe(true)
    expect(result.route.durationMinutes).toBe(33)
  })
})