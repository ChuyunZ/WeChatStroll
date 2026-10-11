const { isProviderUnavailableCode } = require('../utils/provider-errors')
const { requestId } = require('./map-planning-authorization')
const { rememberStreetEvidence } = require('./street-evidence')
const {
  isValidGeoPoint,
  copyGeoPoint
} = require('../utils/geo')

const {
  callCloudFunction
} = require('./cloud-function-client')

function isNonNegativeFiniteNumber(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

function normalizeWalkingRoute(route) {
  if (
    !route ||
    typeof route !== 'object' ||
    Array.isArray(route)
  ) {
    return null
  }

  if (
    !isNonNegativeFiniteNumber(route.distanceMeters) ||
    !isNonNegativeFiniteNumber(route.durationSeconds) ||
    !Array.isArray(route.polyline) ||
    route.polyline.length < 2 ||
    !route.polyline.every(isValidGeoPoint)
  ) {
    return null
  }

  return {
    success: true,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    polyline: route.polyline.map(copyGeoPoint)
  }
}

async function getWalkingSegment(
  fromPoint,
  toPoint,
  planningToken
) {
  if (
    !isValidGeoPoint(fromPoint) ||
    !isValidGeoPoint(toPoint)
  ) {
    return {
      success: false,
      error: 'INVALID_WALKING_SEGMENT_INPUT'
    }
  }

  let result

  try {
    result = await callCloudFunction(
      'mapProvider',
      {
        action: 'walkingRoute',
        requestId: requestId(),
        ...(planningToken ? { planningToken } : {}),
        start: copyGeoPoint(fromPoint),
        destination: copyGeoPoint(toPoint)
      },
      {
        fallbackCode: 'PROVIDER_GATEWAY_FAILED',
        fallbackMessage: 'Route service is temporarily unavailable.'
      }
    )
  } catch (error) {
    return {
      success: false,
      error: isProviderUnavailableCode(error.code) ? error.code : 'WALKING_SEGMENT_FAILED',

      causeCode:
        typeof error.code === 'string'
          ? error.code
          : 'WALKING_ROUTE_FAILED'
    }
  }

  const normalizedRoute = normalizeWalkingRoute(
    result.route
  )

  if (!normalizedRoute) {
    return {
      success: false,
      error: 'INVALID_WALKING_SEGMENT_RESPONSE'
    }
  }

  // Only the allowlisted cloud aggregate enters the sidecar. Caller inputs,
  // raw steps and legacy environmentStats never become evidence.
  return rememberStreetEvidence(normalizedRoute, result.route.streetEvidence)
}

module.exports = {
  getWalkingSegment
}
