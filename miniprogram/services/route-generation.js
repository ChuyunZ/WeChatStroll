const locationService = require('./location')
const { waypointSetKey, normalizePlanningFailure, isReplannableFailure } = require('./agentic-route-planning')
const { optimizeWaypointOrder } = require('./waypoint-order-optimizer')

const {
  validateGeneratedWalkingRoute
} = require('./route-validation')

const {
  createCodedError: createRouteGenerationError
} = require('../utils/errors')

const {
  isValidGeoPoint: isValidPoint
} = require('../utils/geo')

const {
  callCloudFunction
} = require('./cloud-function-client')

const {
  createRoutePlanningSession
} = require('./route-engine')

const {
  getPoiSearchRadius
} = require('./poi-search-radius')

const {
  MAX_FALLBACK_CANDIDATES,
  MAX_AI_PLANNING_ATTEMPTS
} = require('../config/route-planning')

const {
  ROUTE_TYPES
} = require('../constants/route-types')

const {
  createWaypointCandidateCache
} = require("./waypoint-candidate-cache");

const POI_ENVIRONMENT_CATEGORY_MAP = {
  '公园': 'park',
  '水边': 'water',
  '商街': 'shoppingStreet'
}

const CATEGORY_LABELS = {
  park: '公园',
  water: '水边',
  shoppingStreet: '商街'
}

function isValidPoi(poi) {
  return (
    poi &&
    typeof poi === 'object' &&
    !Array.isArray(poi) &&
    typeof poi.poiId === 'string' &&
    poi.poiId.trim() !== '' &&
    typeof poi.name === 'string' &&
    poi.name.trim() !== '' &&
    isValidPoint(poi)
  )
}

function getPoiDistance(poi) {
  return Number.isFinite(poi.distanceInMeters)
    ? poi.distanceInMeters
    : Infinity
}

function selectNearestPoi(pois) {
  const validPois = Array.isArray(pois)
    ? pois.filter(isValidPoi)
    : []

  if (validPois.length === 0) {
    return null
  }

  return validPois.reduce((nearest, poi) => {
    return getPoiDistance(poi) < getPoiDistance(nearest)
      ? poi
      : nearest
  })
}

function selectCandidatePoi(
  poisByCategory,
  preferences = {}
) {
  if (
    !poisByCategory ||
    typeof poisByCategory !== 'object' ||
    Array.isArray(poisByCategory)
  ) {
    throw createRouteGenerationError(
      'INVALID_POI_RESPONSE',
      'Nearby POI response has an invalid format.'
    )
  }

  const environmentRanking =
    Array.isArray(preferences.environmentPreferences)
      ? preferences.environmentPreferences
      : []

  for (const environment of environmentRanking) {
    const category =
      POI_ENVIRONMENT_CATEGORY_MAP[environment]

    // “街道”没有对应的 POI category。
    // Week 3 的 route-planning 会通过路线本身的
    // environmentStats 来处理街道偏好。
    if (!category) {
      continue
    }

    const nearestPoi =
      selectNearestPoi(
        poisByCategory[category]
      )

    if (nearestPoi) {
      return nearestPoi
    }
  }

  const allPois =
    Object.values(poisByCategory)
      .filter(Array.isArray)
      .reduce(
        (combined, pois) =>
          combined.concat(pois),
        []
      )

  return selectNearestPoi(allPois)
}

function getFallbackTargetPoiDistance(
  preferences = {}
) {
  if (
    typeof preferences.durationMinutes !== 'number' ||
    !Number.isFinite(preferences.durationMinutes) ||
    preferences.durationMinutes <= 0
  ) {
    return null
  }

  return getPoiSearchRadius(
    preferences.durationMinutes
  )
}

function compareFallbackPoiFit(
  left,
  right,
  targetDistanceMeters
) {
  const leftDistance = getPoiDistance(left)
  const rightDistance = getPoiDistance(right)

  const leftScore =
    targetDistanceMeters === null
      ? leftDistance
      : Math.abs(
          leftDistance -
          targetDistanceMeters
        )

  const rightScore =
    targetDistanceMeters === null
      ? rightDistance
      : Math.abs(
          rightDistance -
          targetDistanceMeters
        )

  if (leftScore !== rightScore) {
    return leftScore < rightScore ? -1 : 1
  }

  if (leftDistance !== rightDistance) {
    return leftDistance < rightDistance ? -1 : 1
  }

  if (left.poiId < right.poiId) return -1
  if (left.poiId > right.poiId) return 1
  return 0
}

