// Tencent walking documentation: webServiceGuide/webServiceRoute#3.
// Types 0–3 classify walking facilities, not AMap walk_type or road_class.
// Unclassified step distances remain unknown; never impute ordinary road.
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
  // Preserve strict numeric validation and refuse step totals above route facts.
  // A short/partially classified list yields proportional, conservative evidence.
  if (!Number.isFinite(total) || total > route.distance || classified === 0) return null
  return { coverageRatio: classified / route.distance, ordinaryRoadRatio: ordinary / classified }
}

module.exports = { normalizeStreetEvidence }
