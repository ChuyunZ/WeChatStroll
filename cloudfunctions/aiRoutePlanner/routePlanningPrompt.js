const { MAX_AI_PLANNING_ATTEMPTS } = require("./config")
const {
  MIN_WAYPOINTS,
  MAX_WAYPOINTS,
  MIN_ROUTE_CANDIDATES,
  MAX_ROUTE_CANDIDATES
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

const VALID_ENVIRONMENT_PREFERENCES = new Set([
  "公园",
  "水边",
  "街道",
  "商街"
])

function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim() !== ""
  )
}

function isValidPoint(point) {
  return (
    point &&
    typeof point === "object" &&
    !Array.isArray(point) &&
    typeof point.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    point.longitude >= -180 &&
    point.longitude <= 180
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

  if (
    !Number.isFinite(preferences.durationMinutes) ||
    preferences.durationMinutes <= 0 ||
    !VALID_ROUTE_TYPES.has(preferences.routeType) ||
    !VALID_CROWD_PREFERENCES.has(preferences.crowdPreference) ||
    !Array.isArray(preferences.environmentPreferences) ||
    preferences.environmentPreferences.length !==
      VALID_ENVIRONMENT_PREFERENCES.size ||
    !preferences.environmentPreferences.every(
      environment =>
        isNonEmptyString(environment) &&
        VALID_ENVIRONMENT_PREFERENCES.has(
          environment
        )
    ) ||
    new Set(
      preferences.environmentPreferences
    ).size !==
      preferences.environmentPreferences.length
  ) {
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
      (
        poi.distanceInMeters !== null &&
        (
          typeof poi.distanceInMeters !== "number" ||
          !Number.isFinite(poi.distanceInMeters) ||
          poi.distanceInMeters < 0
        )
      )
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

function buildReplanningSection(context, nearbyPois) {
  const manual = context && context.mode === 'manual'
  if (!context || !Number.isInteger(context.attempt) || context.attempt < (manual ? 1 : 2) ||
      context.attempt > MAX_AI_PLANNING_ATTEMPTS || !Array.isArray(context.previousFailures)) return []
  const allowedIds = new Set(nearbyPois.map(poi => poi.poiId))
  const types = new Set(['INVALID_AI_PLAN', 'UNWALKABLE_SEGMENT', 'NO_COMPLETE_ROUTE',
    'DURATION_TOO_SHORT', 'DURATION_TOO_LONG'])
  if (manual) types.add('ROUTE_BUILD_FAILED')
  const previousFailures = []
  const maxPreviousFailures = (MAX_AI_PLANNING_ATTEMPTS + (manual ? 1 : -1)) * MAX_ROUTE_CANDIDATES
  for (const observation of context.previousFailures.slice(0, maxPreviousFailures)) {
    if (!observation || !Number.isInteger(observation.attempt) || observation.attempt < (manual ? 0 : 1) ||
        observation.attempt >= context.attempt || !Array.isArray(observation.waypointIds) ||
        observation.waypointIds.length > MAX_WAYPOINTS ||
        !observation.waypointIds.every(id => allowedIds.has(id)) ||
        !observation.failure || !types.has(observation.failure.type)) continue
    const failure = { type: observation.failure.type }
    for (const key of ['fromPoiId', 'toPoiId']) {
      if (observation.waypointIds.includes(observation.failure[key])) failure[key] = observation.failure[key]
    }
    for (const key of ['actualDurationSeconds', 'targetDurationSeconds']) {
      const value = observation.failure[key]
      if (Number.isFinite(value) && value >= 0) failure[key] = value
    }
    previousFailures.push({ attempt: observation.attempt, waypointIds: [...observation.waypointIds], failure })
  }
  if (manual) {
    // Independent deployment: keep this wire projection aligned with the client
    // helper, without importing mini-program code into the cloud function.
    const excluded = new Map()
    for (const ids of Array.isArray(context.excludedWaypointSets) ? context.excludedWaypointSets : []) {
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_WAYPOINTS ||
          !ids.every(id => typeof id === 'string' && allowedIds.has(id.trim()))) continue
      const normalized = [...new Set(ids.map(id => id.trim()))].sort()
      excluded.set(JSON.stringify(normalized), normalized)
      if (excluded.size === 100) break
    }
    return [
      '', 'MANUAL ALTERNATIVE CONTEXT',
      JSON.stringify({ mode: 'manual', attempt: context.attempt,
        excludedWaypointSets: [...excluded.values()], previousFailures }),
      'MANUAL ALTERNATIVE RULES',
      'The excluded complete POI combinations have already been requested, attempted or displayed; they are not necessarily failures.',
      'Generate new complete combinations from VERIFIED POI CANDIDATES. Partial POI overlap with excluded combinations is allowed.',
      'Different visit orders of the same complete POI set are not new alternatives. Do not repeat excluded combinations.',
      'Only previousFailures describes actual failures. Attempt 0 means cached candidates tried before this manual action requested AI batches.',
      'Never invent POIs, coordinates, routes, distances or durations. The map provider and route engine determine real route facts.'
    ]
  }
  return [
    '', 'PREVIOUS FAILED ATTEMPTS',
    JSON.stringify({ attempt: context.attempt, previousFailures }),
    'REPLANNING RULES',
    'Choose different useful waypoint sets. Do not repeat previously failed sets, even in a different order.',
    'Use only VERIFIED POI CANDIDATES. Do not invent route facts. The optimizer determines visit order.'
  ]
}

// Kept local so aiRoutePlanner remains independently deployable.
const HISTORY_ENVIRONMENTS = ['park', 'water', 'street', 'shoppingStreet']
const HISTORY_LIKED_TAGS = ['nice_view', 'quiet', 'comfortable_route', 'duration_good']
const HISTORY_DISLIKED_TAGS = ['too_crowded', 'too_quiet', 'distance_too_long', 'distance_too_short',
  'duration_too_long', 'duration_too_short', 'route_hard_to_walk', 'pois_not_interesting']

function normalizeHistoricalPreferenceProfile(profile) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
  const tags = (value, allowed) => Array.isArray(value) && value.length <= allowed.length &&
    new Set(value).size === value.length && value.every(tag => allowed.includes(tag))
  if (!object(profile)) return null
  const weights = profile.environmentWeights
  if (!object(weights) || Object.keys(weights).length !== HISTORY_ENVIRONMENTS.length ||
      !HISTORY_ENVIRONMENTS.every(key => Object.prototype.hasOwnProperty.call(weights, key) && bounded(weights[key], 0, 1)) ||
      !(profile.preferredDurationMinutes === null || bounded(profile.preferredDurationMinutes, 15, 120) && profile.preferredDurationMinutes % 5 === 0) ||
      !(profile.crowdPreferenceSignal === null || bounded(profile.crowdPreferenceSignal, -1, 1)) ||
      !tags(profile.likedTags, HISTORY_LIKED_TAGS) || !tags(profile.dislikedTags, HISTORY_DISLIKED_TAGS) ||
      !Number.isInteger(profile.evidenceWalkCount) || !bounded(profile.evidenceWalkCount, 1, 20)) return null
  return {
    environmentWeights: Object.fromEntries(HISTORY_ENVIRONMENTS.map(key => [key, weights[key]])),
    preferredDurationMinutes: profile.preferredDurationMinutes,
    crowdPreferenceSignal: profile.crowdPreferenceSignal,
    likedTags: [...profile.likedTags],
    dislikedTags: [...profile.dislikedTags],
    evidenceWalkCount: profile.evidenceWalkCount
  }
}

function buildRoutePlanningPrompt(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isValidPoint(input.startPoint) ||
    !isValidPreferences(input.preferences) ||
    !isValidNearbyPois(input.nearbyPois)
  ) {
    return {
      success: false,
      error: "INVALID_AI_ROUTE_INPUT"
    }
  }

  const startPoint = {
    latitude: input.startPoint.latitude,
    longitude: input.startPoint.longitude
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
    distanceInMeters: poi.distanceInMeters
  }))

  const history = normalizeHistoricalPreferenceProfile(input.historicalPreferenceProfile)
  const personalization = history ? [
    '', 'PERSONALIZATION PRIORITY',
    'Treat the current questionnaire as the highest-priority intent signal; never use history to contradict it.',
    'Historical preferences may be used as a secondary ranking signal when choosing among waypoint sets that remain consistent with the current questionnaire.',
    'environmentWeights are historical questionnaire-ranking tendencies: a larger value means that environment was ranked more highly more often.',
    'crowdPreferenceSignal ranges from -1 (quieter preference) through 0 (neutral) to +1 (livelier/crowded preference); intermediate values indicate direction and strength.',
    'preferredDurationMinutes is a historical tendency only; do not replace the current requested duration with it.',
    'likedTags and dislikedTags summarize explicit historical feedback. They are preference signals, not verified attributes of any current POI.',
    'evidenceWalkCount is the number of recent terminal walks supporting the profile (1-20). Treat smaller counts as weaker evidence and larger counts as more established history.',
    'Do not override the current route type, crowd preference, or environment ranking with history.',
    'Historical preference signals describe the user, not verified facts about any current POI.',
    'Use a historical signal only when supplied verified candidate data can support the distinction; otherwise do not infer matching POI attributes.',
    'Do not invent POI attributes, crowd facts, walkability, or route geometry from history.',
    '', 'HISTORICAL PREFERENCE PROFILE', 'Secondary soft personalization signal.',
    JSON.stringify(history, null, 2)
  ] : []
  const prompt = [
    "SYSTEM / PLANNING RULES",
    "",
    "You are a walking-route waypoint planner.",
  
    `Generate between ${MIN_ROUTE_CANDIDATES} and ${MAX_ROUTE_CANDIDATES} distinct route candidates.`,
  
    `Each route candidate must contain between ${MIN_WAYPOINTS} and ${MAX_WAYPOINTS} waypoint POIs.`,
  
    "Aim to generate 5 route candidates when the verified POI pool and all planning constraints make this possible.",
  
    "Return fewer candidates if generating 5 valid candidates is not possible.",
  
    "Only select POIs from the VERIFIED POI CANDIDATES supplied below.",
  
    "Never invent new POIs or POI IDs.",
  
    "Within a route candidate, do not select the same POI more than once.",
  
    "Route candidates must be meaningfully different from one another.",
  
    "For every pair of route candidates, neither candidate's POI set may be a subset of or equal to the other candidate's POI set.",
  
    "Two candidates containing the same POI set are invalid even if their waypoint visit order is different.",
  
    "When possible, vary POI selection and environment categories across route candidates while still respecting the user's preferences.",
  
    "For loop routes, do not repeat a waypoint to represent returning to the start; the route engine will handle the return to the starting point.",
  
    "Never invent or modify coordinates.",
  
    "Never invent road names.",
  
    "Never invent walking distances or walking durations.",
  
    "The map provider and the application's route engine are the source of truth for real-world route facts.",
  
    "Use the requested walking duration only as a planning constraint. Do not claim an exact final walking duration.",
  
    "Use the supplied START POINT as the user's actual starting location when selecting waypoint candidates.",
  
    "Prefer candidate POIs that reasonably match the user's normalized preferences.",
  
    "Select waypoint sets only. The route engine determines the final visit order using real directed walking segments.",
    "Do not fill the waypoint limit unnecessarily. Return an empty candidates array when no suitable set is available.",
  
    "",
    "START POINT",
    JSON.stringify(startPoint, null, 2),
  
    "",
    history ? "CURRENT WALK INTENT — Highest priority." : "USER PREFERENCES",
    JSON.stringify(preferences, null, 2),
    ...personalization,
  
    "",
    "VERIFIED POI CANDIDATES",
    JSON.stringify(nearbyPois, null, 2),
    ...buildReplanningSection(input.replanningContext, nearbyPois),
  
    "",
    "EXPECTED OUTPUT FORMAT",
    "",
  
    "Return JSON only.",
  
    "Do not return Markdown, code fences, explanations, coordinates, distances, durations, or road instructions.",
  
    "",
  
    '{"candidates":[{"waypoints":[{"poiId":"verified-poi-id-1"}]},{"waypoints":[{"poiId":"verified-poi-id-2"}]}]}'
  ].join("\n")

  return {
    success: true,
    data: {
      prompt
    }
  }
}

module.exports = {
  normalizeHistoricalPreferenceProfile,
  buildRoutePlanningPrompt
}