function buildFallbackPoiCandidates(
  poisByCategory,
  preferences = {}
) {
  if (
    !poisByCategory ||
    typeof poisByCategory !== 'object' ||
    Array.isArray(poisByCategory)
  ) {
    return []
  }

  const targetDistanceMeters =
    getFallbackTargetPoiDistance(
      preferences
    )

  const environmentRanking =
    Array.isArray(preferences.environmentPreferences)
      ? preferences.environmentPreferences
      : []

  const preferredCategories = []
  const seenCategories = new Set()

  for (const environment of environmentRanking) {
    const category =
      POI_ENVIRONMENT_CATEGORY_MAP[environment]

    if (
      !category ||
      seenCategories.has(category)
    ) {
      continue
    }

    seenCategories.add(category)
    preferredCategories.push(category)
  }

  const candidates = []
  const seenPoiIds = new Set()

  function addCandidate(poi) {
    if (
      !poi ||
      seenPoiIds.has(poi.poiId)
    ) {
      return
    }

    seenPoiIds.add(poi.poiId)
    candidates.push(poi)
  }

  for (const category of preferredCategories) {
    const categoryPois =
      Array.isArray(poisByCategory[category])
        ? poisByCategory[category]
            .filter(isValidPoi)
            .sort(
              (left, right) =>
                compareFallbackPoiFit(
                  left,
                  right,
                  targetDistanceMeters
                )
            )
        : []

    addCandidate(categoryPois[0])

    if (
      candidates.length >=
      MAX_FALLBACK_CANDIDATES
    ) {
      return candidates
    }
  }

  const preferredCategoryRanks = new Map(
    preferredCategories.map(
      (category, index) => [
        category,
        index
      ]
    )
  )

  const allPois =
    Object.values(poisByCategory)
      .filter(Array.isArray)
      .reduce(
        (combined, pois) =>
          combined.concat(pois),
        []
      )
      .filter(isValidPoi)
      .sort((left, right) => {
        const leftRank =
          preferredCategoryRanks.has(left.category)
            ? preferredCategoryRanks.get(left.category)
            : preferredCategories.length

        const rightRank =
          preferredCategoryRanks.has(right.category)
            ? preferredCategoryRanks.get(right.category)
            : preferredCategories.length

        if (leftRank !== rightRank) {
          return leftRank - rightRank
        }

        return compareFallbackPoiFit(
          left,
          right,
          targetDistanceMeters
        )
      })

  for (const poi of allPois) {
    addCandidate(poi)

    if (
      candidates.length >=
      MAX_FALLBACK_CANDIDATES
    ) {
      break
    }
  }

  return candidates
}

async function searchNearbyPois(
  location,
  radius
) {
  const result =
    await callCloudFunction(
      'getNearbyPois',
      {
        longitude: location.longitude,
        latitude: location.latitude,
        radius
      },
      {
        fallbackCode: 'POI_SEARCH_FAILED',
        fallbackMessage:
          'Unable to retrieve nearby places.'
      }
    )

  if (
    !result.poisByCategory ||
    typeof result.poisByCategory !== 'object' ||
    Array.isArray(result.poisByCategory)
  ) {
    throw createRouteGenerationError(
      'INVALID_POI_RESPONSE',
      'Nearby POI response has an invalid format.'
    )
  }

  return result.poisByCategory
}

async function requestWaypointPlan(
  location,
  preferences,
  nearbyPois,
  replanningContext
) {
  const result =
    await callCloudFunction(
      'aiRoutePlanner',
      {
        startPoint: {
          latitude: location.latitude,
          longitude: location.longitude
        },
        preferences,
        nearbyPois,
        ...(replanningContext ? { replanningContext } : {})
      },
      {
        fallbackCode:
          'AI_ROUTE_PLANNING_FAILED',
        fallbackMessage:
          'Unable to generate waypoint plan.'
      }
    )

  return result.plan
}

