const { isProviderCode } = require('./errors')

const WALKING_URL = 'https://apis.map.qq.com/ws/direction/v1/walking/'

function isValidPoint(point) {
  return !!point && typeof point === 'object' && !Array.isArray(point) &&
    Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
    Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0
}

function decodePolyline(compressed) {
  if (!Array.isArray(compressed) || compressed.length < 4 || compressed.length % 2 !== 0) {
    throw new Error('Invalid walking polyline')
  }
  const polyline = []
  let latitude = 0
  let longitude = 0
  for (let index = 0; index < compressed.length; index += 2) {
    if (!Number.isFinite(compressed[index]) || !Number.isFinite(compressed[index + 1])) {
      throw new Error('Invalid walking polyline')
    }
    latitude = index === 0 ? compressed[index] : latitude + compressed[index] / 1000000
    longitude = index === 0 ? compressed[index + 1] : longitude + compressed[index + 1] / 1000000
    const point = { latitude, longitude }
    if (!isValidPoint(point)) throw new Error('Invalid walking polyline')
    polyline.push(point)
  }
  return polyline
}

const failure = (code, message = 'Unable to generate walking route') => ({ success: false, error: { code, message } })
const notFound = () => failure('ROUTE_NOT_FOUND', 'No walking route was found')

function createWalkingHandler({ apiKey, request }) {
  return async event => {
    if (!apiKey) return failure('CONFIG_MISSING', 'Map API key is not configured')
    const { start, destination } = event || {}
    if (!isValidPoint(start) || !isValidPoint(destination)) {
      return failure('INVALID_COORDINATES', 'Invalid start or destination coordinates')
    }
    let data
    try {
      const response = await request(WALKING_URL, { params: {
        key: apiKey,
        from: `${start.latitude.toFixed(6)},${start.longitude.toFixed(6)}`,
        to: `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`
      } })
      data = response && response.data
    } catch (error) {
      return failure(isProviderCode(error && error.code) ? error.code : 'PROVIDER_GATEWAY_FAILED')
    }
    // Only explicit no-route results are deterministic edge failures.
    if (data && data.status === 378) return notFound()
    if (!data || data.status !== 0) return failure('PROVIDER_GATEWAY_FAILED')
    try {
      const routes = data.result && data.result.routes
      if (!Array.isArray(routes)) throw new Error('Invalid walking routes')
      if (routes.length === 0) return notFound()
      const route = routes[0]
      if (!route || typeof route !== 'object' || Array.isArray(route) ||
          !isNonNegativeNumber(route.distance) || !isNonNegativeNumber(route.duration)) {
        throw new Error('Invalid walking route facts')
      }
      const durationSeconds = route.duration * 60
      if (!Number.isFinite(durationSeconds)) throw new Error('Invalid walking duration')
      return { success: true, route: {
        distanceMeters: route.distance,
        durationSeconds,
        polyline: decodePolyline(route.polyline)
      } }
    } catch (_) {
      return failure('PROVIDER_GATEWAY_FAILED')
    }
  }
}

module.exports = { createWalkingHandler }
