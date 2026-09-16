const {
  isValidGeoPoint,
  areGeoPointsEqual
} = require('../utils/geo')

const {
  createCodedError
} = require('../utils/errors')

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

function registerVerifiedWaypoints(
  waypointIndex,
  verifiedWaypoints
) {
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
      if (!areGeoPointsEqual(existingWaypoint, waypointNode)) {
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

module.exports = {
  createWaypointIndex,
  validateRouteWaypointScope,
  validateRouteOrder,
  registerVerifiedWaypoints
}