function hasValidWaypointPlanShape(plan) {
  if (
    !plan ||
    typeof plan !== 'object' ||
    Array.isArray(plan) ||
    !Array.isArray(plan.candidates)
  ) {
    return false
  }

  return plan.candidates.every(
    candidate =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Array.isArray(candidate.waypoints) &&
      candidate.waypoints.length > 0 &&
      candidate.waypoints.every(
        waypoint =>
          waypoint &&
          typeof waypoint === 'object' &&
          !Array.isArray(waypoint) &&
          typeof waypoint.poiId === 'string' &&
          waypoint.poiId.trim() !== ''
      )
  )
}

function buildRecommendationReason(
  selectedPoi,
  preferences = {}
) {
  const ranking =
    Array.isArray(
      preferences.environmentPreferences
    )
      ? preferences.environmentPreferences
      : []

  const categoryLabel =
    CATEGORY_LABELS[selectedPoi.category]

  if (
    categoryLabel &&
    ranking.includes(categoryLabel)
  ) {
    return (
      `根据你的散步环境偏好排序，` +
      `推荐前往${selectedPoi.name}。`
    )
  }

  return (
    `根据附近可用地点，` +
    `推荐前往${selectedPoi.name}。`
  )
}

function buildGeneratedRoute({
  location,
  selectedPoi,
  walkingRoute,
  preferences = {}
}) {
  const categoryLabel =
    CATEGORY_LABELS[selectedPoi.category] ||
    selectedPoi.category ||
    '散步地点'

  const routeType =
    typeof walkingRoute.routeType === 'string' &&
    walkingRoute.routeType.trim() !== ''
      ? walkingRoute.routeType
      : ROUTE_TYPES.POINT_TO_POINT

  const returnsToStart =
    typeof walkingRoute.returnsToStart === 'boolean'
      ? walkingRoute.returnsToStart
      : routeType !== ROUTE_TYPES.POINT_TO_POINT

  const endPoint =
    returnsToStart
      ? {
          name: '当前位置',
          latitude: location.latitude,
          longitude: location.longitude
        }
      : {
          name: selectedPoi.name,
          latitude: selectedPoi.latitude,
          longitude: selectedPoi.longitude
        }

  const description =
    returnsToStart
      ? (
          `从当前位置步行前往` +
          `${selectedPoi.name}并返回起点的真实路线。`
        )
      : (
          `从当前位置步行前往` +
          `${selectedPoi.name}的真实路线。`
        )

  return {
    routeId:
      `generated_` +
      `${selectedPoi.poiId || 'route'}_` +
      `${Date.now()}`,

    title:
      `前往${selectedPoi.name}的散步路线`,

    durationMinutes:
      walkingRoute.durationMinutes,

    distanceMeters:
      walkingRoute.distanceMeters,

    routeType,

    returnsToStart,

    crowdLevel:
      'unknown',

    tags: [
      categoryLabel
    ],

    description,

    recommendationReason:
      buildRecommendationReason(
        selectedPoi,
        preferences
      ),

    startPoint: {
      name: '当前位置',
      latitude: location.latitude,
      longitude: location.longitude
    },

    endPoint,

    polyline:
      walkingRoute.polyline,

    pointsOfInterest: [
      {
        name: selectedPoi.name,

        type:
          selectedPoi.category ||
          'unknown',

        latitude:
          selectedPoi.latitude,

        longitude:
          selectedPoi.longitude
      }
    ],

    updatedAt:
      new Date().toISOString(),

    environmentStats:
      walkingRoute.environmentStats
  }
}

function getRequestedRouteType(
  preferences = {}
) {
  return (
    typeof preferences.routeType === 'string' &&
    preferences.routeType.trim() !== ''
  )
    ? preferences.routeType.trim()
    : ROUTE_TYPES.POINT_TO_POINT
}

function buildPoiCandidates(poisByCategory) {
  const flattenPois = []

  for (const category in poisByCategory) {
    if (!Array.isArray(poisByCategory[category])) {
      continue
    }

    for (const element of poisByCategory[category]) {
      flattenPois.push({
        poiId: element.poiId,
        name: element.name,
        category: element.category,
        latitude: element.latitude,
        longitude: element.longitude,
        distanceInMeters: element.distanceInMeters
      })
    }
  }

  return flattenPois
}

