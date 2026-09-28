const {
  isValidGeoPoint,
  areGeoPointsEqual
} = require('../utils/geo')

const {
  ROUTE_TYPES
} = require('../constants/route-types')

const {
  START_NODE_ID
} = require('./route-graph')

const {
  ROUTE_DURATION_TOLERANCE_RATIO,
  ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
  ROUTE_DURATION_MAX_TOLERANCE_SECONDS
} = require('../config/route-planning')

const NUMBER_TOLERANCE = 1e-6

const SUPPORTED_ROUTE_TYPES = new Set(
  Object.values(ROUTE_TYPES)
)

function isNonNegativeFiniteNumber(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

function isPositiveFiniteNumber(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  )
}

function areNearlyEqual(left, right) {
  const scale = Math.max(
    1,
    Math.abs(left),
    Math.abs(right)
  )

  return (
    Math.abs(left - right) <=
    NUMBER_TOLERANCE * scale
  )
}

function invalidRoute(reason, details = {}) {
  return {
    valid: false,
    error: 'ROUTE_VALIDATION_FAILED',
    reason,
    ...details
  }
}

function normalizeWaypointIds(waypointIds) {
  if (!Array.isArray(waypointIds)) {
    return null
  }

  const normalizedIds = []
  const seenIds = new Set()

  for (const rawPoiId of waypointIds) {
    if (
      typeof rawPoiId !== 'string' ||
      rawPoiId.trim() === ''
    ) {
      return null
    }

    const poiId = rawPoiId.trim()

    if (seenIds.has(poiId)) {
      return null
    }

    seenIds.add(poiId)
    normalizedIds.push(poiId)
  }

  return normalizedIds
}

function haveSameWaypointSet(
  leftWaypointIds,
  rightWaypointIds
) {
  if (
    leftWaypointIds.length !==
    rightWaypointIds.length
  ) {
    return false
  }

  const rightSet = new Set(
    rightWaypointIds
  )

  return leftWaypointIds.every(
    poiId => rightSet.has(poiId)
  )
}

function buildExpectedTraversalIds(
  waypointIds,
  routeType
) {
  if (
    routeType === ROUTE_TYPES.POINT_TO_POINT
  ) {
    return [
      START_NODE_ID,
      ...waypointIds
    ]
  }

  if (
    routeType === ROUTE_TYPES.LOOP
  ) {
    return [
      START_NODE_ID,
      ...waypointIds,
      START_NODE_ID
    ]
  }

  if (
    routeType === ROUTE_TYPES.OUT_AND_BACK
  ) {
    const returnWaypointIds =
      waypointIds
        .slice(0, -1)
        .reverse()

    return [
      START_NODE_ID,
      ...waypointIds,
      ...returnWaypointIds,
      START_NODE_ID
    ]
  }

  return null
}

function mergeSegmentPolylines(segments) {
  const mergedPolyline = []

  for (const segment of segments) {
    for (
      let index = 0;
      index < segment.polyline.length;
      index++
    ) {
      const point =
        segment.polyline[index]

      const previousPoint =
        mergedPolyline[
          mergedPolyline.length - 1
        ]

      if (
        index === 0 &&
        previousPoint &&
        areGeoPointsEqual(
          previousPoint,
          point
        )
      ) {
        continue
      }

      mergedPolyline.push(point)
    }
  }

  return mergedPolyline
}

function arePolylinesEqual(
  leftPolyline,
  rightPolyline
) {
  if (
    leftPolyline.length !==
    rightPolyline.length
  ) {
    return false
  }

  return leftPolyline.every(
    (point, index) =>
      areGeoPointsEqual(
        point,
        rightPolyline[index]
      )
  )
}

function getAllowedDurationRange(
  requestedDurationMinutes
) {
  if (
    requestedDurationMinutes === undefined ||
    requestedDurationMinutes === null
  ) {
    return {
      valid: true,
      constrained: false
    }
  }

  if (
    typeof requestedDurationMinutes !== 'number' ||
    !Number.isFinite(requestedDurationMinutes) ||
    requestedDurationMinutes <= 0
  ) {
    return {
      valid: false,
      error: 'INVALID_REQUESTED_DURATION'
    }
  }

  const targetSeconds =
    requestedDurationMinutes * 60

  if (!Number.isFinite(targetSeconds)) {
    return {
      valid: false,
      error: 'INVALID_REQUESTED_DURATION'
    }
  }

  const proportionalToleranceSeconds =
    targetSeconds *
    ROUTE_DURATION_TOLERANCE_RATIO

  const toleranceSeconds =
    Math.min(
      ROUTE_DURATION_MAX_TOLERANCE_SECONDS,
      Math.max(
        ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
        proportionalToleranceSeconds
      )
    )

  return {
    valid: true,
    constrained: true,

    targetSeconds,
    toleranceSeconds,

    minSeconds:
      Math.max(
        0,
        targetSeconds -
          toleranceSeconds
      ),

    maxSeconds:
      targetSeconds +
      toleranceSeconds
  }
}

