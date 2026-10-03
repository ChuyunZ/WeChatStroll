const { isProviderCode } = require('./errors')

const EXPLORE_URL = 'https://apis.map.qq.com/ws/place/v1/explore'
const CATEGORY_CODES = {
  park: ['221100'],
  water: ['261312', '261313', '261314', '222200'],
  shoppingStreet: ['132600']
}
// 347 is Tencent's documented no-result status. 387/393 remain scoped to
// this Explore adapter as empty-result statuses; they are not global provider errors.
const EMPTY_STATUSES = new Set([347, 387, 393])
const DEFAULT_SEARCH_RADIUS_METERS = 1000
const MIN_SEARCH_RADIUS_METERS = 200
const MAX_SEARCH_RADIUS_METERS = 1000

function getValidatedRadius(radius) {
  if (typeof radius !== 'number' || !Number.isFinite(radius)) {
    return DEFAULT_SEARCH_RADIUS_METERS
  }
  return Math.min(
    MAX_SEARCH_RADIUS_METERS,
    Math.max(MIN_SEARCH_RADIUS_METERS, Math.round(radius))
  )
}

function validCoordinates(latitude, longitude) {
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
}

function normalizePoi(poi, category) {
  if (!poi || typeof poi.id !== 'string' || !poi.id.trim() ||
      typeof poi.title !== 'string' || !poi.title.trim() || !poi.location ||
      !validCoordinates(poi.location.lat, poi.location.lng)) return null
  return {
    poiId: poi.id.trim(),
    name: poi.title.trim(),
    category,
    latitude: poi.location.lat,
    longitude: poi.location.lng,
    distanceInMeters: typeof poi._distance === 'number' && Number.isFinite(poi._distance) && poi._distance >= 0
      ? poi._distance : null,
    ...(typeof poi.address === 'string' ? { address: poi.address } : {})
  }
}

function createNearbyHandler({ apiKey, request }) {
  return async event => {
    if (!apiKey) return { success: false, error: { code: 'CONFIG_MISSING', message: 'Map API key is not configured' } }
    const { longitude, latitude, radius } = event || {}
    if (!validCoordinates(latitude, longitude)) {
      return { success: false, error: { code: 'INVALID_COORDINATES', message: 'Invalid longitude or latitude' } }
    }
    try {
      const poisByCategory = {}
      const searchRadius = getValidatedRadius(radius)
      // Sequential discovery. The application may choose a duration-aware radius,
      // while this provider boundary enforces Tencent's bounded radius policy.
      for (const [category, codes] of Object.entries(CATEGORY_CODES)) {
        const response = await request(EXPLORE_URL, { params: {
          key: apiKey,
          boundary: `nearby(${latitude.toFixed(6)},${longitude.toFixed(6)},${searchRadius},0)`,
          filter: `category=${codes.join(',')}`,
          orderby: '_distance', location_mode: 1, page_size: 6, page_index: 1
        } })
        const data = response && response.data
        if (data && EMPTY_STATUSES.has(data.status)) {
          poisByCategory[category] = []
        } else if (data && data.status === 0 && Array.isArray(data.data)) {
          poisByCategory[category] = data.data.map(poi => normalizePoi(poi, category)).filter(Boolean)
        } else {
          throw new Error('Invalid POI provider result')
        }
      }
      return { success: true, poisByCategory }
    } catch (error) {
      return { success: false, error: {
        code: isProviderCode(error && error.code) ? error.code : 'POI_SEARCH_FAILED',
        message: 'Unable to retrieve nearby places'
      } }
    }
  }
}

module.exports = { createNearbyHandler }
