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

function isValidRatio(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function normalizeEnvironmentStats(environmentStats) {
  if (
    !environmentStats ||
    typeof environmentStats !== 'object' ||
    Array.isArray(environmentStats)
  ) {
    return null
  }

  const {
    totalStepDistanceMeters,
    analyzedDistanceMeters,
    unknownWalkTypeDistanceMeters,
    normalRoadDistanceMeters,
    normalRoadRatio,
    walkTypeCoverageRatio,
    walkTypeDistanceMeters
  } = environmentStats

  if (
    !isNonNegativeFiniteNumber(
      totalStepDistanceMeters
    ) ||
    !isNonNegativeFiniteNumber(
      analyzedDistanceMeters
    ) ||
    !isNonNegativeFiniteNumber(
      unknownWalkTypeDistanceMeters
    ) ||
    !isNonNegativeFiniteNumber(
      normalRoadDistanceMeters
    ) ||
    !isValidRatio(normalRoadRatio) ||
    !isValidRatio(walkTypeCoverageRatio) ||
    !walkTypeDistanceMeters ||
    typeof walkTypeDistanceMeters !== 'object' ||
    Array.isArray(walkTypeDistanceMeters)
  ) {
    return null
  }

  const normalizedWalkTypeDistances = {}

  for (
    const [walkType, distanceMeters]
    of Object.entries(walkTypeDistanceMeters)
  ) {
    if (
      !isNonNegativeFiniteNumber(
        distanceMeters
      )
    ) {
      return null
    }

    normalizedWalkTypeDistances[walkType] =
      distanceMeters
  }

  return {
    totalStepDistanceMeters,
    analyzedDistanceMeters,
    unknownWalkTypeDistanceMeters,
    normalRoadDistanceMeters,
    normalRoadRatio,
    walkTypeCoverageRatio,
    walkTypeDistanceMeters:
      normalizedWalkTypeDistances
  }
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
    !isNonNegativeFiniteNumber(
      route.distanceMeters
    ) ||
    !isNonNegativeFiniteNumber(
      route.durationSeconds
    ) ||
    !Array.isArray(route.polyline) ||
    route.polyline.length < 2 ||
    !route.polyline.every(isValidGeoPoint)
  ) {
    return null
  }

  const environmentStats =
    normalizeEnvironmentStats(
      route.environmentStats
    )

  return {
    success: true,

    distanceMeters:
      route.distanceMeters,

    durationSeconds:
      route.durationSeconds,

    polyline:
      route.polyline.map(
        copyGeoPoint
      ),

    ...(environmentStats
      ? {
          environmentStats
        }
      : {})
  }
}

async function getWalkingSegment(
  fromPoint,
  toPoint
) {
  if (
    !isValidGeoPoint(fromPoint) ||
    !isValidGeoPoint(toPoint)
  ) {
    return {
      success: false,
      error:
        'INVALID_WALKING_SEGMENT_INPUT'
    }
  }

  let result

  try {
    result = await callCloudFunction(
      'getWalkingRoute',
      {
        start:
          copyGeoPoint(fromPoint),

        destination:
          copyGeoPoint(toPoint)
      },
      {
        fallbackCode:
          'WALKING_ROUTE_FAILED',

        fallbackMessage:
          'Unable to retrieve walking route.'
      }
    )
  } catch (error) {
    return {
      success: false,
      error:
        'WALKING_SEGMENT_FAILED',

      causeCode:
        typeof error.code === 'string'
          ? error.code
          : 'WALKING_ROUTE_FAILED'
    }
  }

  const normalizedRoute =
    normalizeWalkingRoute(
      result.route
    )

  if (!normalizedRoute) {
    return {
      success: false,
      error:
        'INVALID_WALKING_SEGMENT_RESPONSE'
    }
  }

  return normalizedRoute
}

module.exports = {
  getWalkingSegment
}