async function generateWaypointPlan(
  preferences = {}
) {
  const location =
    await locationService.getCurrentLocation()

  if (!isValidPoint(location)) {
    throw createRouteGenerationError(
      'INVALID_LOCATION',
      'Current location has an invalid format.'
    )
  }

  const radius =
    getPoiSearchRadius(
      preferences.durationMinutes
    )

  const poisByCategory =
    await searchNearbyPois(location, radius)

  const nearbyPois =
    buildPoiCandidates(poisByCategory)

  if (nearbyPois.length === 0) {
    return {
      status: 'empty',
      reason: 'NO_VALID_POI'
    }
  }

  const plan =
    await requestWaypointPlan(
      location,
      preferences,
      nearbyPois
    )

  return {
    status: 'success',
    plan, // candidates
    nearbyPois,
    location
  }
}

// Convert results from route-engine to UI format 
function buildGeneratedRouteFromAiCandidate({
  location,
  walkingRoute,
  candidateIndex
}) {
  const waypoints =
    Array.isArray(walkingRoute.waypoints)
      ? walkingRoute.waypoints
      : []

  const waypointNames =
    waypoints
      .map(waypoint => waypoint.name)
      .filter(
        name =>
          typeof name === 'string' &&
          name.trim() !== ''
      )

  const waypointText =
    waypointNames.join('、')

  const lastWaypoint =
    waypoints[waypoints.length - 1]

  const returnsToStart =
    walkingRoute.returnsToStart === true

  const endPoint =
    returnsToStart
      ? {
          name: '当前位置',
          latitude: location.latitude,
          longitude: location.longitude
        }
      : {
          name: lastWaypoint.name,
          latitude: lastWaypoint.latitude,
          longitude: lastWaypoint.longitude
        }

  return {
    routeId:
      `generated_ai_${candidateIndex + 1}_${Date.now()}`,

    routeOrder: walkingRoute.routeOrder,
    durationSeconds: walkingRoute.durationSeconds,

    title:
      `途经${waypointText}的散步路线`,

    durationMinutes:
      walkingRoute.durationMinutes,

    distanceMeters:
      walkingRoute.distanceMeters,

    routeType:
      walkingRoute.routeType,

    returnsToStart,

    crowdLevel:
      'unknown',

    tags: [],

    description:
      returnsToStart
        ? `从当前位置出发，途经${waypointText}并返回起点的真实路线。`
        : `从当前位置出发，途经${waypointText}的真实路线。`,

    recommendationReason:
      '根据你的散步偏好推荐这条路线。',

    startPoint: {
      name: '当前位置',
      latitude: location.latitude,
      longitude: location.longitude
    },

    endPoint,

    polyline:
      walkingRoute.polyline,

    pointsOfInterest:
      waypoints.map(
        waypoint => ({
          poiId: waypoint.poiId,
          name: waypoint.name,
          type:
            waypoint.category ||
            'unknown',
          latitude:
            waypoint.latitude,
          longitude:
            waypoint.longitude
        })
      ),

    updatedAt:
      new Date().toISOString(),

    environmentStats:
      walkingRoute.environmentStats
  }
}

