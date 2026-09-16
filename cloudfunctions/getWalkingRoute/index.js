const cloud = require('wx-server-sdk')
const axios = require('axios')

const AMAP_API_KEY = process.env.AMAP_API_KEY
const AMAP_WALKING_URL = 'https://restapi.amap.com/v5/direction/walking'
const NORMAL_ROAD_WALK_TYPE = '0'

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

function isValidPoint(point) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    return false
  }

  const { longitude, latitude } = point

  return (
    typeof longitude === 'number' &&
    typeof latitude === 'number' &&
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  )
}

function parseRouteCount(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error('Invalid AMap route count')

    error.details = {
      rawValue: value,
      receivedType: typeof value
    }

    throw error
  }

  const routeCount = Number(value)

  if (!Number.isInteger(routeCount) || routeCount < 0) {
    const error = new Error('Invalid AMap route count')

    error.details = {
      rawValue: value,
      parsedValue: routeCount
    }

    throw error
  }

  return routeCount
}

function parseNonNegativeNumber(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`Invalid ${fieldName}`)

    error.details = {
      fieldName,
      rawValue: value,
      receivedType: typeof value
    }

    throw error
  }

  const number = Number(value)

  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`Invalid ${fieldName}`)

    error.details = {
      fieldName,
      rawValue: value,
      parsedValue: number
    }

    throw error
  }

  return number
}

function parsePolyline(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    const error = new Error('Walking route steps are missing or empty')

    error.details = {
      receivedType: typeof steps,
      stepCount: Array.isArray(steps) ? steps.length : null
    }

    throw error
  }

  const polyline = []

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      const error = new Error('Walking route contains invalid step')

      error.details = {
        stepIndex,
        receivedType: typeof step,
        isArray: Array.isArray(step)
      }

      throw error
    }

    if (typeof step.polyline !== 'string' || !step.polyline.trim()) {
      const error = new Error('Walking route step is missing polyline')

      error.details = {
        stepIndex,
        receivedType: typeof step.polyline
      }

      throw error
    }

    const points = step.polyline.split(';')

    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex]
      const parts = point.split(',')

      if (parts.length !== 2) {
        const error = new Error(
          'Walking route coordinate has invalid format'
        )

        error.details = {
          stepIndex,
          pointIndex,
          rawPoint: point
        }

        throw error
      }

      const [longitudeText, latitudeText] = parts

      if (
        longitudeText.trim() === '' ||
        latitudeText.trim() === ''
      ) {
        const error = new Error(
          'Walking route coordinate contains empty longitude or latitude'
        )

        error.details = {
          stepIndex,
          pointIndex,
          rawPoint: point
        }

        throw error
      }

      const longitude = Number(longitudeText)
      const latitude = Number(latitudeText)

      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90
      ) {
        const error = new Error(
          'Walking route contains invalid coordinate'
        )

        error.details = {
          stepIndex,
          pointIndex,
          rawPoint: point,
          longitudeText,
          latitudeText
        }

        throw error
      }

      polyline.push({
        latitude,
        longitude
      })
    }
  }

  if (polyline.length < 2) {
    const error = new Error(
      'Walking route polyline contains too few points'
    )

    error.details = {
      pointCount: polyline.length
    }

    throw error
  }

  return polyline
}

