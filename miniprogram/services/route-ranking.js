// Callers admit only validated, complete walking routes. This service does no I/O.
const { getStreetEvidence } = require('./street-evidence')
// Provisional positive-only coefficient. Coverage scales the bonus instead of
// acting as a threshold: unknown walking distance contributes zero ordinary meters.
const STREET_BONUS_CONFIG = Object.freeze({
  maxBonus: 0.05, rankStrengths: Object.freeze([1, 0.5, 0, 0])
})
const RANKING_CONFIG = Object.freeze({
  weights: Object.freeze({ durationFit: 0.50, currentEnvironmentFit: 0.30, historyFit: 0.20 }),
  rankScores: Object.freeze([1, 0.67, 0.33, 0]),
  categoryLabels: Object.freeze({ park: '公园', water: '水边', shoppingStreet: '商街' }),
  secondsPerMinute: 60
})

const positive = value => Number.isFinite(value) && value > 0
const unitScore = value => Number.isFinite(value) && value >= 0 && value <= 1
const list = value => Array.isArray(value) ? value : []
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

function durationFit(seconds, minutes) {
  if (!positive(seconds) || !positive(minutes)) return null
  const target = minutes * RANKING_CONFIG.secondsPerMinute
  return Math.max(0, 1 - Math.abs(seconds - target) / target)
}

function environmentFit(categories, weights) {
  return mean(categories.map(category => weights[category]).filter(unitScore))
}

function waypointKey(route) {
  const recommended = list(route.recommendedWaypointIds).filter(id => typeof id === 'string' && id.length)
  const ids = recommended.length ? recommended : list(route.pointsOfInterest).map(poi => poi && poi.poiId)
  return JSON.stringify([...new Set(ids.filter(id => typeof id === 'string' && id.length))].sort())
}

const pointKey = point => point ? [point.latitude, point.longitude] : null

// Resolve shared/missing waypoint IDs using stable route facts, never generated
// IDs, timestamps, AI prose or optimizer runtime metadata. Identical facts tie.
function routeFactKey(route) {
  return JSON.stringify([
    route.durationSeconds, route.distanceMeters, route.routeType,
    pointKey(route.startPoint), pointKey(route.endPoint),
    list(route.routeOrder && route.routeOrder.orderedWaypointIds),
    list(route.pointsOfInterest).map(poi => poi && [poi.poiId, poi.category, pointKey(poi)]),
    list(route.polyline).map(pointKey)
  ])
}

function scoreRoute(route, { preferences = {}, historicalPreferenceProfile = null } = {}) {
  const categories = [...new Set(list(route.pointsOfInterest)
    .map(poi => poi && poi.category)
    .filter(category => Object.prototype.hasOwnProperty.call(RANKING_CONFIG.categoryLabels, category)))].sort()
  const currentWeights = {}
  for (const category of categories) {
    const index = list(preferences.environmentPreferences).indexOf(RANKING_CONFIG.categoryLabels[category])
    if (index >= 0 && index < RANKING_CONFIG.rankScores.length) currentWeights[category] = RANKING_CONFIG.rankScores[index]
  }
  const history = historicalPreferenceProfile || {}
  const historyEnvironmentFit = environmentFit(categories, history.environmentWeights || {})
  const historyDurationFit = durationFit(route.durationSeconds, history.preferredDurationMinutes)
  const components = {
    durationFit: durationFit(route.durationSeconds, preferences.durationMinutes),
    currentEnvironmentFit: environmentFit(categories, currentWeights),
    historyFit: mean([historyEnvironmentFit, historyDurationFit].filter(unitScore)),
    historyEnvironmentFit,
    historyDurationFit
  }
  const available = Object.keys(RANKING_CONFIG.weights).filter(key => components[key] !== null)
  const weightSum = available.reduce((sum, key) => sum + RANKING_CONFIG.weights[key], 0)
  const effectiveWeights = {}
  for (const key of available) effectiveWeights[key] = RANKING_CONFIG.weights[key] / weightSum
  const baseScore = weightSum ? available.reduce((sum, key) => sum + components[key] * effectiveWeights[key], 0) : null
  const streetEvidence = getStreetEvidence(route)
  const streetRank = list(preferences.environmentPreferences).indexOf('街道')
  const strength = STREET_BONUS_CONFIG.rankStrengths[streetRank] || 0
  const streetBonus = baseScore !== null && streetEvidence
    ? STREET_BONUS_CONFIG.maxBonus * strength * streetEvidence.coverageRatio * streetEvidence.ordinaryRoadRatio : 0
  return {
    totalScore: baseScore === null ? null : baseScore + streetBonus,
    baseScore,
    streetBonus,
    streetEvidence,
    components,
    effectiveWeights,
    tieBreak: {
      durationErrorSeconds: positive(route.durationSeconds) && positive(preferences.durationMinutes)
        ? Math.abs(route.durationSeconds - preferences.durationMinutes * RANKING_CONFIG.secondsPerMinute) : null,
      canonicalWaypointKey: waypointKey(route),
      canonicalRouteFactKey: routeFactKey(route)
    }
  }
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0
// Unavailable components sort after available ones only when prior scores tie.
const descending = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a

function compareScores(a, b) {
  let comparison = descending(a.totalScore, b.totalScore)
  for (const key of ['durationFit', 'currentEnvironmentFit', 'historyFit']) {
    comparison = comparison || descending(a.components[key], b.components[key])
  }
  const errorA = a.tieBreak.durationErrorSeconds
  const errorB = b.tieBreak.durationErrorSeconds
  return comparison || descending(errorA === null ? null : -errorA, errorB === null ? null : -errorB) ||
    compareText(a.tieBreak.canonicalWaypointKey, b.tieBreak.canonicalWaypointKey) ||
    compareText(a.tieBreak.canonicalRouteFactKey, b.tieBreak.canonicalRouteFactKey)
}

function rankRoutes(routes, context) {
  return routes.map(route => ({ route, score: scoreRoute(route, context) }))
    .sort((a, b) => compareScores(a.score, b.score)).map(entry => entry.route)
}

module.exports = { RANKING_CONFIG, STREET_BONUS_CONFIG, scoreRoute, rankRoutes }
