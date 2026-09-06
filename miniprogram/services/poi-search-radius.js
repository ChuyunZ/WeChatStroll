const DEFAULT_POI_SEARCH_RADIUS_METERS = 3000
const MIN_POI_SEARCH_RADIUS_METERS = 200
const MAX_POI_SEARCH_RADIUS_METERS = 15000

// Approximate normal walking speed:
// 75 meters per minute ≈ 4.5 km/h.
const WALKING_SPEED_METERS_PER_MINUTE = 75

// The POI search radius uses only part of the user's
// total walking-distance budget.
//
// This leaves room for waypoint combinations,
// route shape, detours, and return travel.
const POI_SEARCH_DISTANCE_RATIO = 0.5

function getPoiSearchRadius(durationMinutes) {
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return DEFAULT_POI_SEARCH_RADIUS_METERS
  }

  const calculatedRadius =
    Math.round(
      durationMinutes *
      WALKING_SPEED_METERS_PER_MINUTE *
      POI_SEARCH_DISTANCE_RATIO
    )

  return Math.min(
    MAX_POI_SEARCH_RADIUS_METERS,
    Math.max(
      MIN_POI_SEARCH_RADIUS_METERS,
      calculatedRadius
    )
  )
}

module.exports = {
  getPoiSearchRadius
}