function parseEnvironmentStats(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    const error = new Error('Walking route steps are missing or empty')

    error.details = {
      receivedType: typeof steps,
      stepCount: Array.isArray(steps) ? steps.length : null
    }

    throw error
  }

  const walkTypeDistanceMeters = Object.create(null)

  let totalStepDistanceMeters = 0
  let analyzedDistanceMeters = 0
  let unknownWalkTypeDistanceMeters = 0
  let normalRoadDistanceMeters = 0

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      const error = new Error('Walking route contains invalid step')

      error.details = {
        stepIndex,
        receivedType: typeof step,
        isArray: Array.isArray(step)
      }

      throw error
    }

    const stepDistanceMeters = parseNonNegativeNumber(
      step.step_distance,
      `walking route step distance at index ${stepIndex}`
    )

    totalStepDistanceMeters += stepDistanceMeters

    const rawWalkType = step.navi?.walk_type

    const walkType =
      typeof rawWalkType === 'string'
        ? rawWalkType.trim()
        : typeof rawWalkType === 'number' && Number.isFinite(rawWalkType)
          ? String(rawWalkType)
          : ''

    if (!walkType) {
      unknownWalkTypeDistanceMeters += stepDistanceMeters
      continue
    }

    analyzedDistanceMeters += stepDistanceMeters

    walkTypeDistanceMeters[walkType] =
      (walkTypeDistanceMeters[walkType] || 0) + stepDistanceMeters

    if (walkType === NORMAL_ROAD_WALK_TYPE) {
      normalRoadDistanceMeters += stepDistanceMeters
    }
  }

  const normalRoadRatio =
    totalStepDistanceMeters > 0
      ? normalRoadDistanceMeters / totalStepDistanceMeters
      : 0

  const walkTypeCoverageRatio =
    totalStepDistanceMeters > 0
      ? analyzedDistanceMeters / totalStepDistanceMeters
      : 0

  return {
    totalStepDistanceMeters,
    analyzedDistanceMeters,
    unknownWalkTypeDistanceMeters,
    normalRoadDistanceMeters,
    normalRoadRatio,
    walkTypeCoverageRatio,
    walkTypeDistanceMeters
  }
}

exports.main = async (event, context) => {
  if (!AMAP_API_KEY) {
    return {
      success: false,
      error: {
        code: 'CONFIG_MISSING',
        message: 'AMap API key is not configured'
      }
    }
  }

  const { start, destination } = event || {}

  if (!start || !destination) {
    return {
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Missing start or destination'
      }
    }
  }

  if (!isValidPoint(start) || !isValidPoint(destination)) {
    return {
      success: false,
      error: {
        code: 'INVALID_COORDINATES',
        message: 'Invalid start or destination coordinates'
      }
    }
  }

  const origin =
    `${start.longitude.toFixed(6)},${start.latitude.toFixed(6)}`

  const destinationLocation =
    `${destination.longitude.toFixed(6)},${destination.latitude.toFixed(6)}`

  try {
    const response = await axios.get(AMAP_WALKING_URL, {
      params: {
        key: AMAP_API_KEY,
        origin,
        destination: destinationLocation,
        show_fields: 'cost,polyline,navi'
      },
      timeout: 60000
    })

    const data = response.data

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const error = new Error('AMap returned invalid response data')

      error.details = {
        receivedType: typeof data,
        isArray: Array.isArray(data)
      }

      throw error
    }

    if (data.status !== '1') {
      const error = new Error('AMap walking route request failed')

      error.details = {
        status: data.status,
        info: data.info,
        infocode: data.infocode
      }

      throw error
    }

    const routeCount = parseRouteCount(data.count)

    if (routeCount === 0) {
      return {
        success: false,
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: 'No walking route was found'
        }
      }
    }

    const paths = data.route?.paths

    if (!Array.isArray(paths) || paths.length === 0) {
      const error = new Error(
        'AMap reported walking routes but paths are missing or empty'
      )

      error.details = {
        routeCount,
        routeType: typeof data.route,
        pathsType: typeof paths,
        pathCount: Array.isArray(paths) ? paths.length : null
      }

      throw error
    }

    const path = paths[0]

    if (!path || typeof path !== 'object' || Array.isArray(path)) {
      const error = new Error(
        'AMap returned invalid walking route path'
      )

      error.details = {
        routeCount,
        pathIndex: 0,
        receivedType: typeof path,
        isArray: Array.isArray(path)
      }

      throw error
    }

    const distanceMeters = parseNonNegativeNumber(
      path.distance,
      'walking route distance'
    )

    const durationSeconds = parseNonNegativeNumber(
      path.cost?.duration,
      'walking route duration'
    )

    const polyline = parsePolyline(path.steps)

    const environmentStats = parseEnvironmentStats(path.steps)

    return {
      success: true,
      route: {
        distanceMeters,
        durationSeconds,
        polyline,
        environmentStats
      }
    }
  } catch (error) {
    console.error('AMap walking route request failed:', {
      message: error.message,
      details: error.details,
      errorCode: error.code,
      httpStatus: error.response?.status,
      amapInfo: error.details?.info ?? error.response?.data?.info,
      amapInfoCode:
        error.details?.infocode ?? error.response?.data?.infocode
    })

    return {
      success: false,
      error: {
        code: 'WALKING_ROUTE_FAILED',
        message: 'Unable to generate walking route'
      }
    }
  }
}