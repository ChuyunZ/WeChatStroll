const locationService = require('./location')
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
  nearbyPois
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
        nearbyPois
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
  trigger
}) {
  console.warn(
    '[Route Generation] Falling back:',
    { trigger }
  )

  const selectedPoi = selectCandidatePoi(
    poisByCategory,
    preferences
  )

  if (!selectedPoi) {
    return {
      status: 'empty',
      reason: 'NO_VALID_ROUTE'
    }
  }

  const routeType = getRequestedRouteType(preferences)
  const routePlanningSession = createRoutePlanningSession({
    start: location,
    verifiedWaypointPool: [selectedPoi],
    routeType
  })

  const walkingRoute = await routePlanningSession.buildRouteForOrder({
    allowedWaypointIds: [selectedPoi.poiId],
    orderedWaypointIds: [selectedPoi.poiId],
    source: 'fallback'
  })

  if (!walkingRoute || walkingRoute.success !== true) {
    if (walkingRoute && walkingRoute.error === 'AMAP_RATE_LIMITED') {
      throw createRouteGenerationError(
        'AMAP_RATE_LIMITED',
        'Walking provider is temporarily rate limited.'
      )
    }

    return {
      status: 'empty',
      reason: 'NO_VALID_ROUTE'
    }
  }

  const validation = validateGeneratedWalkingRoute(
    walkingRoute,
    {
      allowedWaypointIds: [selectedPoi.poiId],
      requestedDurationMinutes: preferences.durationMinutes
    }
  )

  if (!validation.valid) {
    return {
      status: 'empty',
      reason: 'NO_VALID_ROUTE'
    }
  }

  const route = buildGeneratedRoute({
    location,
    selectedPoi,
    walkingRoute,
    preferences
  })

  return {
    status: 'success',
    source: 'fallback',
    location,
    routes: [route],
    routePlanningSession,
    waypointCandidateCache: createWaypointCandidateCache([])
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

  let plan

  try {
    plan = await requestWaypointPlan(
      location,
      preferences,
      nearbyPois
    )
  } catch (error) {
    return buildFallbackGenerationResult({
      location,
      poisByCategory,
      preferences,
      trigger: error && error.code
        ? error.code
        : 'AI_ROUTE_PLANNING_FAILED'
    })
  }

  if (
    !plan ||
    !Array.isArray(plan.candidates)
  ) {
    return buildFallbackGenerationResult({
      location,
      poisByCategory,
      preferences,
      trigger: 'INVALID_AI_ROUTE_PLAN'
    })
  }

  if (plan.candidates.length === 0) {
    return buildFallbackGenerationResult({
      location,
      poisByCategory,
      preferences,
      trigger: 'NO_WAYPOINT_CANDIDATES'
    })
  }

  const routeType = getRequestedRouteType(preferences)
  console.log(
    '[Route Generation] Plan received:',
    {
      candidateCount: plan.candidates.length,
      routeType,
      requestedDurationMinutes: preferences.durationMinutes,
      candidates:
        plan.candidates.map(
          (candidate, candidateIndex) => ({
            candidateIndex,
            waypointIds:
              candidate.waypoints.map(
                waypoint => waypoint.poiId
              )
          })
        )
    }
  )

  // Create a session using start point, all nearbyPois and route type
  const candidatePoiIds = new Set(
      plan.candidates.flatMap(
        candidate =>
          candidate.waypoints.map(
            waypoint => waypoint.poiId
          )
      )
    )

  const verifiedWaypointPool = nearbyPois.filter(
      poi =>
        candidatePoiIds.has(poi.poiId)
    )

  const session = createRoutePlanningSession({
      start: location,
      verifiedWaypointPool,
      routeType
    })

  const candidateCache = createWaypointCandidateCache(plan.candidates)

  const routes = []
  let temporaryFailure = false

  const unusedCandidates = candidateCache.getUnusedCandidates()

  for (const [candidateIndex, candidate] of unusedCandidates.entries()) {
    if (routes.length >= 1) {
      break
    }

    const result = await buildOptimizedCandidateRoute({
      session, candidateCache, candidate, location, candidateIndex,
      requestedDurationMinutes: preferences.durationMinutes
    })
    if (result.success) routes.push(result.route)
    if (result.error === 'AMAP_RATE_LIMITED') temporaryFailure = true
  }
  logCandidateSummary(candidateCache)

  if (routes.length === 0) {
    if (temporaryFailure) throw createRouteGenerationError('AMAP_RATE_LIMITED', 'Walking provider is temporarily rate limited.')
    return buildFallbackGenerationResult({
      location,
      poisByCategory,
      preferences,
      trigger: 'NO_VALID_AI_ROUTE'
    })
  }
  
  return {
    status: 'success',
    source: 'ai',
    location,
    routes,

    // 以后如果还要生成新 route 继续用同一个 start / waypoint pool / segment cache
    routePlanningSession: session, 

    // 记住哪些 AI candidate 已经用过 哪些 success / failed / unused
    waypointCandidateCache: candidateCache
  }
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