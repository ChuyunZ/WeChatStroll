const {
  isValidGeoPoint,
  copyGeoPoint,
  areGeoPointsEqual
} = require('../utils/geo')

const {
  ROUTE_TYPES
} = require('../constants/route-types')

const {
  getNodeId
} = require('./route-graph')

const NORMAL_ROAD_WALK_TYPE = '0'
const NUMBER_TOLERANCE = 1e-6

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

function normalizeRouteSource(source) {
  return (
    typeof source === 'string' &&
    source.trim() !== ''
  )
    ? source.trim()
    : 'unknown'
}

function mergeSegmentPolylines(segments) {
  const mergedPolyline = []

  for (const segment of segments) {
    for (let index = 0; index < segment.polyline.length; index++) {
      const point = segment.polyline[index]
      const previousPoint = mergedPolyline[mergedPolyline.length - 1]

      if (
        index === 0 &&
        previousPoint &&
        areGeoPointsEqual(previousPoint, point)
      ) {
        continue
      }

      mergedPolyline.push(copyGeoPoint(point))
    }
  }

  return mergedPolyline
}

function copyEnvironmentStats(environmentStats) {
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
    !isNonNegativeFiniteNumber(totalStepDistanceMeters) ||
    !isNonNegativeFiniteNumber(analyzedDistanceMeters) ||
    !isNonNegativeFiniteNumber(unknownWalkTypeDistanceMeters) ||
    !isNonNegativeFiniteNumber(normalRoadDistanceMeters) ||
    !isValidRatio(normalRoadRatio) ||
    !isValidRatio(walkTypeCoverageRatio) ||
    !walkTypeDistanceMeters ||
    typeof walkTypeDistanceMeters !== 'object' ||
    Array.isArray(walkTypeDistanceMeters)
  ) {
    return null
  }

  const copiedWalkTypeDistanceMeters = {}
  let analyzedWalkTypeDistanceMeters = 0

  for (const [walkType, distanceMeters] of Object.entries(
    walkTypeDistanceMeters
  )) {
    if (!isNonNegativeFiniteNumber(distanceMeters)) {
      return null
    }

    copiedWalkTypeDistanceMeters[walkType] = distanceMeters
    analyzedWalkTypeDistanceMeters += distanceMeters
  }

  /*
   * Environment statistics come from one set of walking steps,
   * so their component values must also agree with each other.
   */
  if (
    !areNearlyEqual(
      analyzedDistanceMeters + unknownWalkTypeDistanceMeters,
      totalStepDistanceMeters
    )
  ) {
    return null
  }

  if (
    !areNearlyEqual(
      analyzedWalkTypeDistanceMeters,
      analyzedDistanceMeters
    )
  ) {
    return null
  }

  const expectedNormalRoadDistanceMeters =
    copiedWalkTypeDistanceMeters[NORMAL_ROAD_WALK_TYPE] || 0

  if (
    !areNearlyEqual(
      normalRoadDistanceMeters,
      expectedNormalRoadDistanceMeters
    )
  ) {
    return null
  }

  if (
    normalRoadDistanceMeters > analyzedDistanceMeters &&
    !areNearlyEqual(
      normalRoadDistanceMeters,
      analyzedDistanceMeters
    )
  ) {
    return null
  }

  const expectedNormalRoadRatio =
    totalStepDistanceMeters > 0
      ? normalRoadDistanceMeters / totalStepDistanceMeters
      : 0

  const expectedWalkTypeCoverageRatio =
    totalStepDistanceMeters > 0
      ? analyzedDistanceMeters / totalStepDistanceMeters
      : 0

  if (
    !areNearlyEqual(
      normalRoadRatio,
      expectedNormalRoadRatio
    ) ||
    !areNearlyEqual(
      walkTypeCoverageRatio,
      expectedWalkTypeCoverageRatio
    )
  ) {
    return null
  }

  return {
    totalStepDistanceMeters,
    analyzedDistanceMeters,
    unknownWalkTypeDistanceMeters,
    normalRoadDistanceMeters,
    normalRoadRatio,
    walkTypeCoverageRatio,
    walkTypeDistanceMeters: copiedWalkTypeDistanceMeters
  }
}

