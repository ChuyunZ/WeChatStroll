const POI_SEARCH_RADIUS_METERS = 1000

// POI discovery uses a fixed 1000 m provider radius, independent of duration.
// Route duration is handled later by waypoint selection, Route Engine,
// optimization and final validation. Keep this signature temporarily as a
// narrow policy boundary for existing callers.
function getPoiSearchRadius(durationMinutes) {
  return POI_SEARCH_RADIUS_METERS
}

module.exports = {
  getPoiSearchRadius
}