function validateWaypoints(walkingRoute) {
  if (
    !Array.isArray(walkingRoute.waypoints) ||
    walkingRoute.waypoints.length === 0
  ) {
    return invalidRoute(
      'INVALID_ROUTE_WAYPOINTS'
    )
  }

  const waypointIds = []
  const seenWaypointIds = new Set()

  for (const waypoint of walkingRoute.waypoints) {
    if (
      !waypoint ||
      typeof waypoint !== 'object' ||
      Array.isArray(waypoint) ||
      typeof waypoint.poiId !== 'string' ||
      waypoint.poiId.trim() === '' ||
      typeof waypoint.name !== 'string' ||
      waypoint.name.trim() === '' ||
      !isValidGeoPoint(waypoint)
    ) {
      return invalidRoute(
        'INVALID_ROUTE_WAYPOINT'
      )
    }

    const poiId =
      waypoint.poiId.trim()

    if (seenWaypointIds.has(poiId)) {
      return invalidRoute(
        'DUPLICATE_ROUTE_WAYPOINT',
        {
          poiId
        }
      )
    }

    seenWaypointIds.add(poiId)
    waypointIds.push(poiId)
  }

  return {
    valid: true,
    waypointIds
  }
}

function validateRouteOrder(
  walkingRoute,
  waypointIds
) {
  const routeOrder =
    walkingRoute.routeOrder

  if (
    !routeOrder ||
    typeof routeOrder !== 'object' ||
    Array.isArray(routeOrder) ||
    typeof routeOrder.source !== 'string' ||
    routeOrder.source.trim() === ''
  ) {
    return invalidRoute(
      'INVALID_ROUTE_ORDER'
    )
  }

  const orderedWaypointIds =
    normalizeWaypointIds(
      routeOrder.orderedWaypointIds
    )

  if (
    !orderedWaypointIds ||
    orderedWaypointIds.length !==
      waypointIds.length
  ) {
    return invalidRoute(
      'INVALID_ROUTE_ORDER'
    )
  }

  for (
    let index = 0;
    index < waypointIds.length;
    index++
  ) {
    if (
      orderedWaypointIds[index] !==
      waypointIds[index]
    ) {
      return invalidRoute(
        'ROUTE_ORDER_MISMATCH'
      )
    }
  }

  return {
    valid: true
  }
}

function validateSegments(
  walkingRoute,
  waypointIds
) {
  if (
    !Array.isArray(walkingRoute.segments) ||
    walkingRoute.segments.length === 0
  ) {
    return invalidRoute(
      'INVALID_ROUTE_SEGMENTS'
    )
  }

  const traversalIds =
    buildExpectedTraversalIds(
      waypointIds,
      walkingRoute.routeType
    )

  if (!traversalIds) {
    return invalidRoute(
      'INVALID_ROUTE_TYPE'
    )
  }

  const expectedSegmentCount =
    traversalIds.length - 1

  if (
    walkingRoute.segments.length !==
    expectedSegmentCount
  ) {
    return invalidRoute(
      'ROUTE_SEGMENT_COUNT_MISMATCH',
      {
        expectedSegmentCount,
        actualSegmentCount:
          walkingRoute.segments.length
      }
    )
  }

  let totalDistanceMeters = 0
  let totalDurationSeconds = 0

  for (
    let index = 0;
    index < walkingRoute.segments.length;
    index++
  ) {
    const segment =
      walkingRoute.segments[index]

    if (
      !segment ||
      typeof segment !== 'object' ||
      Array.isArray(segment) ||
      typeof segment.from !== 'string' ||
      segment.from.trim() === '' ||
      typeof segment.to !== 'string' ||
      segment.to.trim() === '' ||
      !isNonNegativeFiniteNumber(
        segment.distanceMeters
      ) ||
      !isNonNegativeFiniteNumber(
        segment.durationSeconds
      ) ||
      !Array.isArray(segment.polyline) ||
      segment.polyline.length < 2 ||
      !segment.polyline.every(
        isValidGeoPoint
      )
    ) {
      return invalidRoute(
        'INVALID_ROUTE_SEGMENT',
        {
          segmentIndex: index
        }
      )
    }

    const expectedFrom =
      traversalIds[index]

    const expectedTo =
      traversalIds[index + 1]

    if (
      segment.from !== expectedFrom ||
      segment.to !== expectedTo
    ) {
      return invalidRoute(
        'ROUTE_SEGMENT_ORDER_MISMATCH',
        {
          segmentIndex: index,
          expectedFrom,
          expectedTo,
          actualFrom: segment.from,
          actualTo: segment.to
        }
      )
    }

    totalDistanceMeters +=
      segment.distanceMeters

    totalDurationSeconds +=
      segment.durationSeconds
  }

  if (
    !areNearlyEqual(
      totalDistanceMeters,
      walkingRoute.distanceMeters
    )
  ) {
    return invalidRoute(
      'ROUTE_DISTANCE_MISMATCH'
    )
  }

  if (
    !areNearlyEqual(
      totalDurationSeconds,
      walkingRoute.durationSeconds
    )
  ) {
    return invalidRoute(
      'ROUTE_DURATION_MISMATCH'
    )
  }

  const mergedPolyline =
    mergeSegmentPolylines(
      walkingRoute.segments
    )

  if (
    !arePolylinesEqual(
      mergedPolyline,
      walkingRoute.polyline
    )
  ) {
    return invalidRoute(
      'ROUTE_POLYLINE_MISMATCH'
    )
  }

  return {
    valid: true
  }
}

