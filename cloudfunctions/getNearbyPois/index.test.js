const axios = require('axios')

process.env.AMAP_API_KEY = 'test-api-key'

const { main } = require('./index')

const originalAxiosGet = axios.get

function createAMapSuccessResponse(pois = []) {
  return {
    data: {
      status: '1',
      info: 'OK',
      infocode: '10000',
      pois
    }
  }
}

describe('getNearbyPois', () => {
  afterEach(() => {
    axios.get = originalAxiosGet
  })

  test('Case 1: Valid location + normalization', async () => {
    axios.get = async () => {
      return createAMapSuccessResponse([
        {
          id: 'poi_001',
          name: 'Test Park',
          location: '116.473168,39.993015',
          distance: '350',
          type: '风景名胜;公园广场;公园',
          typecode: '110101',
          address: 'Test Address'
        }
      ])
    }

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    expect(result.success).toBe(true)

    expect(result.poisByCategory).toBeDefined()
    expect(typeof result.poisByCategory).toBe('object')

    expect(Array.isArray(result.poisByCategory.park)).toBe(true)
    expect(Array.isArray(result.poisByCategory.water)).toBe(true)
    expect(Array.isArray(result.poisByCategory.shoppingStreet)).toBe(true)

    expect(result.poisByCategory.park.length).toBeGreaterThan(0)

    const poi = result.poisByCategory.park[0]

    expect(poi.poiId).toBe('poi_001')
    expect(poi.name).toBe('Test Park')
    expect(poi.category).toBe('park')
    expect(poi.longitude).toBe(116.473168)
    expect(poi.latitude).toBe(39.993015)
    expect(poi.distanceInMeters).toBe(350)
    expect(poi.address).toBe('Test Address')

    expect(poi.providerMeta).toEqual({
      type: '风景名胜;公园广场;公园',
      typecode: '110101'
    })
  })

  test('Case 2: Missing coordinates', async () => {
    let result = await main({
      latitude: 39.993015
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'INVALID_COORDINATES',
      message: 'Missing longitude or latitude'
    })

    result = await main({
      longitude: 116.473168
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'INVALID_COORDINATES',
      message: 'Missing longitude or latitude'
    })
  })

  test('Case 3: Invalid coordinates', async () => {
    let result = await main({
      longitude: 181,
      latitude: 39.993015
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'INVALID_COORDINATES',
      message: 'Invalid longitude or latitude'
    })

    result = await main({
      longitude: 116.473168,
      latitude: 91
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'INVALID_COORDINATES',
      message: 'Invalid longitude or latitude'
    })

    result = await main({
      longitude: '116.473168',
      latitude: 39.993015
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'INVALID_COORDINATES',
      message: 'Invalid longitude or latitude'
    })
  })

  test('Case 4: Empty POIs', async () => {
    axios.get = async () => {
      return createAMapSuccessResponse([])
    }

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    expect(result.success).toBe(true)

    expect(result.poisByCategory).toEqual({
      park: [],
      water: [],
      shoppingStreet: []
    })
  })

  test('Case 5: Provider / network failure', async () => {
    axios.get = async () => {
      throw new Error('Simulated AMap network failure')
    }

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    expect(result.success).toBe(false)

    expect(result.error).toEqual({
      code: 'POI_SEARCH_FAILED',
      message: 'Unable to retrieve nearby places'
    })

    expect(result.details).toBeUndefined()
  })

  test('Case 6: Malformed provider data', async () => {
    axios.get = async () => {
      return createAMapSuccessResponse([
        {
          id: 'valid-poi',
          name: 'Valid Park',
          location: '116.473168,39.993015',
          distance: '100'
        },

        {
          name: 'Missing ID',
          location: '116.47,39.99'
        },

        {
          id: 'missing-name',
          location: '116.47,39.99'
        },

        {
          id: 'bad-location',
          name: 'Bad Location',
          location: 'abc,xyz'
        },

        {
          id: 'bad-location-format',
          name: 'Bad Location Format',
          location: '116.47,39.99,123'
        },

        {
          id: 'out-of-range-location',
          name: 'Out of Range Location',
          location: '200,100'
        },

        {
          id: 'no-location',
          name: 'No Location'
        },

        {
          id: 'bad-distance',
          name: 'Bad Distance',
          location: '116.473168,39.993015',
          distance: 'not-a-number'
        }
      ])
    }

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    expect(result.success).toBe(true)

    const allPois = Object.values(
      result.poisByCategory
    ).flat()

    for (const returnedPoi of allPois) {
      expect(returnedPoi.poiId).toBeTruthy()
      expect(returnedPoi.name).toBeTruthy()
      expect(returnedPoi.category).toBeTruthy()
      expect(Number.isFinite(returnedPoi.longitude)).toBe(true)
      expect(Number.isFinite(returnedPoi.latitude)).toBe(true)
    }

    expect(
      allPois.some(
        poi => poi.poiId === 'bad-location'
      )
    ).toBe(false)

    expect(
      allPois.some(
        poi => poi.poiId === 'bad-location-format'
      )
    ).toBe(false)

    expect(
      allPois.some(
        poi => poi.poiId === 'out-of-range-location'
      )
    ).toBe(false)

    expect(
      allPois.some(
        poi => poi.poiId === 'no-location'
      )
    ).toBe(false)

    const badDistancePoi = allPois.find(
      poi => poi.poiId === 'bad-distance'
    )

    expect(badDistancePoi).toBeTruthy()

    expect(
      badDistancePoi.distanceInMeters
    ).toBeNull()
  })

  test('Case 7: Valid provided radius reaches AMap', async () => {
    const axiosGetMock = jest.fn(async () => {
      return createAMapSuccessResponse([])
    })

    axios.get = axiosGetMock

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015,
      radius: 1125
    })

    expect(result.success).toBe(true)
    expect(axiosGetMock).toHaveBeenCalledTimes(3)

    for (const call of axiosGetMock.mock.calls) {
      expect(call[1].params.radius).toBe(1125)
    }
  })

  test('Case 8: Missing radius uses default radius', async () => {
    const axiosGetMock = jest.fn(async () => {
      return createAMapSuccessResponse([])
    })

    axios.get = axiosGetMock

    const result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    expect(result.success).toBe(true)

    for (const call of axiosGetMock.mock.calls) {
      expect(call[1].params.radius).toBe(3000)
    }
  })

  test.each([
    0,
    -100,
    NaN,
    Infinity,
    -Infinity,
    15001,
    999999,
    '1125'
  ])(
    'Case 9: Invalid radius %p uses default radius',
    async radius => {
      const axiosGetMock = jest.fn(async () => {
        return createAMapSuccessResponse([])
      })

      axios.get = axiosGetMock

      const result = await main({
        longitude: 116.473168,
        latitude: 39.993015,
        radius
      })

      expect(result.success).toBe(true)

      for (const call of axiosGetMock.mock.calls) {
        expect(call[1].params.radius).toBe(3000)
      }
    }
  )

  test('Case 10: Radius boundaries are accepted', async () => {
    const minimumRadiusMock = jest.fn(async () => {
      return createAMapSuccessResponse([])
    })

    axios.get = minimumRadiusMock

    await main({
      longitude: 116.473168,
      latitude: 39.993015,
      radius: 200
    })

    for (const call of minimumRadiusMock.mock.calls) {
      expect(call[1].params.radius).toBe(200)
    }

    const maximumRadiusMock = jest.fn(async () => {
      return createAMapSuccessResponse([])
    })

    axios.get = maximumRadiusMock

    await main({
      longitude: 116.473168,
      latitude: 39.993015,
      radius: 15000
    })

    for (const call of maximumRadiusMock.mock.calls) {
      expect(call[1].params.radius).toBe(15000)
    }
  })
})