// Both initial generation and replacement claim and settle candidates here.
async function buildOptimizedCandidateRoute({
  session, candidateCache, candidate, location, candidateIndex,
  requestedDurationMinutes
}) {
  if (!candidateCache.markBuilding(candidate.candidateId)) {
    return { success: false, error: 'CANDIDATE_NOT_UNUSED' }
  }
  console.log(
    '[Route Generation] Candidate start:',
    {
      candidateId: candidate.candidateId,
      candidateIndex,
      waypointIds: candidate.waypointIds
    }
  )
  let stage = 'optimization'
  try {
    const recommendation = await optimizeWaypointOrder({
      session, waypointIds: candidate.waypointIds, requestedDurationMinutes
    })
    if (!recommendation.success) {
      candidateCache.markFailed(candidate.candidateId)

      console.warn(
        '[Route Generation] Candidate failed:',
        {
          stage: 'optimization',
          candidateId: candidate.candidateId,
          candidateIndex,
          waypointIds: candidate.waypointIds,
          error: recommendation.error,
          reason: recommendation.reason,
          validationReason: recommendation.validationReason,
          failedSegment: recommendation.failedSegment,
          optimization: summarizeOptimization(recommendation.optimization)
        }
      )

      return recommendation
    }
    stage = 'route_build'
    const walkingRoute = await session.buildRouteForOrder({
      allowedWaypointIds: candidate.waypointIds,
      orderedWaypointIds: recommendation.recommendedWaypointIds,
      source: 'optimized'
    })
    if (!walkingRoute || walkingRoute.success !== true) {
      candidateCache.markFailed(candidate.candidateId)
      console.warn(
        '[Route Generation] Candidate failed:',
        {
          stage: 'route_build',
          candidateId: candidate.candidateId,
          candidateIndex,
          waypointIds: candidate.waypointIds,
          recommendedWaypointIds: recommendation.recommendedWaypointIds,
          error: walkingRoute && walkingRoute.error,
          reason: walkingRoute && walkingRoute.reason,
          failedSegment: walkingRoute && walkingRoute.failedSegment,
          optimization: summarizeOptimization(recommendation.optimization)
        }
      )

      return walkingRoute || { success: false, error: 'NO_VALID_ROUTE' }
    }

    stage = 'route_validation'
    const validation = validateGeneratedWalkingRoute(
      walkingRoute,
      {
        allowedWaypointIds: candidate.waypointIds,
        requestedDurationMinutes
      }
    )

    if (!validation.valid) {
      candidateCache.markFailed(candidate.candidateId)

      console.warn(
        '[Route Generation] Candidate failed:',
        {
          stage: 'route_validation',
          candidateId: candidate.candidateId,
          candidateIndex,
          waypointIds: candidate.waypointIds,
          recommendedWaypointIds: recommendation.recommendedWaypointIds,
          error: validation.error,
          reason: validation.reason,
          actualDurationSeconds: validation.actualDurationSeconds,
          targetDurationSeconds: validation.targetDurationSeconds,
          minDurationSeconds: validation.minDurationSeconds,
          maxDurationSeconds: validation.maxDurationSeconds,
          optimization: summarizeOptimization(recommendation.optimization)
        }
      )

      const { valid, ...validationFailure } = validation
      return { success: false, ...validationFailure }
    }

    stage = 'route_format'
    const route = {
      ...buildGeneratedRouteFromAiCandidate({ location, walkingRoute, candidateIndex }),
      candidateWaypointIds: [...candidate.waypointIds],
      recommendedWaypointIds: [...recommendation.recommendedWaypointIds],
      optimization: recommendation.optimization
    }
    candidateCache.markSuccess(candidate.candidateId, route)

    console.log(
      '[Route Generation] Candidate success:',
      {
        candidateId: candidate.candidateId,
        candidateIndex,
        originalWaypointIds: candidate.waypointIds,
        recommendedWaypointIds: recommendation.recommendedWaypointIds,
        strategy: recommendation.optimization.strategy,
        evaluatedOrderCount: recommendation.optimization.evaluatedOrderCount,
        roundEvaluationCounts: recommendation.optimization.roundEvaluationCounts,
        durationSeconds: walkingRoute.durationSeconds,
        distanceMeters: walkingRoute.distanceMeters
      }
    )

    return { success: true, route }
  } catch (error) {
    candidateCache.markFailed(candidate.candidateId)

    console.error(
      '[Route Generation] Candidate exception:',
      {
        stage,
        candidateId: candidate.candidateId,
        candidateIndex,
        waypointIds: candidate.waypointIds,
        code: error && error.code || 'UNEXPECTED_CANDIDATE_ERROR'
      }
    )

    throw error
  }
}

function summarizeOptimization(optimization = {}) {
  return {
    strategy: optimization.strategy,
    evaluatedOrderCount: optimization.evaluatedOrderCount,
    roundEvaluationCounts: optimization.roundEvaluationCounts,
    budgetExhausted: optimization.budgetExhausted
  }
}

