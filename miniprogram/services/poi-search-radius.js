const DEFAULT_POI_SEARCH_RADIUS_METERS = 1000
const MIN_POI_SEARCH_RADIUS_METERS = 200
const MAX_POI_SEARCH_RADIUS_METERS = 1000

const MIN_WALKING_DURATION_MINUTES = 15
const MAX_WALKING_DURATION_MINUTES = 120

// Approximate normal walking speed: 75 m/min ~= 4.5 km/h.
// Only half of the requested walking-distance budget is used for discovery,
// leaving room for multi-waypoint routing, detours and return travel.
const WALKING_SPEED_METERS_PER_MINUTE = 75
const POI_SEARCH_DISTANCE_RATIO = 0.5

function getPoiSearchRadius(durationMinutes) {
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return DEFAULT_POI_SEARCH_RADIUS_METERS
  }

  const boundedDurationMinutes = Math.min(
    MAX_WALKING_DURATION_MINUTES,
    Math.max(MIN_WALKING_DURATION_MINUTES, durationMinutes)
  )

  const calculatedRadius = Math.round(
    boundedDurationMinutes *
    WALKING_SPEED_METERS_PER_MINUTE *
    POI_SEARCH_DISTANCE_RATIO
  )

  return Math.min(
    MAX_POI_SEARCH_RADIUS_METERS,
    Math.max(MIN_POI_SEARCH_RADIUS_METERS, calculatedRadius)
  )
}

module.exports = {
  getPoiSearchRadius
}
