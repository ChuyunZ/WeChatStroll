const {
  isValidGeoPoint,
  copyGeoPoint,
  areGeoPointsEqual
} = require('../utils/geo')

const {
  createCodedError
} = require('../utils/errors')

const {
  getWalkingSegment
} = require('./walking-segment')

const {
  EXACT_ORDERING_MAX_WAYPOINTS,
  SEGMENT_FETCH_CONCURRENCY
} = require('../config/route-planning')

const {
  ROUTE_TYPES
} = require('../constants/route-types')

const START_NODE_ID = 'START'

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

function isValidRatio(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function createStartNode(start) {
  return {
    nodeType: 'start',
    nodeId: START_NODE_ID,
    latitude: start.latitude,
    longitude: start.longitude
  }
}

function createVerifiedWaypointNode(waypoint) {
  if (
    !waypoint ||
    typeof waypoint !== 'object' ||
    Array.isArray(waypoint) ||
    typeof waypoint.poiId !== 'string' ||
    waypoint.poiId.trim() === '' ||
    !isValidGeoPoint(waypoint)
  ) {
    throw createCodedError(
      'INVALID_VERIFIED_WAYPOINT',
      'Every verified waypoint must have a valid poiId and coordinates.'
    )
  }

  const poiId = waypoint.poiId.trim()

  return {
    ...waypoint,
    poiId,
    nodeType: 'waypoint',
    nodeId: poiId
  }
}

function createWaypointIndex(verifiedWaypointPool) {
  if (!Array.isArray(verifiedWaypointPool)) {
    throw createCodedError(
      'INVALID_VERIFIED_WAYPOINT_POOL',
      'Verified waypoint pool must be an array.'
    )
  }

  const waypointIndex = new Map()

  for (const waypoint of verifiedWaypointPool) {
    const waypointNode = createVerifiedWaypointNode(waypoint)
    const poiId = waypointNode.poiId

    if (waypointIndex.has(poiId)) {
      throw createCodedError(
        'DUPLICATE_VERIFIED_WAYPOINT',
        `Duplicate verified waypoint: ${poiId}`
      )
    }

    waypointIndex.set(poiId, waypointNode)
  }

  return waypointIndex
}

function validateWaypointOrder(
  orderedWaypointIds,
  waypointIndex
) {
  if (!Array.isArray(orderedWaypointIds)) {
    return {
      valid: false,
      reason: 'WAYPOINT_ORDER_MUST_BE_ARRAY'
    }
  }

  const seenIds = new Set()
  const waypointNodes = []

  for (const rawPoiId of orderedWaypointIds) {
    if (
      typeof rawPoiId !== 'string' ||
      rawPoiId.trim() === ''
    ) {
      return {
        valid: false,
        reason: 'INVALID_WAYPOINT_ID'
      }
    }

    const poiId = rawPoiId.trim()

    if (seenIds.has(poiId)) {
      return {
        valid: false,
        reason: 'DUPLICATE_WAYPOINT_ID',
        poiId
      }
    }

    const waypoint = waypointIndex.get(poiId)

    if (!waypoint) {
      return {
        valid: false,
        reason: 'UNKNOWN_WAYPOINT_ID',
        poiId
      }
    }

    seenIds.add(poiId)
    waypointNodes.push(waypoint)
  }

  return {
    valid: true,
    waypointNodes
  }
}

function validateRouteWaypointScope(
  allowedWaypointIds,
  waypointIndex
) {
  const validation = validateWaypointOrder(
    allowedWaypointIds,
    waypointIndex
  )

  if (!validation.valid) {
    return validation
  }

  return {
    valid: true,
    waypointNodes: validation.waypointNodes,
    allowedWaypointIdSet: new Set(
      validation.waypointNodes.map(
        waypoint => waypoint.poiId
      )
    )
  }
}

function validateRouteOrder(
  orderedWaypointIds,
  waypointIndex,
  allowedWaypointIdSet
) {
  const validation = validateWaypointOrder(
    orderedWaypointIds,
    waypointIndex
  )

  if (!validation.valid) {
    return validation
  }

  for (const waypoint of validation.waypointNodes) {
    if (!allowedWaypointIdSet.has(waypoint.poiId)) {
      return {
        valid: false,
        reason: 'WAYPOINT_NOT_ALLOWED_FOR_ROUTE',
        poiId: waypoint.poiId
      }
    }
  }

  return validation
}

function normalizeRouteSource(source) {
  return (
    typeof source === 'string' &&
    source.trim() !== ''
  )
    ? source.trim()
    : 'unknown'
}

function getNodeId(node) {
  return node.nodeId
}

function createDirectedEdgeKey(fromNode, toNode) {
  return JSON.stringify([
    [
      fromNode.nodeType,
      fromNode.nodeId
    ],
    [
      toNode.nodeType,
      toNode.nodeId
    ]
  ])
}

function buildTraversalNodes(
  startNode,
  waypointNodes,
  routeType
) {
  if (routeType === ROUTE_TYPES.POINT_TO_POINT) {
    return [
      startNode,
      ...waypointNodes
    ]
  }

  if (routeType === ROUTE_TYPES.LOOP) {
    return [
      startNode,
      ...waypointNodes,
      startNode
    ]
  }

  const returnWaypointNodes = waypointNodes
    .slice(0, -1)
    .reverse()

  return [
    startNode,
    ...waypointNodes,
    ...returnWaypointNodes,
    startNode
  ]
}

function buildEdgePairs(nodes) {
  const edgePairs = []

  for (
    let index = 0;
    index < nodes.length - 1;
    index++
  ) {
    edgePairs.push([
      nodes[index],
      nodes[index + 1]
    ])
  }

  return edgePairs
}

function buildPrefetchEdgePairs(
  startNode,
  waypointNodes,
  routeType
) {
  const edgePairs = []

  for (const waypoint of waypointNodes) {
    edgePairs.push([
      startNode,
      waypoint
    ])
  }

  for (const fromWaypoint of waypointNodes) {
    for (const toWaypoint of waypointNodes) {
      if (fromWaypoint.nodeId === toWaypoint.nodeId) {
        continue
      }

      edgePairs.push([
        fromWaypoint,
        toWaypoint
      ])
    }
  }

  if (routeType !== ROUTE_TYPES.POINT_TO_POINT) {
    for (const waypoint of waypointNodes) {
      edgePairs.push([
        waypoint,
        startNode
      ])
    }
  }

  return edgePairs
}

async function mapWithConcurrency(
  items,
  concurrency,
  mapper
) {
  if (items.length === 0) {
    return []
  }

  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const currentIndex = nextIndex

      if (currentIndex >= items.length) {
        return
      }

      nextIndex++

      results[currentIndex] = await mapper(
        items[currentIndex],
        currentIndex
      )
    }
  }

  const workerCount = Math.min(
    concurrency,
    items.length
  )

  await Promise.all(
    Array.from(
      {
        length: workerCount
      },
      () => worker()
    )
  )

  return results
}

