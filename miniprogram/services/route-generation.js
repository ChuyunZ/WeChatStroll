const locationService = require('./location')

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

function createRouteGenerationError(
  code,
  message,
  originalError = null
) {
  const error = new Error(message)
  error.code = code

  if (originalError) {
    error.originalError = originalError
  }

  return error
}

function isValidPoint(point) {
  return (
    point &&
    typeof point === 'object' &&
    !Array.isArray(point) &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  )
}

function isValidPoi(poi) {
  return (
    poi &&
    typeof poi === 'object' &&
    !Array.isArray(poi) &&
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

async function callCloudFunction(
  name,
  data,
  fallbackCode,
  fallbackMessage
) {
  let response

  try {
    response =
      await wx.cloud.callFunction({
        name,
        data
      })
  } catch (error) {
    throw createRouteGenerationError(
      fallbackCode,
      fallbackMessage,
      error
    )
  }

  const result =
    response && response.result

  if (
    !result ||
    result.success !== true
  ) {
    throw createRouteGenerationError(
      result &&
      result.error &&
      result.error.code
        ? result.error.code
        : fallbackCode,

      result &&
      result.error &&
      result.error.message
        ? result.error.message
        : fallbackMessage
    )
  }

  return result
}

async function searchNearbyPois(location) {
  const result =
    await callCloudFunction(
      'getNearbyPois',
      {
        longitude: location.longitude,
        latitude: location.latitude
      },
      'POI_SEARCH_FAILED',
      'Unable to retrieve nearby places.'
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

function isValidEnvironmentStats(
  environmentStats
) {
  return (
    environmentStats &&
    typeof environmentStats === 'object' &&
    !Array.isArray(environmentStats) &&

    typeof environmentStats.normalRoadRatio
      === 'number' &&

    Number.isFinite(
      environmentStats.normalRoadRatio
    ) &&

    environmentStats.normalRoadRatio >= 0 &&
    environmentStats.normalRoadRatio <= 1 &&

    typeof environmentStats.walkTypeCoverageRatio
      === 'number' &&

    Number.isFinite(
      environmentStats.walkTypeCoverageRatio
    ) &&

    environmentStats.walkTypeCoverageRatio >= 0 &&
    environmentStats.walkTypeCoverageRatio <= 1
  )
}

function isValidWalkingRoute(route) {
  return (
    route &&
    typeof route === 'object' &&
    !Array.isArray(route) &&

    typeof route.distanceMeters === 'number' &&
    Number.isFinite(route.distanceMeters) &&
    route.distanceMeters >= 0 &&

    typeof route.durationMinutes === 'number' &&
    Number.isFinite(route.durationMinutes) &&
    route.durationMinutes >= 0 &&

    Array.isArray(route.polyline) &&
    route.polyline.length >= 2 &&
    route.polyline.every(isValidPoint) &&

    isValidEnvironmentStats(
      route.environmentStats
    )
  )
}

async function requestWalkingRoute(
  start,
  destination
) {
  const result =
    await callCloudFunction(
      'getWalkingRoute',
      {
        start: {
          latitude: start.latitude,
          longitude: start.longitude
        },

        destination: {
          latitude: destination.latitude,
          longitude: destination.longitude
        }
      },
      'WALKING_ROUTE_FAILED',
      'Unable to generate walking route.'
    )

  if (!isValidWalkingRoute(result.route)) {
    throw createRouteGenerationError(
      'INVALID_WALKING_ROUTE',
      'Walking route response has an invalid format.'
    )
  }

  return result.route
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

    routeType:
      'point_to_point',

    returnsToStart:
      false,

    crowdLevel:
      'unknown',

    tags: [
      categoryLabel
    ],

    description:
      `从当前位置步行前往` +
      `${selectedPoi.name}的真实路线。`,

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

    endPoint: {
      name: selectedPoi.name,
      latitude: selectedPoi.latitude,
      longitude: selectedPoi.longitude
    },

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

  const poisByCategory =
    await searchNearbyPois(location)

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

  const walkingRoute =
    await requestWalkingRoute(
      location,
      selectedPoi
    )

  const route =
    buildGeneratedRoute({
      location,
      selectedPoi,
      walkingRoute,
      preferences
    })

  return {
    status: 'success',
    route
  }
}

module.exports = {
  generateFirstRoute,
  selectCandidatePoi,
  selectNearestPoi,
  buildGeneratedRoute
}