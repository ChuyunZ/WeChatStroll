// Tencent walking documentation: webServiceGuide/webServiceRoute#3.
// These are walking facility codes, not AMap walk_type or road_class codes.
const WALKING_FACILITY_TYPES = new Set([0, 1, 2, 3])

// Conservative, provisional distance-accounting allowance from authorized E2E:
// 8 classified steps missed 4 m; 10 steps missed 5 m.
// The match with 0.5 m/step is consistent with rounding but not proof of its cause.
const MAX_GAP_PER_STEP_METERS = 0.5
const MAX_GAP_RATIO = 0.005
const MAX_GAP_METERS = 10

function normalizeStreetEvidence(route) {
  if (!Number.isFinite(route.distance) || route.distance <= 0 ||
      !Array.isArray(route.steps) || !route.steps.length) return null
  let total = 0
  let classified = 0
  let ordinary = 0
  let everyStepClassified = true
  let integerStepDistances = true
  for (const step of route.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        !Number.isFinite(step.distance) || step.distance < 0) return null
    total += step.distance
    integerStepDistances = integerStepDistances && Number.isInteger(step.distance)
    if (WALKING_FACILITY_TYPES.has(step.type)) {
      classified += step.distance
      if (step.type === 0) ordinary += step.distance
    } else {
      everyStepClassified = false
    }
  }
  if (!Number.isFinite(total) || total > route.distance || classified === 0) return null

  const gap = route.distance - total
  const toleratedGap = Math.min(route.steps.length * MAX_GAP_PER_STEP_METERS,
    route.distance * MAX_GAP_RATIO, MAX_GAP_METERS)
  // Do not invent distance or call the measured coverage 100%.
  // Only integer-meter, wholly classified step lists within *all three*
  // strict caps can explicitly qualify for the small-accounting-gap exception.
  const classificationComplete = everyStepClassified && gap > 0 &&
    Number.isInteger(route.distance) && integerStepDistances && gap <= toleratedGap

  return {
    coverageRatio: classified / route.distance,
    ordinaryRoadRatio: ordinary / classified,
    ...(classificationComplete ? { classificationComplete: true } : {})
  }
}

module.exports = { normalizeStreetEvidence }
