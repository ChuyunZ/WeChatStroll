// Tencent walking documentation: webServiceGuide/webServiceRoute#3.
// These are walking facility codes, not AMap walk_type or road_class codes.
const WALKING_FACILITY_TYPES = new Set([0, 1, 2, 3])

function normalizeStreetEvidence(route) {
  if (!Number.isFinite(route.distance) || route.distance <= 0 ||
      !Array.isArray(route.steps) || !route.steps.length) return null
  let total = 0
  let classified = 0
  let ordinary = 0
  for (const step of route.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !Number.isFinite(step.distance) || step.distance < 0) return null
    total += step.distance
    if (WALKING_FACILITY_TYPES.has(step.type)) {
      classified += step.distance
      if (step.type === 0) ordinary += step.distance
    }
  }
  // No undocumented rounding tolerance or missing-distance substitution.
  // Partial step lists are usable only as partial coverage, never extrapolated.
  if (!Number.isFinite(total) || total > route.distance || classified === 0) return null
  return { coverageRatio: classified / route.distance, ordinaryRoadRatio: ordinary / classified }
}

module.exports = { normalizeStreetEvidence }
