const { isProviderCode } = require('./errors')
const { normalizeStreetEvidence } = require('./street-evidence')

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

// TEMPORARY E2E DIAGNOSTIC for PR #105. Remove before merging the feature.
// Explicit opt-in only; no raw steps, coordinates, URLs or credentials are emitted.
const DIAGNOSTIC_WALK_TYPES = new Set([0, 1, 2, 3])

function summarizeStreetCoverage(route) {
  const stepsPresent = Array.isArray(route.steps)
  const steps = stepsPresent ? route.steps : []
  let stepDistanceMeters = 0
  let classifiedDistanceMeters = 0
  let unclassifiedTypeDistanceMeters = 0
  let classifiedStepCount = 0
  let missingTypeStepCount = 0
  let unknownTypeStepCount = 0
  let invalidDistanceStepCount = 0

  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !Number.isFinite(step.distance) || step.distance < 0) {
      invalidDistanceStepCount++
      continue
    }
    stepDistanceMeters += step.distance
    if (DIAGNOSTIC_WALK_TYPES.has(step.type)) {
      classifiedDistanceMeters += step.distance
      classifiedStepCount++
    } else {
      unclassifiedTypeDistanceMeters += step.distance
      if (!Object.prototype.hasOwnProperty.call(step, 'type')) missingTypeStepCount++
      else unknownTypeStepCount++
    }
  }

  const finiteOrNull = value => Number.isFinite(value) ? value : null
  return {
    routeDistanceMeters: route.distance,
    stepDistanceMeters: finiteOrNull(stepDistanceMeters),
    classifiedDistanceMeters: finiteOrNull(classifiedDistanceMeters),
    unclassifiedTypeDistanceMeters: finiteOrNull(unclassifiedTypeDistanceMeters),
    routeMinusStepsMeters: finiteOrNull(route.distance - stepDistanceMeters),
    stepsPresent,
    stepCount: steps.length,
    classifiedStepCount,
    missingTypeStepCount,
    unknownTypeStepCount,
    invalidDistanceStepCount
  }
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
      const streetEvidence = normalizeStreetEvidence(route)
      const decodedPolyline = decodePolyline(route.polyline)
      return {
        success: true,
        route: {
          distanceMeters: route.distance,
          durationSeconds,
          polyline: decodedPolyline,
          ...(streetEvidence ? { streetEvidence } : {})
        },
        ...(event && event.__streetCoverageDiagnostic === true
          ? { streetCoverageDiagnostic: summarizeStreetCoverage(route) }
          : {})
      }
    } catch (_) {
      return failure('PROVIDER_GATEWAY_FAILED')
    }
  }
}

module.exports = { createWalkingHandler }
