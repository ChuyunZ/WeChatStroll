const cloud = require('wx-server-sdk')
const axios = require('axios')

const AMAP_API_KEY = process.env.AMAP_API_KEY

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const CATEGORY_TYPES = {
  park: [
    '110101',
    '110105'
  ],

  water: [
    '190201',
    '190204',
    '190205',
    '190217',
    '190218',
    '110208'
  ],

  shoppingStreet: [
    '061000', // 特色商业街
    '061001'  // 步行街
  ]
}

exports.main = async (event, context) => {
  if (!AMAP_API_KEY) {
    return {
      success: false,
      error: 'AMap API key is not configured'
    }
  }

  const { longitude, latitude } = event

  if (longitude == null || latitude == null) {
    return {
      success: false,
      error: 'Missing longitude or latitude'
    }
  }

  if (typeof longitude !== 'number' || typeof latitude !== 'number' || !Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return {
      success: false,
      error: 'Invalid longitude or latitude'
    }
  }

  const AMAP_AROUND_URL = 'https://restapi.amap.com/v5/place/around'
  const location = `${longitude},${latitude}`
  const radius = 3000

  try {
    const searches = Object.entries(CATEGORY_TYPES).map(
      async ([category, typecodes]) => {
        const response = await axios.get(AMAP_AROUND_URL, {
          params: {
            key: AMAP_API_KEY,
            location,
            radius,
            types: typecodes.join('|'),
            page_size: 20,
            sortrule: 'distance'
          }
        })

        const data = response.data

        if (data.status !== '1') {
          throw new Error(
            `AMap error for ${category}: ${data.info} (${data.infocode})`
          )
        }

        const pois = Array.isArray(data.pois)
          ? data.pois
              .filter(poi => poi.location)
              .map(poi => {
                const [poiLongitude, poiLatitude] =
                  poi.location.split(',')

                return {
                  poiId: poi.id,
                  name: poi.name,
                  category,
                  longitude: Number(poiLongitude),
                  latitude: Number(poiLatitude),
                  distance_in_meters: Number(poi.distance),
                  type: poi.type,
                  typecode: poi.typecode,
                  address: poi.address
                }
              })
          : []

        return {
          category,
          pois
        }
      }
    )

    const results = await Promise.all(searches)

    const nearbyPois = {}

    for (const result of results) {
      nearbyPois[result.category] = result.pois
    }

    return {
      success: true,
      data: nearbyPois
    }

  } catch (error) {
    console.error('AMap request failed:', error)

    return {
      success: false,
      error: 'Failed to get nearby POIs',
      details: error.message
    }
  }
}