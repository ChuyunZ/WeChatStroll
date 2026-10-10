const MIN_WAYPOINTS = 1
const MAX_WAYPOINTS = 8

const MIN_ROUTE_CANDIDATES = 0
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
  allowedPoiIds,
  removedByReason
) {
  // One primary reason per removed candidate: first failure in validation order.
  const reject = reason => {
    removedByReason[reason]++
    return null
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return reject('malformed_structure')
  }

  const candidateKeys =
    Object.keys(candidate)

  if (
    candidateKeys.length !== 1 ||
    candidateKeys[0] !== "waypoints" ||
    !Array.isArray(candidate.waypoints)
  ) {
    return reject('malformed_structure')
  }

  if (
    candidate.waypoints.length <
      MIN_WAYPOINTS ||
    candidate.waypoints.length >
      MAX_WAYPOINTS
  ) {
    return reject('waypoint_count')
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
      return reject('malformed_structure')
    }

    const waypointKeys =
      Object.keys(waypoint)

    if (
      waypointKeys.length !== 1 ||
      waypointKeys[0] !== "poiId" ||
      typeof waypoint.poiId !== "string" ||
      waypoint.poiId.trim() === ""
    ) {
      return reject('malformed_structure')
    }

    const poiId =
      waypoint.poiId.trim()

    if (seenPoiIds.has(poiId)) return reject('repeated_id')
    if (!allowedPoiIds.has(poiId)) return reject('unverified_poi')

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
  nearbyPois,
  diagnostics = createDiagnostics()
) {
  const rawCandidates = plan && Array.isArray(plan.candidates) ? plan.candidates : null
  diagnostics.rawCandidateCount = rawCandidates ? rawCandidates.length : null
  const rejectPlan = reason => {
    diagnostics.planRejectionReason = reason
    return invalidRoutePlan()
  }
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan)
  ) {
    return rejectPlan('malformed_plan')
  }

  const planKeys =
    Object.keys(plan)

  if (
    planKeys.length !== 1 ||
    planKeys[0] !== "candidates" ||
    !Array.isArray(plan.candidates)
  ) {
    return rejectPlan('malformed_plan')
  }

  if (
    plan.candidates.length <
      MIN_ROUTE_CANDIDATES ||
    plan.candidates.length >
      MAX_ROUTE_CANDIDATES
  ) {
    return rejectPlan('candidate_count')
  }

  const allowedPoiIds =
    buildAllowedPoiIds(nearbyPois)

  if (!allowedPoiIds) {
    return rejectPlan('invalid_poi_pool')
  }

  if (plan.candidates.length === 0) {
    return { success: true, data: { candidates: [] } }
  }

  const validCandidates = []

  for (
    const candidate
    of plan.candidates
  ) {
    const normalizedCandidate =
      normalizeCandidate(
        candidate,
        allowedPoiIds,
        diagnostics.removedByReason
      )

    if (normalizedCandidate) {
      validCandidates.push(
        normalizedCandidate
      )
    }
  }

  diagnostics.structurallyValidCount = validCandidates.length
  diagnostics.structurallyValidMultiPoiCount =
    validCandidates.filter(candidate => candidate.waypoints.length > 1).length
  diagnostics.removedCandidateCount = plan.candidates.length - validCandidates.length

  if (validCandidates.length === 0) {
    return rejectPlan('no_valid_candidates')
  }

  const selectedCandidates =
    selectLargestCompatibleCandidates(
      validCandidates
    )

  if (
    selectedCandidates.length === 0
  ) {
    return rejectPlan('no_compatible_candidates')
  }

  // Keep the original maximum-cardinality search and its input-order tie-break.
  // Classify discarded valid sets against the RETAINED batch. Equality takes
  // precedence; all other conflicts are strict subsets in either direction.
  for (const candidate of validCandidates) {
    if (selectedCandidates.includes(candidate)) continue
    const duplicate = selectedCandidates.some(selected =>
      selected.waypoints.length === candidate.waypoints.length &&
      hasSubsetConflict(selected, candidate))
    diagnostics.removedByReason[duplicate ? 'duplicate_set' : 'subset_conflict']++
  }
  diagnostics.retainedCandidateCount = selectedCandidates.length
  diagnostics.retainedMultiPoiCount =
    selectedCandidates.filter(candidate => candidate.waypoints.length > 1).length
  diagnostics.removedCandidateCount = plan.candidates.length - selectedCandidates.length

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
  return parseAndValidateRoutePlanWithDiagnostics(rawText, nearbyPois).result
}

function createDiagnostics() {
  return {
    schemaVersion: 1,
    rawCandidateCount: null,
    structurallyValidCount: 0,
    structurallyValidMultiPoiCount: 0,
    retainedCandidateCount: 0,
    retainedMultiPoiCount: 0,
    removedCandidateCount: 0,
    planRejectionReason: null,
    removedByReason: {
      malformed_structure: 0,
      waypoint_count: 0,
      unverified_poi: 0,
      repeated_id: 0,
      duplicate_set: 0,
      subset_conflict: 0
    }
  }
}

// Aggregate counts/allowlisted codes only. Never include IDs, coordinates,
// model text, names, indexes mapped to user data, or exception messages.
function parseAndValidateRoutePlanWithDiagnostics(rawText, nearbyPois) {
  const diagnostics = createDiagnostics()
  const parsedResult = parseRoutePlan(rawText)

  if (!parsedResult.success) {
    diagnostics.planRejectionReason = 'invalid_json'
    return { result: parsedResult, diagnostics }
  }

  const result = validateRoutePlan(parsedResult.data, nearbyPois, diagnostics)
  return { result, diagnostics }
}

module.exports = {
  MIN_WAYPOINTS,
  MAX_WAYPOINTS,
  MIN_ROUTE_CANDIDATES,
  MAX_ROUTE_CANDIDATES,
  parseRoutePlan,
  validateRoutePlan,
  parseAndValidateRoutePlan,
  parseAndValidateRoutePlanWithDiagnostics
}