function mergeSegmentPolylines(segments) {
  const mergedPolyline = []

  for (const segment of segments) {
    for (
      let index = 0;
      index < segment.polyline.length;
      index++
    ) {
      const point = segment.polyline[index]
      const previousPoint =
        mergedPolyline[mergedPolyline.length - 1]

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

  for (
    const [walkType, distanceMeters]
    of Object.entries(walkTypeDistanceMeters)
  ) {
    if (!isNonNegativeFiniteNumber(distanceMeters)) {
      return null
    }

    copiedWalkTypeDistanceMeters[walkType] = distanceMeters
  }

  return {
    totalStepDistanceMeters,
    analyzedDistanceMeters,
    unknownWalkTypeDistanceMeters,
    normalRoadDistanceMeters,
    normalRoadRatio,
    walkTypeCoverageRatio,
    walkTypeDistanceMeters:
      copiedWalkTypeDistanceMeters
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
    segments.some(
      segment => !segment.environmentStats
    )
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

    aggregate.totalStepDistanceMeters +=
      stats.totalStepDistanceMeters

    aggregate.analyzedDistanceMeters +=
      stats.analyzedDistanceMeters

    aggregate.unknownWalkTypeDistanceMeters +=
      stats.unknownWalkTypeDistanceMeters

    aggregate.normalRoadDistanceMeters +=
      stats.normalRoadDistanceMeters

    for (
      const [walkType, distanceMeters]
      of Object.entries(stats.walkTypeDistanceMeters)
    ) {
      aggregate.walkTypeDistanceMeters[walkType] =
        (
          aggregate.walkTypeDistanceMeters[walkType] || 0
        ) + distanceMeters
    }
  }

  const totalStepDistanceMeters =
    aggregate.totalStepDistanceMeters

  return {
    ...aggregate,

    normalRoadRatio:
      totalStepDistanceMeters > 0
        ? (
            aggregate.normalRoadDistanceMeters /
            totalStepDistanceMeters
          )
        : 0,

    walkTypeCoverageRatio:
      totalStepDistanceMeters > 0
        ? (
            aggregate.analyzedDistanceMeters /
            totalStepDistanceMeters
          )
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

function createRoutePlanningSession({
  start,
  verifiedWaypointPool,
  routeType = ROUTE_TYPES.POINT_TO_POINT,
  segmentResolver = getWalkingSegment
}) {
  if (!isValidGeoPoint(start)) {
    throw createCodedError(
      'INVALID_ROUTE_START',
      'Route start must contain valid coordinates.'
    )
  }

  if (!SUPPORTED_ROUTE_TYPES.has(routeType)) {
    throw createCodedError(
      'INVALID_ROUTE_TYPE',
      `Unsupported route type: ${routeType}`
    )
  }

  if (typeof segmentResolver !== 'function') {
    throw createCodedError(
      'INVALID_SEGMENT_RESOLVER',
      'Segment resolver must be a function.'
    )
  }

  const startNode = createStartNode(start)
  const waypointIndex = createWaypointIndex(
    verifiedWaypointPool
  )

  /*
   * This cache belongs only to this
   * route-planning session.
   *
   * Values are Promises so concurrent
   * requests for the same directed edge
   * share one provider call.
   */
  const segmentCache = new Map()

  function registerVerifiedWaypoints(verifiedWaypoints) {
    if (!Array.isArray(verifiedWaypoints)) {
      throw createCodedError(
        'INVALID_VERIFIED_WAYPOINT_POOL',
        'Verified waypoint pool must be an array.'
      )
    }

    const pendingWaypoints = new Map()
    const registeredWaypointIds = []
    const existingWaypointIds = []

    for (const waypoint of verifiedWaypoints) {
      const waypointNode = createVerifiedWaypointNode(waypoint)
      const poiId = waypointNode.poiId
      const existingWaypoint =
        pendingWaypoints.get(poiId) ||
        waypointIndex.get(poiId)

      if (existingWaypoint) {
        if (
          !areGeoPointsEqual(
            existingWaypoint,
            waypointNode
          )
        ) {
          throw createCodedError(
            'CONFLICTING_VERIFIED_WAYPOINT',
            `Verified waypoint ${poiId} was registered with conflicting coordinates.`
          )
        }

        if (!existingWaypointIds.includes(poiId)) {
          existingWaypointIds.push(poiId)
        }

        continue
      }

      pendingWaypoints.set(poiId, waypointNode)
      registeredWaypointIds.push(poiId)
    }

    for (const [poiId, waypointNode] of pendingWaypoints) {
      waypointIndex.set(poiId, waypointNode)
    }

    return {
      registeredWaypointIds,
      existingWaypointIds,
      totalWaypointCount: waypointIndex.size
    }
  }

  function resolveSegment(fromNode, toNode) {
    const edgeKey = createDirectedEdgeKey(
      fromNode,
      toNode
    )

    if (segmentCache.has(edgeKey)) {
      return segmentCache.get(edgeKey)
    }

    const segmentPromise = Promise.resolve()
      .then(() =>
        segmentResolver(
          {
            ...fromNode
          },
          {
            ...toNode
          }
        )
      )
      .then((result) => {
        if (!result || result.success !== true) {
          return normalizeSegmentFailure(result)
        }

        const normalizedSegment =
          normalizeSuccessfulSegment(result)

        if (!normalizedSegment) {
          return {
            success: false,
            error: 'INVALID_WALKING_SEGMENT_RESPONSE'
          }
        }

        return normalizedSegment
      })
      .catch((error) => ({
        success: false,
        error: 'WALKING_SEGMENT_FAILED',
        causeCode:
          error &&
          typeof error.code === 'string' &&
          error.code.trim() !== ''
            ? error.code.trim()
            : 'SEGMENT_RESOLVER_ERROR'
      }))

    /*
     * Cache before awaiting the Promise.
     * This is what deduplicates requests
     * that arrive while the first provider
     * request is still in flight.
     */
    segmentCache.set(
      edgeKey,
      segmentPromise
    )

    return segmentPromise
  }

  function resolveEdgePairs(edgePairs) {
    return mapWithConcurrency(
      edgePairs,
      SEGMENT_FETCH_CONCURRENCY,
      async ([fromNode, toNode]) => ({
        fromNode,
        toNode,
        segment: await resolveSegment(
          fromNode,
          toNode
        )
      })
    )
  }

  function validateAllowedWaypointIds(
    allowedWaypointIds
  ) {
    const validation = validateRouteWaypointScope(
      allowedWaypointIds,
      waypointIndex
    )

    if (validation.valid) {
      return validation
    }

    return {
      valid: false,
      reason: 'INVALID_ALLOWED_WAYPOINT_SCOPE',
      validationReason: validation.reason,

      ...(validation.poiId
        ? {
            poiId: validation.poiId
          }
        : {})
    }
  }

  async function prefetchSegments(
    allowedWaypointIds
  ) {
    const scopeValidation =
      validateAllowedWaypointIds(
        allowedWaypointIds
      )

    if (!scopeValidation.valid) {
      return {
        prefetched: false,
        reason: scopeValidation.reason,
        validationReason:
          scopeValidation.validationReason,

        ...(scopeValidation.poiId
          ? {
              poiId: scopeValidation.poiId
            }
          : {})
      }
    }

    if (
      scopeValidation.waypointNodes.length >
      EXACT_ORDERING_MAX_WAYPOINTS
    ) {
      return {
        prefetched: false,
        reason:
          'ABOVE_EXACT_ORDERING_THRESHOLD',
        edgeCount: 0,
        failedEdges: []
      }
    }

    const edgePairs = buildPrefetchEdgePairs(
      startNode,
      scopeValidation.waypointNodes,
      routeType
    )

    const resolvedEdges = await resolveEdgePairs(
      edgePairs
    )

    const failedEdges = resolvedEdges
      .filter(
        item => item.segment.success !== true
      )
      .map(item => ({
        from: getNodeId(item.fromNode),
        to: getNodeId(item.toNode),
        error: item.segment.error,

        ...(item.segment.causeCode
          ? {
              causeCode: item.segment.causeCode
            }
          : {})
      }))

    return {
      prefetched: true,
      edgeCount: edgePairs.length,
      failedEdges,
      allEdgesAvailable:
        failedEdges.length === 0
    }
  }

  async function buildRouteForOrder({
    orderedWaypointIds = [],
    allowedWaypointIds,
    source = 'unknown'
  } = {}) {
    const scopeValidation =
      validateAllowedWaypointIds(
        allowedWaypointIds
      )

    if (!scopeValidation.valid) {
      return {
        success: false,
        error: 'INVALID_ROUTE_ORDER',
        reason: scopeValidation.reason,
        validationReason:
          scopeValidation.validationReason,

        ...(scopeValidation.poiId
          ? {
              poiId: scopeValidation.poiId
            }
          : {})
      }
    }

    const validation = validateRouteOrder(
      orderedWaypointIds,
      waypointIndex,
      scopeValidation.allowedWaypointIdSet
    )

    if (!validation.valid) {
      return {
        success: false,
        error: 'INVALID_ROUTE_ORDER',
        reason: validation.reason,

        ...(validation.poiId
          ? {
              poiId: validation.poiId
            }
          : {})
      }
    }

    if (validation.waypointNodes.length === 0) {
      return {
        success: false,
        error: 'NO_ROUTE_SEGMENTS'
      }
    }

    const traversalNodes = buildTraversalNodes(
      startNode,
      validation.waypointNodes,
      routeType
    )

    const edgePairs = buildEdgePairs(
      traversalNodes
    )

    if (edgePairs.length === 0) {
      return {
        success: false,
        error: 'NO_ROUTE_SEGMENTS'
      }
    }

    const resolvedEdges = await resolveEdgePairs(
      edgePairs
    )

    const failedEdge = resolvedEdges.find(
      item => item.segment.success !== true
    )

    if (failedEdge) {
      return {
        success: false,
        error: 'MULTI_SEGMENT_ROUTE_FAILED',

        failedSegment: {
          from: getNodeId(failedEdge.fromNode),
          to: getNodeId(failedEdge.toNode),
          error: failedEdge.segment.error,

          ...(failedEdge.segment.causeCode
            ? {
                causeCode:
                  failedEdge.segment.causeCode
              }
            : {})
        }
      }
    }

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
        polyline: segment.polyline.map(
          copyGeoPoint
        ),

        ...(segment.environmentStats
          ? {
              environmentStats:
                copyEnvironmentStats(
                  segment.environmentStats
                )
            }
          : {})
      })
    )

    const distanceMeters = segments.reduce(
      (total, segment) =>
        total + segment.distanceMeters,
      0
    )

    const durationSeconds = segments.reduce(
      (total, segment) =>
        total + segment.durationSeconds,
      0
    )

    const environmentStats =
      aggregateEnvironmentStats(segments)

    const normalizedSource =
      normalizeRouteSource(source)

    return {
      success: true,
      distanceMeters,
      durationSeconds,
      durationMinutes: Math.ceil(
        durationSeconds / 60
      ),
      polyline: mergeSegmentPolylines(
        segments
      ),
      waypoints: validation.waypointNodes.map(
        copyPublicWaypoint
      ),
      segments,
      routeType,
      returnsToStart:
        routeType !== ROUTE_TYPES.POINT_TO_POINT,

      routeOrder: {
        orderedWaypointIds:
          validation.waypointNodes.map(
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

  return {
    registerVerifiedWaypoints,
    prefetchSegments,
    buildRouteForOrder
  }
}

module.exports = {
  START_NODE_ID,
  createRoutePlanningSession
}