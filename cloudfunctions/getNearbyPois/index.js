const cloud = require('wx-server-sdk')
const AMAP_KEY = process.env.AMAP_KEY

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async (event, context) => {
  if (!AMAP_KEY) {
    return {
      success: false,
      error: 'AMap API key is not configured'
    }
  }

  const { longitude, latitude } = event //取经纬度
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

  const location = `${longitude}, ${latitude}`
  const radius = 3000
  const types = '110100|110101|110105'

  const url = `https://sg-restapi.opnavi.com/v3/place/around?key=${AMAP_KEY}&&types=${types}&location=${location}&radius=${radius}`
  
  try {
    const response = await fetch(url)
 
    if (!response.ok) {
      return {
        success: false,
        error: 'Failed to connect to AMap API',
        details: `HTTP ${response.status}`
      }
    }

    const data = await response.json()

    if (data.status !== '1') {
      return {
        success: false,
        error: 'AMap API returned an error',
        details: {
          info: data.info,
          infocode: data.infocode
        }
      }
    }

    const pois = Array.isArray(data.pois)
      ? data.pois.map(poi => {
          const [poiLongitude, poiLatitude] = poi.location.split(',')

          return {
            poiId: poi.id,
            name: poi.name,
            category: 'park',
            longitude: Number(poiLongitude),
            latitude: Number(poiLatitude),
            distance: Number(poi.distance),
            type: poi.type,
            typecode: poi.typecode,
            address: poi.address
          }
        })
      : []

    return {
      success: true,
      data: pois
    }
  }
  catch (error){
    console.error('AMap request failed:', error)

    return {
      success: false,
      error: 'Failed to connect to AMap API'
    }
  }

}