function logCandidateSummary(candidateCache) {
  console.log('[Route Generation] Summary:', {
    candidateCount: candidateCache.getAllCandidates().length,
    successfulRouteCount: candidateCache.getSuccessfulRoutes().length,
    candidateStates: candidateCache.getAllCandidates().map(candidate => ({
      candidateId: candidate.candidateId, waypointIds: candidate.waypointIds, status: candidate.status
    }))
  })
}

async function buildFallbackGenerationResult({
  location,
  poisByCategory,
  preferences,
  trigger,
  routePlanningSession = null
}) {
  console.warn(
    '[Route Generation] Falling back:',
    {
      trigger,
      reusedPlanningSession:
        Boolean(routePlanningSession),
      requestedDurationMinutes:
        preferences.durationMinutes
    }
  )

  const fallbackPois =
    buildFallbackPoiCandidates(
      poisByCategory,
      preferences
    )

  const routeType =
    getRequestedRouteType(preferences)

  console.log(
    '[Route Generation] Fallback candidates:',
    {
      routeType,
      targetDistanceMeters:
        getFallbackTargetPoiDistance(
          preferences
        ),
      candidateCount: fallbackPois.length,
      candidates:
        fallbackPois.map(
          (poi, candidateIndex) => ({
            candidateIndex,
            poiId: poi.poiId,
            name: poi.name,
            category: poi.category,
            distanceInMeters:
              poi.distanceInMeters
          })
        )
    }
  )

  if (fallbackPois.length === 0) {
    console.warn(
      '[Route Generation] Fallback exhausted:',
      {
        attemptedCandidates: 0,
        result: 'NO_VALID_ROUTE'
      }
    )

    return {
      status: 'empty',
      reason: 'NO_VALID_ROUTE'
    }
  }

  const fallbackSession =
    routePlanningSession ||
    createRoutePlanningSession({
      start: location,
      verifiedWaypointPool: fallbackPois,
      routeType
    })

  if (routePlanningSession) {
    fallbackSession.registerVerifiedWaypoints(
      fallbackPois
    )
  }

  for (
    const [
      candidateIndex,
      selectedPoi
    ] of fallbackPois.entries()
  ) {
    console.log(
      '[Route Generation] Trying fallback candidate:',
      {
        candidateIndex,
        poiId: selectedPoi.poiId,
        name: selectedPoi.name,
        category: selectedPoi.category,
        distanceInMeters:
          selectedPoi.distanceInMeters
      }
    )

    const walkingRoute =
      await fallbackSession.buildRouteForOrder({
        allowedWaypointIds: [selectedPoi.poiId],
        orderedWaypointIds: [selectedPoi.poiId],
        source: 'fallback'
      })

    if (!walkingRoute || walkingRoute.success !== true) {
      console.warn(
        '[Route Generation] Fallback candidate failed:',
        {
          stage: 'route_build',
          candidateIndex,
          poiId: selectedPoi.poiId,
          error:
            walkingRoute &&
            walkingRoute.error,
          reason:
            walkingRoute &&
            walkingRoute.reason,
          failedSegment:
            walkingRoute &&
            walkingRoute.failedSegment
        }
      )

      if (
        walkingRoute &&
        walkingRoute.error === 'AMAP_RATE_LIMITED'
      ) {
        throw createRouteGenerationError(
          'AMAP_RATE_LIMITED',
          'Walking provider is temporarily rate limited.'
        )
      }

      continue
    }

    const validation =
      validateGeneratedWalkingRoute(
        walkingRoute,
        {
          allowedWaypointIds: [selectedPoi.poiId],
          requestedDurationMinutes:
            preferences.durationMinutes
        }
      )

    if (!validation.valid) {
      console.warn(
        '[Route Generation] Fallback candidate failed:',
        {
          stage: 'route_validation',
          candidateIndex,
          poiId: selectedPoi.poiId,
          error: validation.error,
          reason: validation.reason,
          actualDurationSeconds:
            validation.actualDurationSeconds,
          targetDurationSeconds:
            validation.targetDurationSeconds,
          minDurationSeconds:
            validation.minDurationSeconds,
          maxDurationSeconds:
            validation.maxDurationSeconds
        }
      )

      continue
    }

    const route =
      buildGeneratedRoute({
        location,
        selectedPoi,
        walkingRoute,
        preferences
      })

    console.log(
      '[Route Generation] Fallback succeeded:',
      {
        candidateIndex,
        poiId: selectedPoi.poiId,
        name: selectedPoi.name,
        durationSeconds:
          walkingRoute.durationSeconds,
        distanceMeters:
          walkingRoute.distanceMeters
      }
    )

    return {
      status: 'success',
      source: 'fallback',
      location,
      routes: [route],
      routePlanningSession:
        fallbackSession,
      waypointCandidateCache:
        createWaypointCandidateCache([])
    }
  }

  console.warn(
    '[Route Generation] Fallback exhausted:',
    {
      attemptedCandidates:
        fallbackPois.length,
      result: 'NO_VALID_ROUTE'
    }
  )

  return {
    status: 'empty',
    reason: 'NO_VALID_ROUTE'
  }
}

