const cloud = require('wx-server-sdk')
const axios = require('axios')

const AMAP_API_KEY = process.env.AMAP_API_KEY

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const DEFAULT_POI_SEARCH_RADIUS_METERS = 3000
const MIN_POI_SEARCH_RADIUS_METERS = 200
const MAX_POI_SEARCH_RADIUS_METERS = 15000

const CATEGORY_TYPES = {
  park: [
    '110101', // 公园
  ],

  water: [
    '190201', // 海湾海峡
    '190204', // 河流
    '190205', // 湖泊
    '190217', // 湾
    '190218', // 洋
    '110208'  // 海滩
  ],

  shoppingStreet: [
    '061000', // 特色商业街
    '061001'  // 步行街
  ]
}

function getValidatedRadius(radius) {
  if (
    typeof radius !== 'number' ||
    !Number.isFinite(radius) ||
    radius < MIN_POI_SEARCH_RADIUS_METERS ||
    radius > MAX_POI_SEARCH_RADIUS_METERS
  ) {
    return DEFAULT_POI_SEARCH_RADIUS_METERS
  }

  return Math.round(radius)
}

exports.main = async (event, context) => {
  if (!AMAP_API_KEY) {
    return {
      success: false,
      error: {
        code: 'CONFIG_MISSING',
        message: 'AMap API key is not configured'
      }
    }
  }

  const { longitude, latitude, radius } = event || {}

  if (longitude == null || latitude == null) {
    return {
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Missing longitude or latitude'
      }
    }
  }

  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Invalid longitude or latitude'
      }
    }
  }

  const AMAP_AROUND_URL = 'https://restapi.amap.com/v5/place/around'
  const location = `${longitude.toFixed(6)},${latitude.toFixed(6)}`
  const searchRadius = getValidatedRadius(radius)

  try {
    const searches = Object.entries(CATEGORY_TYPES).map(
      async ([category, typecodes]) => {
        const response = await axios.get(AMAP_AROUND_URL, {
          params: {
            key: AMAP_API_KEY,
            location,
            radius: searchRadius,
            types: typecodes.join('|'),
            page_size: 6,
            sortrule: 'distance'
          },
          timeout: 5000
        })

        const data = response.data

        if (data.status !== '1') {
          const error = new Error(
            `AMap request failed for ${category}`
          )

          error.info = data.info
          error.infocode = data.infocode

          throw error
        }

        const pois = Array.isArray(data.pois)
          ? data.pois
              .filter(
                poi =>
                  poi.id &&
                  poi.name &&
                  typeof poi.location === 'string' &&
                  poi.location.split(',').length === 2
              )
              .map(poi => {
                const [poiLongitude, poiLatitude] =
                  poi.location.split(',')

                const parsedDistance =
                  poi.distance == null || poi.distance === ''
                    ? NaN
                    : Number(poi.distance)

                return {
                  poiId: poi.id,
                  name: poi.name,
                  category,
                  longitude: Number(poiLongitude),
                  latitude: Number(poiLatitude),
                  distanceInMeters: Number.isFinite(parsedDistance)
                    ? parsedDistance
                    : null,
                  address: poi.address,
                  providerMeta: {
                    type: poi.type,
                    typecode: poi.typecode
                  }
                }
              })
              .filter(
                poi =>
                  Number.isFinite(poi.longitude) &&
                  Number.isFinite(poi.latitude) &&
                  poi.longitude >= -180 &&
                  poi.longitude <= 180 &&
                  poi.latitude >= -90 &&
                  poi.latitude <= 90
              )
          : []

        return {
          category,
          pois
        }
      }
    )

    const results = await Promise.all(searches)

    const poisByCategory = {}

    for (const result of results) {
      poisByCategory[result.category] = result.pois
    }

    return {
      success: true,
      poisByCategory
    }

  } catch (error) {
    console.error('AMap request failed:', {
      message: error.message,
      status: error.response?.status,
      info: error.info ?? error.response?.data?.info,
      infocode: error.infocode ?? error.response?.data?.infocode
    })

    return {
      success: false,
      error: {
        code: 'POI_SEARCH_FAILED',
        message: 'Unable to retrieve nearby places'
      }
    }
  }
}