const MIN_WAYPOINTS = 1
const MAX_WAYPOINTS = 3

const MIN_ROUTE_CANDIDATES = 1
const MAX_ROUTE_CANDIDATES = 5

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

function buildAllowedPoiIds(nearbyPois) {
  if (!Array.isArray(nearbyPois)) {
    return null
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
      return null
    }

    allowedPoiIds.add(
      poi.poiId.trim()
    )
  }

  return allowedPoiIds
}

function normalizeCandidate(
  candidate,
  allowedPoiIds
) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null
  }

  const candidateKeys =
    Object.keys(candidate)

  if (
    candidateKeys.length !== 1 ||
    candidateKeys[0] !== "waypoints" ||
    !Array.isArray(candidate.waypoints)
  ) {
    return null
  }

  if (
    candidate.waypoints.length <
      MIN_WAYPOINTS ||
    candidate.waypoints.length >
      MAX_WAYPOINTS
  ) {
    return null
  }

  const seenPoiIds = new Set()
  const normalizedWaypoints = []

  for (
    const waypoint
    of candidate.waypoints
  ) {
    if (
      !waypoint ||
      typeof waypoint !== "object" ||
      Array.isArray(waypoint)
    ) {
      return null
    }

    const waypointKeys =
      Object.keys(waypoint)

    if (
      waypointKeys.length !== 1 ||
      waypointKeys[0] !== "poiId" ||
      typeof waypoint.poiId !== "string" ||
      waypoint.poiId.trim() === ""
    ) {
      return null
    }

    const poiId =
      waypoint.poiId.trim()

    if (
      seenPoiIds.has(poiId) ||
      !allowedPoiIds.has(poiId)
    ) {
      return null
    }

    seenPoiIds.add(poiId)

    normalizedWaypoints.push({
      poiId
    })
  }

  return {
    waypoints: normalizedWaypoints
  }
}

function getWaypointIdSet(candidate) {
  return new Set(
    candidate.waypoints.map(
      waypoint => waypoint.poiId
    )
  )
}

function isSubsetOrEqual(
  leftSet,
  rightSet
) {
  for (const poiId of leftSet) {
    if (!rightSet.has(poiId)) {
      return false
    }
  }

  return true
}

function hasSubsetConflict(
  candidateA,
  candidateB
) {
  const setA =
    getWaypointIdSet(candidateA)

  const setB =
    getWaypointIdSet(candidateB)

  return (
    isSubsetOrEqual(setA, setB) ||
    isSubsetOrEqual(setB, setA)
  )
}

function findCompatibleCombination(
  candidates,
  targetSize,
  startIndex = 0,
  selected = []
) {
  if (
    selected.length === targetSize
  ) {
    return [...selected]
  }

  const remainingNeeded =
    targetSize - selected.length

  for (
    let i = startIndex;
    i <=
      candidates.length -
        remainingNeeded;
    i++
  ) {
    const candidate = candidates[i]

    const hasConflict =
      selected.some(
        selectedCandidate =>
          hasSubsetConflict(
            selectedCandidate,
            candidate
          )
      )

    if (hasConflict) {
      continue
    }

    selected.push(candidate)

    const result =
      findCompatibleCombination(
        candidates,
        targetSize,
        i + 1,
        selected
      )

    if (result) {
      return result
    }

    selected.pop()
  }

  return null
}

function selectLargestCompatibleCandidates(
  candidates
) {
  for (
    let targetSize = candidates.length;
    targetSize >= 1;
    targetSize--
  ) {
    const result =
      findCompatibleCombination(
        candidates,
        targetSize
      )

    if (result) {
      return result
    }
  }

  return []
}

function validateRoutePlan(
  plan,
  nearbyPois
) {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan)
  ) {
    return invalidRoutePlan()
  }

  const planKeys =
    Object.keys(plan)

  if (
    planKeys.length !== 1 ||
    planKeys[0] !== "candidates" ||
    !Array.isArray(plan.candidates)
  ) {
    return invalidRoutePlan()
  }

  if (
    plan.candidates.length <
      MIN_ROUTE_CANDIDATES ||
    plan.candidates.length >
      MAX_ROUTE_CANDIDATES
  ) {
    return invalidRoutePlan()
  }

  const allowedPoiIds =
    buildAllowedPoiIds(nearbyPois)

  if (!allowedPoiIds) {
    return invalidRoutePlan()
  }

  const validCandidates = []

  for (
    const candidate
    of plan.candidates
  ) {
    const normalizedCandidate =
      normalizeCandidate(
        candidate,
        allowedPoiIds
      )

    if (normalizedCandidate) {
      validCandidates.push(
        normalizedCandidate
      )
    }
  }

  if (validCandidates.length === 0) {
    return invalidRoutePlan()
  }

  const selectedCandidates =
    selectLargestCompatibleCandidates(
      validCandidates
    )

  if (
    selectedCandidates.length === 0
  ) {
    return invalidRoutePlan()
  }

  return {
    success: true,
    data: {
      candidates:
        selectedCandidates
    }
  }
}

function invalidRoutePlan() {
  return {
    success: false,
    error: "INVALID_AI_ROUTE_PLAN"
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
  MIN_ROUTE_CANDIDATES,
  MAX_ROUTE_CANDIDATES,
  parseRoutePlan,
  validateRoutePlan,
  parseAndValidateRoutePlan
}