// AI waypoint candidates -> walking routes
async function generateRoutes(
  preferences = {}
) {
  const location =
    await locationService.getCurrentLocation()

  if (!isValidPoint(location)) {
    throw createRouteGenerationError(
      'INVALID_LOCATION',
      'Current location has an invalid format.'
    )
  }

  const radius =
    getPoiSearchRadius(
      preferences.durationMinutes
    )

  const poisByCategory =
    await searchNearbyPois(location, radius)

  const nearbyPois =
    buildPoiCandidates(poisByCategory)

  if (nearbyPois.length === 0) {
    return {
      status: 'empty',
      reason: 'NO_VALID_POI'
    }
  }

  const session = createRoutePlanningSession({
    start: location,
    verifiedWaypointPool: nearbyPois,
    routeType: getRequestedRouteType(preferences)
  })
  const attemptedWaypointSets = new Set()
  const observations = []
  let attemptCount = 0
  let trigger = 'NO_VALID_AI_ROUTE'

  for (let attempt = 1; attempt <= MAX_AI_PLANNING_ATTEMPTS; attempt++) {
    attemptCount = attempt
    console.log('[Agent Planning] Attempt start:', { attempt, observationCount: observations.length })
    let plan
    let planFailure
    try {
      plan = await requestWaypointPlan(location, preferences, nearbyPois,
        attempt === 1 ? undefined : { attempt, previousFailures: [...observations] })
      if (!hasValidWaypointPlanShape(plan)) planFailure = { error: 'INVALID_AI_ROUTE_PLAN' }
    } catch (error) {
      if (error && error.code === 'AMAP_RATE_LIMITED') throw error
      trigger = error && error.code || 'AI_ROUTE_PLANNING_FAILED'
      planFailure = { error: trigger }
    }

    const attemptObservations = []
    let attemptedCandidates = 0
    let canReplan = true
    if (planFailure) {
      trigger = planFailure.error
      const failure = normalizePlanningFailure(planFailure)
      attemptObservations.push({ attempt, waypointIds: [], failure })
      canReplan = isReplannableFailure(failure)
    } else {
      console.log('[Agent Planning] Plan received:', { attempt, candidateCount: plan.candidates.length })
      const candidateCache = createWaypointCandidateCache(plan.candidates)
      // Settle repeated entries before execution, including alternatives after a success.
      const unseen = []
      const responseSets = new Set()
      for (const [candidateIndex, candidate] of candidateCache.getUnusedCandidates().entries()) {
        const key = waypointSetKey(candidate.waypointIds)
        if (attemptedWaypointSets.has(key) || responseSets.has(key)) {
          candidateCache.markFailed(candidate.candidateId)
          console.log('[Agent Planning] Candidate skipped:', {
            attempt, reason: 'REPEATED_WAYPOINT_SET', waypointIds: candidate.waypointIds
          })
        } else {
          responseSets.add(key)
          unseen.push({ candidateIndex, candidate, key })
        }
      }
      for (const { candidateIndex, candidate, key } of unseen) {
        attemptedWaypointSets.add(key)
        attemptedCandidates++
        const result = await buildOptimizedCandidateRoute({
          session, candidateCache, candidate, location, candidateIndex,
          requestedDurationMinutes: preferences.durationMinutes
        })
        if (result.error === 'AMAP_RATE_LIMITED') {
          throw createRouteGenerationError('AMAP_RATE_LIMITED', 'Walking provider is temporarily rate limited.')
        }
        if (result.success) {
          const source = attempt === 1 ? 'ai' : 'ai-replanned'
          logCandidateSummary(candidateCache)
          console.log('[Agent Planning] Success:', { attempt, source })
          return {
            status: 'success', source, location, routes: [result.route],
            routePlanningSession: session, waypointCandidateCache: candidateCache,
            planningMetadata: { attemptCount, replanned: attemptCount > 1 }
          }
        }
        const failure = normalizePlanningFailure(result, candidate.waypointIds)
        attemptObservations.push({ attempt, waypointIds: [...candidate.waypointIds], failure })
        if (!isReplannableFailure(failure)) canReplan = false
      }
      logCandidateSummary(candidateCache)
      if (attemptedCandidates === 0) {
        trigger = plan.candidates.length ? 'REPEATED_WAYPOINT_SET' : 'NO_WAYPOINT_CANDIDATES'
        canReplan = false
      }
    }
    observations.push(...attemptObservations)
    console.warn('[Agent Planning] Attempt failed:', {
      attempt, attemptedCandidates,
      failureTypes: [...new Set(attemptObservations.map(observation => observation.failure.type))]
    })
    if (!canReplan) break
    if (attempt === MAX_AI_PLANNING_ATTEMPTS) {
      console.warn('[Agent Planning] Attempts exhausted:', { attemptCount })
      break
    }
    console.log('[Agent Planning] Replanning:', { nextAttempt: attempt + 1, observationCount: observations.length })
  }

  const result = await buildFallbackGenerationResult({
    location, poisByCategory, preferences, trigger, routePlanningSession: session
  })
  return result.status === 'success'
    ? { ...result, planningMetadata: { attemptCount, replanned: attemptCount > 1 } }
    : result
}