function validateGeneratedWalkingRoute(
  walkingRoute,
  {
    allowedWaypointIds,
    requestedDurationMinutes
  } = {}
) {
  if (
    !walkingRoute ||
    typeof walkingRoute !== 'object' ||
    Array.isArray(walkingRoute) ||
    walkingRoute.success !== true
  ) {
    return invalidRoute(
      'INVALID_ROUTE_RESULT'
    )
  }

  if (
    !isPositiveFiniteNumber(
      walkingRoute.distanceMeters
    ) ||
    !isPositiveFiniteNumber(
      walkingRoute.durationSeconds
    )
  ) {
    return invalidRoute(
      'INVALID_ROUTE_METRICS'
    )
  }

  if (
    !Array.isArray(walkingRoute.polyline) ||
    walkingRoute.polyline.length < 2 ||
    !walkingRoute.polyline.every(
      isValidGeoPoint
    )
  ) {
    return invalidRoute(
      'INVALID_ROUTE_POLYLINE'
    )
  }

  if (
    !SUPPORTED_ROUTE_TYPES.has(
      walkingRoute.routeType
    )
  ) {
    return invalidRoute(
      'INVALID_ROUTE_TYPE'
    )
  }

  const expectedReturnsToStart =
    walkingRoute.routeType !==
    ROUTE_TYPES.POINT_TO_POINT

  if (
    walkingRoute.returnsToStart !==
    expectedReturnsToStart
  ) {
    return invalidRoute(
      'ROUTE_RETURN_BEHAVIOR_MISMATCH'
    )
  }

  const waypointValidation =
    validateWaypoints(
      walkingRoute
    )

  if (!waypointValidation.valid) {
    return waypointValidation
  }

  const waypointIds =
    waypointValidation.waypointIds

  if (allowedWaypointIds !== undefined) {
    const normalizedAllowedWaypointIds =
      normalizeWaypointIds(
        allowedWaypointIds
      )

    if (
      !normalizedAllowedWaypointIds ||
      !haveSameWaypointSet(
        waypointIds,
        normalizedAllowedWaypointIds
      )
    ) {
      return invalidRoute(
        'ROUTE_WAYPOINT_SCOPE_MISMATCH'
      )
    }
  }

  const orderValidation =
    validateRouteOrder(
      walkingRoute,
      waypointIds
    )

  if (!orderValidation.valid) {
    return orderValidation
  }

  const segmentValidation =
    validateSegments(
      walkingRoute,
      waypointIds
    )

  if (!segmentValidation.valid) {
    return segmentValidation
  }

  const durationRange =
    getAllowedDurationRange(
      requestedDurationMinutes
    )

  if (!durationRange.valid) {
    return invalidRoute(
      durationRange.error
    )
  }

  if (
    durationRange.constrained &&
    (
      walkingRoute.durationSeconds <
        durationRange.minSeconds ||
      walkingRoute.durationSeconds >
        durationRange.maxSeconds
    )
  ) {
    return invalidRoute(
      'ROUTE_DURATION_OUT_OF_RANGE',
      {
        actualDurationSeconds:
          walkingRoute.durationSeconds,

        targetDurationSeconds:
          durationRange.targetSeconds,

        minDurationSeconds:
          durationRange.minSeconds,

        maxDurationSeconds:
          durationRange.maxSeconds
      }
    )
  }

  return {
    valid: true,

    ...(durationRange.constrained
      ? {
          durationRange: {
            targetSeconds:
              durationRange.targetSeconds,

            toleranceSeconds:
              durationRange.toleranceSeconds,

            minSeconds:
              durationRange.minSeconds,

            maxSeconds:
              durationRange.maxSeconds
          }
        }
      : {})
  }
}

module.exports = {
  getAllowedDurationRange,
  validateGeneratedWalkingRoute
}