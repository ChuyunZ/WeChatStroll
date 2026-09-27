const { isValidGeoPoint } = require('../utils/geo')
const { createCodedError } = require('../utils/errors')
const { getWalkingSegment } = require('./walking-segment')

const {
  EXACT_ORDERING_MAX_WAYPOINTS,
  SEGMENT_FETCH_CONCURRENCY
} = require('../config/route-planning')

const { ROUTE_TYPES } = require('../constants/route-types')

const {
  createWaypointIndex,
  validateRouteWaypointScope,
  validateRouteOrder,
  registerVerifiedWaypoints: registerWaypoints
} = require('./waypoint-registry')

const {
  START_NODE_ID,
  createStartNode,
  getNodeId,
  createDirectedEdgeKey,
  buildTraversalNodes,
  buildEdgePairs,
  buildPrefetchEdgePairs
} = require('./route-graph')

const {
  normalizeSuccessfulSegment,
  normalizeSegmentFailure,
  buildSuccessfulRouteResult
} = require('./route-result')

const SUPPORTED_ROUTE_TYPES = new Set(
  Object.values(ROUTE_TYPES)
)

async function mapWithConcurrency(items, concurrency, mapper) {
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
      { length: workerCount },
      () => worker()
    )
  )

  return results
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
  const waypointIndex = createWaypointIndex(verifiedWaypointPool)

  /*
   * Cache lifetime = planning-session lifetime.
   *
   * Values are Promises rather than resolved values so concurrent
   * requests for the same directed edge share the same provider call.
   */
  const segmentCache = new Map()

  function registerVerifiedWaypoints(verifiedWaypoints) {
    return registerWaypoints(
      waypointIndex,
      verifiedWaypoints
    )
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
          { ...fromNode },
          { ...toNode }
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
     * Cache before awaiting.
     *
     * This is what deduplicates two requests that ask for the same
     * directed edge while the first provider request is still running.
     */
    segmentCache.set(edgeKey, segmentPromise)

    return segmentPromise
  }

  function resolveEdgePairs(edgePairs) {
    return mapWithConcurrency(
      edgePairs,
      SEGMENT_FETCH_CONCURRENCY,
      async ([fromNode, toNode]) => ({
        fromNode,
        toNode,
        segment: await resolveSegment(fromNode, toNode)
      })
    )
  }

  function validateAllowedWaypointIds(allowedWaypointIds) {
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

  async function prefetchSegments(allowedWaypointIds) {
    const scopeValidation =
      validateAllowedWaypointIds(allowedWaypointIds)

    if (!scopeValidation.valid) {
      return {
        prefetched: false,
        reason: scopeValidation.reason,
        validationReason: scopeValidation.validationReason,

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
        reason: 'ABOVE_EXACT_ORDERING_THRESHOLD',
        edgeCount: 0,
        failedEdges: []
      }
    }

    const edgePairs = buildPrefetchEdgePairs(
      startNode,
      scopeValidation.waypointNodes,
      routeType
    )

    const resolvedEdges = await resolveEdgePairs(edgePairs)

    const failedEdges = resolvedEdges
      .filter(({ segment }) => segment.success !== true)
      .map(({ fromNode, toNode, segment }) => ({
        from: getNodeId(fromNode),
        to: getNodeId(toNode),
        error: segment.error,

        ...(segment.causeCode
          ? {
              causeCode: segment.causeCode
            }
          : {})
      }))

    return {
      prefetched: true,
      edgeCount: edgePairs.length,
      failedEdges,
      allEdgesAvailable: failedEdges.length === 0
    }
  }

  // Both evaluation and rendering resolve the same validated traversal.
  async function resolveRouteOrder({
    orderedWaypointIds = [],
    allowedWaypointIds,
    source = 'unknown'
  } = {}) {
    const scopeValidation =
      validateAllowedWaypointIds(allowedWaypointIds)

    if (!scopeValidation.valid) {
      return {
        success: false,
        error: 'INVALID_ROUTE_ORDER',
        reason: scopeValidation.reason,
        validationReason: scopeValidation.validationReason,

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

    const edgePairs = buildEdgePairs(traversalNodes)

    if (edgePairs.length === 0) {
      return {
        success: false,
        error: 'NO_ROUTE_SEGMENTS'
      }
    }

    const resolvedEdges = await resolveEdgePairs(edgePairs)

    const failedEdge = resolvedEdges.find(
      ({ segment }) => segment.success !== true
    )

    if (failedEdge) {
      const {
        fromNode,
        toNode,
        segment
      } = failedEdge

      return {
        success: false,
        error: 'MULTI_SEGMENT_ROUTE_FAILED',

        failedSegment: {
          from: getNodeId(fromNode),
          to: getNodeId(toNode),
          error: segment.error,

          ...(segment.causeCode
            ? {
                causeCode: segment.causeCode
              }
            : {})
        }
      }
    }

    return {
      success: true,
      waypointNodes: validation.waypointNodes,
      resolvedEdges,
      routeType,
      source
    }
  }

  async function evaluateRouteOrder(options) {
    const result = await resolveRouteOrder(options)
    if (!result.success) return result

    return {
      success: true,
      durationSeconds: result.resolvedEdges.reduce(
        (total, edge) => total + edge.segment.durationSeconds, 0
      ),
      distanceMeters: result.resolvedEdges.reduce(
        (total, edge) => total + edge.segment.distanceMeters, 0
      )
    }
  }

  async function buildRouteForOrder(options) {
    const result = await resolveRouteOrder(options)
    return result.success ? buildSuccessfulRouteResult(result) : result
  }

  // Copies expose only the trusted coordinates needed to seed the search.
  function getWaypointSearchData(allowedWaypointIds) {
    const validation = validateAllowedWaypointIds(allowedWaypointIds)
    if (!validation.valid) return validation
    return {
      valid: true,
      start: { latitude: startNode.latitude, longitude: startNode.longitude },
      waypoints: validation.waypointNodes.map(node => ({
        poiId: node.poiId,
        latitude: node.latitude,
        longitude: node.longitude
      }))
    }
  }

  return {
    registerVerifiedWaypoints,
    prefetchSegments,
    evaluateRouteOrder,
    getWaypointSearchData,
    buildRouteForOrder
  }
}

module.exports = {
  START_NODE_ID,
  createRoutePlanningSession
}
