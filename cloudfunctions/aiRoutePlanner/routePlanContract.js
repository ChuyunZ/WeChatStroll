const MIN_WAYPOINTS = 1
const MAX_WAYPOINTS = 3

function parseRoutePlan(rawText) {
  if (
    typeof rawText !== "string" ||
    rawText.trim() === ""
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    }
  }

  try {
    const plan = JSON.parse(rawText)

    return {
      success: true,
      data: plan
    }
  } catch (error) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    }
  }
}

function validateRoutePlan(plan, nearbyPois) {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    !Array.isArray(plan.waypoints) ||
    !Array.isArray(nearbyPois)
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    }
  }


  const planKeys = Object.keys(plan)

  if (
    planKeys.length !== 1 ||
    planKeys[0] !== "waypoints"
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    }
  }

  if (
    plan.waypoints.length < MIN_WAYPOINTS ||
    plan.waypoints.length > MAX_WAYPOINTS
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_PLAN"
    }
  }

  const allowedPoiIds = new Set()

  for (const poi of nearbyPois) {
    if (
      !poi ||
      typeof poi !== "object" ||
      Array.isArray(poi) ||
      typeof poi.poiId !== "string" ||
      poi.poiId.trim() === ""
    ) {
      return {
        success: false,
        error: "INVALID_AI_ROUTE_PLAN"
      }
    }

    allowedPoiIds.add(poi.poiId.trim())
  }

  const seenPoiIds = new Set()
  const normalizedWaypoints = []

  for (const waypoint of plan.waypoints) {
    if (
      !waypoint ||
      typeof waypoint !== "object" ||
      Array.isArray(waypoint)
    ) {
      return {
        success: false,
        error: "INVALID_AI_ROUTE_PLAN"
      }
    }

    const waypointKeys = Object.keys(waypoint)

    if (
      waypointKeys.length !== 1 ||
      waypointKeys[0] !== "poiId" ||
      typeof waypoint.poiId !== "string" ||
      waypoint.poiId.trim() === ""
    ) {
      return {
        success: false,
        error: "INVALID_AI_ROUTE_PLAN"
      }
    }

    const poiId = waypoint.poiId.trim()

    if (
      seenPoiIds.has(poiId) ||
      !allowedPoiIds.has(poiId)
    ) {
      return {
        success: false,
        error: "INVALID_AI_ROUTE_PLAN"
      }
    }

    seenPoiIds.add(poiId)

    normalizedWaypoints.push({
      poiId
    })
  }

  return {
    success: true,
    data: {
      waypoints: normalizedWaypoints
    }
  }
}

function parseAndValidateRoutePlan(rawText, nearbyPois) {
  const parsedResult = parseRoutePlan(rawText)

  if (!parsedResult.success) {
    return parsedResult
  }

  return validateRoutePlan(parsedResult.data, nearbyPois)
}

module.exports = {
  MIN_WAYPOINTS,
  MAX_WAYPOINTS,
  parseRoutePlan,
  validateRoutePlan,
  parseAndValidateRoutePlan
}