function normalizeSuccessfulSegment(result) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.success !== true ||
    !isNonNegativeFiniteNumber(result.distanceMeters) ||
    !isNonNegativeFiniteNumber(result.durationSeconds) ||
    !Array.isArray(result.polyline) ||
    result.polyline.length < 2 ||
    !result.polyline.every(isValidGeoPoint)
  ) {
    return null
  }

  const environmentStats = copyEnvironmentStats(
    result.environmentStats
  )

  return {
    success: true,
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    polyline: result.polyline.map(copyGeoPoint),

    ...(environmentStats
      ? {
          environmentStats
        }
      : {})
  }
}

function normalizeSegmentFailure(result) {
  const error =
    result &&
    typeof result.error === 'string' &&
    result.error.trim() !== ''
      ? result.error.trim()
      : 'WALKING_SEGMENT_FAILED'

  const causeCode =
    result &&
    typeof result.causeCode === 'string' &&
    result.causeCode.trim() !== ''
      ? result.causeCode.trim()
      : null

  return {
    success: false,
    error,

    ...(causeCode
      ? {
          causeCode
        }
      : {})
  }
}

function aggregateEnvironmentStats(segments) {
  if (
    segments.length === 0 ||
    segments.some(segment => !segment.environmentStats)
  ) {
    return null
  }

  const aggregate = {
    totalStepDistanceMeters: 0,
    analyzedDistanceMeters: 0,
    unknownWalkTypeDistanceMeters: 0,
    normalRoadDistanceMeters: 0,
    walkTypeDistanceMeters: {}
  }

  for (const segment of segments) {
    const stats = segment.environmentStats

    aggregate.totalStepDistanceMeters += stats.totalStepDistanceMeters
    aggregate.analyzedDistanceMeters += stats.analyzedDistanceMeters
    aggregate.unknownWalkTypeDistanceMeters +=
      stats.unknownWalkTypeDistanceMeters
    aggregate.normalRoadDistanceMeters += stats.normalRoadDistanceMeters

    for (const [walkType, distanceMeters] of Object.entries(
      stats.walkTypeDistanceMeters
    )) {
      aggregate.walkTypeDistanceMeters[walkType] =
        (aggregate.walkTypeDistanceMeters[walkType] || 0) +
        distanceMeters
    }
  }

  const totalStepDistanceMeters = aggregate.totalStepDistanceMeters

  return {
    ...aggregate,

    normalRoadRatio:
      totalStepDistanceMeters > 0
        ? aggregate.normalRoadDistanceMeters / totalStepDistanceMeters
        : 0,

    walkTypeCoverageRatio:
      totalStepDistanceMeters > 0
        ? aggregate.analyzedDistanceMeters / totalStepDistanceMeters
        : 0
  }
}

function copyPublicWaypoint(waypoint) {
  const {
    nodeType,
    nodeId,
    ...publicWaypoint
  } = waypoint

  return {
    ...publicWaypoint,

    ...(publicWaypoint.providerMeta
      ? {
          providerMeta: {
            ...publicWaypoint.providerMeta
          }
        }
      : {})
  }
}

function buildSuccessfulRouteResult({
  waypointNodes,
  resolvedEdges,
  routeType,
  source
}) {
  const segments = resolvedEdges.map(
    ({
      fromNode,
      toNode,
      segment
    }) => ({
      from: getNodeId(fromNode),
      to: getNodeId(toNode),
      distanceMeters: segment.distanceMeters,
      durationSeconds: segment.durationSeconds,
      polyline: segment.polyline.map(copyGeoPoint),

      ...(segment.environmentStats
        ? {
            environmentStats: copyEnvironmentStats(
              segment.environmentStats
            )
          }
        : {})
    })
  )

  const distanceMeters = segments.reduce(
    (total, segment) => total + segment.distanceMeters,
    0
  )

  const durationSeconds = segments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0
  )

  const environmentStats = aggregateEnvironmentStats(segments)
  const normalizedSource = normalizeRouteSource(source)

  return {
    success: true,
    distanceMeters,
    durationSeconds,
    durationMinutes: Math.ceil(durationSeconds / 60),
    polyline: mergeSegmentPolylines(segments),
    waypoints: waypointNodes.map(copyPublicWaypoint),
    segments,
    routeType,
    returnsToStart: routeType !== ROUTE_TYPES.POINT_TO_POINT,

    routeOrder: {
      orderedWaypointIds: waypointNodes.map(
        waypoint => waypoint.poiId
      ),
      source: normalizedSource
    },

    ...(environmentStats
      ? {
          environmentStats
        }
      : {})
  }
}

module.exports = {
  normalizeSuccessfulSegment,
  normalizeSegmentFailure,
  buildSuccessfulRouteResult
}