const { transferStreetEvidence, rememberStreetEvidence, aggregateStreetEvidence } = require('./street-evidence')
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

function isNonNegativeFiniteNumber(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
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

  return transferStreetEvidence(result, {
    success: true,
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    polyline: result.polyline.map(copyGeoPoint)
  })
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

function copyPublicWaypoint(waypoint) {
  return {
    poiId: waypoint.poiId, name: waypoint.name, category: waypoint.category,
    latitude: waypoint.latitude, longitude: waypoint.longitude,
    distanceInMeters: waypoint.distanceInMeters,
    ...(typeof waypoint.address === 'string' ? { address: waypoint.address } : {})
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
      polyline: segment.polyline.map(copyGeoPoint)
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

  const normalizedSource = normalizeRouteSource(source)

  return rememberStreetEvidence({
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
    }
  }, aggregateStreetEvidence(resolvedEdges.map(edge => edge.segment)))
}

module.exports = {
  normalizeSuccessfulSegment,
  normalizeSegmentFailure,
  buildSuccessfulRouteResult
}
