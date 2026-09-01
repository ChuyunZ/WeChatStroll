const assert = require('assert')
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

async function runTests() {
  try {
    // Case 1: Valid location + normalization
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

    let result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    assert.strictEqual(result.success, true)
    assert.ok(Array.isArray(result.pois))
    assert.ok(result.pois.length > 0)

    const poi = result.pois[0]

    assert.strictEqual(poi.poiId, 'poi_001')
    assert.strictEqual(poi.name, 'Test Park')
    assert.strictEqual(poi.category, 'park')
    assert.strictEqual(poi.longitude, 116.473168)
    assert.strictEqual(poi.latitude, 39.993015)
    assert.strictEqual(poi.distanceInMeters, 350)
    assert.strictEqual(poi.address, 'Test Address')

    assert.deepStrictEqual(
      poi.providerMeta,
      {
        type: '风景名胜;公园广场;公园',
        typecode: '110101'
      }
    )


    // Case 2: Missing coordinates
    result = await main({
      latitude: 39.993015
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'INVALID_COORDINATES',
        message: 'Missing longitude or latitude'
      }
    )

    result = await main({
      longitude: 116.473168
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'INVALID_COORDINATES',
        message: 'Missing longitude or latitude'
      }
    )


    // Case 3: Invalid coordinates
    result = await main({
      longitude: 181,
      latitude: 39.993015
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'INVALID_COORDINATES',
        message: 'Invalid longitude or latitude'
      }
    )

    result = await main({
      longitude: 116.473168,
      latitude: 91
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'INVALID_COORDINATES',
        message: 'Invalid longitude or latitude'
      }
    )

    result = await main({
      longitude: '116.473168',
      latitude: 39.993015
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'INVALID_COORDINATES',
        message: 'Invalid longitude or latitude'
      }
    )


    // Case 4: Empty POIs
    axios.get = async () => {
      return createAMapSuccessResponse([])
    }

    result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    assert.strictEqual(result.success, true)
    assert.deepStrictEqual(result.pois, [])


    // Case 5: Provider / network failure
    axios.get = async () => {
      throw new Error('Simulated AMap network failure')
    }

    result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    assert.strictEqual(result.success, false)

    assert.deepStrictEqual(
      result.error,
      {
        code: 'POI_SEARCH_FAILED',
        message: 'Unable to retrieve nearby places'
      }
    )

    assert.strictEqual(result.details, undefined)


    // Case 6: Malformed provider data
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

    result = await main({
      longitude: 116.473168,
      latitude: 39.993015
    })

    assert.strictEqual(result.success, true)

    for (const returnedPoi of result.pois) {
      assert.ok(returnedPoi.poiId)
      assert.ok(returnedPoi.name)
      assert.ok(returnedPoi.category)
      assert.ok(Number.isFinite(returnedPoi.longitude))
      assert.ok(Number.isFinite(returnedPoi.latitude))
    }

    assert.strictEqual(
      result.pois.some(
        poi => poi.poiId === 'bad-location'
      ),
      false
    )

    assert.strictEqual(
      result.pois.some(
        poi => poi.poiId === 'bad-location-format'
      ),
      false
    )

    assert.strictEqual(
      result.pois.some(
        poi => poi.poiId === 'out-of-range-location'
      ),
      false
    )

    assert.strictEqual(
      result.pois.some(
        poi => poi.poiId === 'no-location'
      ),
      false
    )

    const badDistancePoi = result.pois.find(
      poi => poi.poiId === 'bad-distance'
    )

    assert.ok(badDistancePoi)

    assert.strictEqual(
      badDistancePoi.distanceInMeters,
      null
    )

    console.log('All getNearbyPois tests passed')

  } finally {
    axios.get = originalAxiosGet
  }
}

runTests().catch(error => {
  console.error('Test failed:', error)
  process.exit(1)
})