async function generateFirstRoute(
  preferences = {}
) {
  const location =
    await locationService.getCurrentLocation()

  if (!isValidPoint(location)) {
    throw createRouteGenerationError(
      'INVALID_LOCATION',
      'Current location has an invalid format.'
    )
  }

  const radius =
    getPoiSearchRadius(
      preferences.durationMinutes
    )

  const poisByCategory =
    await searchNearbyPois(
      location,
      radius
    )

  const selectedPoi =
    selectCandidatePoi(
      poisByCategory,
      preferences
    )

  if (!selectedPoi) {
    return {
      status: 'empty',
      reason: 'NO_VALID_POI'
    }
  }

  const routeType =
    getRequestedRouteType(preferences)

  const routePlanningSession =
    createRoutePlanningSession({
      start: location,
      verifiedWaypointPool: [
        selectedPoi
      ],
      routeType
    })

  const walkingRoute =
    await routePlanningSession
      .buildRouteForOrder({
        allowedWaypointIds: [
          selectedPoi.poiId
        ],
        orderedWaypointIds: [
          selectedPoi.poiId
        ],
        source: 'recommended'
      })

  if (!walkingRoute.success) {
    const failedSegment =
      walkingRoute.failedSegment

    if (
      failedSegment &&
      failedSegment.error ===
        'INVALID_WALKING_SEGMENT_RESPONSE'
    ) {
      throw createRouteGenerationError(
        'INVALID_WALKING_ROUTE',
        'Walking route response has an invalid format.'
      )
    }

    throw createRouteGenerationError(
      failedSegment &&
      failedSegment.causeCode
        ? failedSegment.causeCode
        : 'WALKING_ROUTE_FAILED',
      'Unable to generate walking route.'
    )
  }

  const route =
    buildGeneratedRoute({
      location,
      selectedPoi,
      walkingRoute,
      preferences
    })

  return {
    status: 'success',
    route,
    routePlanningSession
  }
}

module.exports = {
  logCandidateSummary,
  generateFirstRoute,
  generateWaypointPlan,
  selectCandidatePoi,
  selectNearestPoi,
  buildGeneratedRoute,
  buildPoiCandidates,
  generateRoutes,
  buildOptimizedCandidateRoute,
  buildGeneratedRouteFromAiCandidate
}