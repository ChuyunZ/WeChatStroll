const locationService = require('./location')

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
      : 'point_to_point'

  const returnsToStart =
    typeof walkingRoute.returnsToStart === 'boolean'
      ? walkingRoute.returnsToStart
      : routeType !== 'point_to_point'

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
    : 'point_to_point'
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
  generateFirstRoute,
  selectCandidatePoi,
  selectNearestPoi,
  buildGeneratedRoute
}