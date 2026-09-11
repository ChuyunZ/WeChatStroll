const {
  MIN_WAYPOINTS,
  MAX_WAYPOINTS
} = require("./routePlanContract")

const VALID_ROUTE_TYPES = new Set([
  "loop",
  "out_and_back",
  "point_to_point"
])

const VALID_CROWD_PREFERENCES = new Set([
  "low",
  "medium",
  "high"
])

function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim() !== ""
  )
}

function isValidPreferences(preferences) {
  if (
    !preferences ||
    typeof preferences !== "object" ||
    Array.isArray(preferences)
  ) {
    return false
  }

  if (!Number.isFinite(preferences.durationMinutes) || preferences.durationMinutes <= 0 || !VALID_ROUTE_TYPES.has(preferences.routeType) || !VALID_CROWD_PREFERENCES.has(preferences.crowdPreference) || !Array.isArray(preferences.environmentPreferences) || preferences.environmentPreferences.length !== 4 || !preferences.environmentPreferences.every(isNonEmptyString)) {
    return false
  }

  return true
}

function isValidNearbyPois(nearbyPois) {
  if (
    !Array.isArray(nearbyPois) ||
    nearbyPois.length === 0
  ) {
    return false
  }

  const seenPoiIds = new Set()

  for (const poi of nearbyPois) {
    if (
      !poi ||
      typeof poi !== "object" ||
      Array.isArray(poi) ||
      !isNonEmptyString(poi.poiId) ||
      !isNonEmptyString(poi.name) ||
      !isNonEmptyString(poi.category) ||
      typeof poi.latitude !== "number" ||
      !Number.isFinite(poi.latitude) ||
      poi.latitude < -90 ||
      poi.latitude > 90 ||
      typeof poi.longitude !== "number" ||
      !Number.isFinite(poi.longitude) ||
      poi.longitude < -180 ||
      poi.longitude > 180 ||
      typeof poi.distanceMeters !== "number" ||
      !Number.isFinite(poi.distanceMeters) ||
      poi.distanceMeters < 0
    ) {
      return false
    }

    const poiId = poi.poiId.trim()

    if (seenPoiIds.has(poiId)) {
      return false
    }

    seenPoiIds.add(poiId)
  }

  return true
}

function buildRoutePlanningPrompt(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isValidPreferences(input.preferences) ||
    !isValidNearbyPois(input.nearbyPois)
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    }
  }

  const preferences = {
    durationMinutes:
      input.preferences.durationMinutes,

    routeType:
      input.preferences.routeType,

    crowdPreference:
      input.preferences.crowdPreference,

    environmentPreferences:
      [...input.preferences.environmentPreferences]
  }

  const nearbyPois = input.nearbyPois.map(poi => ({
    poiId: poi.poiId.trim(),
    name: poi.name,
    category: poi.category,
    latitude: poi.latitude,
    longitude: poi.longitude,
    distanceMeters: poi.distanceMeters
  }))

  const prompt = [
    "SYSTEM / PLANNING RULES",
    "",
    "You are a walking-route waypoint planner.",
    `Select between ${MIN_WAYPOINTS} and ${MAX_WAYPOINTS} waypoint POIs.`,
    "Only select POIs from the VERIFIED POI CANDIDATES supplied below.",
    "Do not select the same POI more than once.",
    "For loop routes, do not repeat a waypoint to represent returning to the start; the route engine will handle the return to the starting point.",
    "Never invent new POIs or POI IDs.",
    "Never invent or modify coordinates.",
    "Never invent road names.",
    "Never invent walking distances or walking durations.",
    "AMap and the application's route engine are the source of truth for real-world route facts.",
    "Use the requested walking duration only as a planning constraint. Do not claim an exact final walking duration.",
    "Prefer candidate POIs that reasonably match the user's normalized preferences.",
    "Return waypoint IDs in the order they should be visited.",
    "",
    "USER PREFERENCES",
    JSON.stringify(preferences, null, 2),
    "",
    "VERIFIED POI CANDIDATES",
    JSON.stringify(nearbyPois, null, 2),
    "",
    "EXPECTED OUTPUT FORMAT",
    "",
    "Return JSON only.",
    "Do not return Markdown, code fences, explanations, coordinates, distances, durations, or road instructions.",
    "",
    '{"waypoints":[{"poiId":"verified-poi-id"}]}'
  ].join("\n")

  return {
    success: true,
    data: {
      prompt
    }
  }
}

module.exports = {
  buildRoutePlanningPrompt
}