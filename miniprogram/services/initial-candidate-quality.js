// Geometry-only prioritization for the FIRST AI candidate batch (#91).
// No walking-provider calls or trusted route facts are created here.
// Preserve the cloud contract: distinct POI sets, no subset relationships.
const { createSessionDurationEstimator } = require('./route-correction-estimator')
const { getAllowedDurationRange } = require('./route-validation')
const { waypointSetKey } = require('./agentic-route-planning')
const { ROUTE_TYPES } = require('../constants/route-types')
const {
  INITIAL_MAX_CANDIDATES,
  INITIAL_MAX_SUPPLEMENTAL_PAIRS,
  INITIAL_POOL_POI_LIMIT,
  INITIAL_PAIR_MIN_SCORE_GAIN
} = require('../config/route-planning')

const PREFERENCE_CATEGORY = { '公园': 'park', '水边': 'water', '商街': 'shoppingStreet' }
const MAX_PAIR_VARIANTS = 2

function conflictsBySubset(first, second) {
  const a = new Set(first)
  const b = new Set(second)
  return first.every(id => b.has(id)) || second.every(id => a.has(id))
}

function poiPriority(poi, preferences = {}) {
  const order = (preferences.environmentPreferences || [])
    .map(name => PREFERENCE_CATEGORY[name]).filter(Boolean)
  const preferenceIndex = order.indexOf(poi.category)
  // Geometry predicts duration; this only avoids displacing the AI with
  // unrelated verified POIs when the user asked for a specific environment.
  const categoryCost = preferenceIndex < 0 ? 0.09 : preferenceIndex * 0.02
  return categoryCost
}

function estimateCandidate(ids, estimator, routeType, range) {
  const orders = [ids]
  if (ids.length === MAX_PAIR_VARIANTS) orders.push([...ids].reverse())
  let best = null
  for (const order of orders) {
    const result = estimator.estimate(
      order, routeType, range.targetSeconds, range.minSeconds, range.maxSeconds
    )
    if (result.failedEdges > 0) continue
    const windowGap = result.durationSeconds < range.minSeconds
      ? range.minSeconds - result.durationSeconds
      : result.durationSeconds > range.maxSeconds
        ? result.durationSeconds - range.maxSeconds : 0
    // Broad estimates are NOT used for rejection. Favor a likely duration fit,
    // with a small charge for uncertainty and extra route-builder edges.
    const score =
      (result.tier === 0 ? 0 : result.tier === 1 ? 0 : result.tier === 2 ? 0.30 : 0.65) +
      windowGap / range.targetSeconds * 0.8 +
      Math.abs(result.durationSeconds - range.targetSeconds) / range.targetSeconds * 0.09 +
      (result.highSeconds - result.lowSeconds) / range.targetSeconds * 0.02 +
      Math.max(0, ids.length - 1) * 0.055
    if (!best || score < best.score) {
      best = { score, estimatedSeconds: result.durationSeconds, tier: result.tier }
    }
  }
  return best
}

function rankInitialCandidates({ candidates, verifiedWaypointPool, location, preferences }) {
  const unchanged = () => ({
    candidates, origins: (Array.isArray(candidates) ? candidates : []).map(() => 'ai'),
    applied: false, supplementalPairCount: 0
  })
  if (!Array.isArray(candidates) || !candidates.length ||
      !Array.isArray(verifiedWaypointPool) || !location ||
      !Number.isFinite(preferences && preferences.durationMinutes) ||
      ![ROUTE_TYPES.OUT_AND_BACK, ROUTE_TYPES.LOOP, ROUTE_TYPES.POINT_TO_POINT].includes(preferences.routeType)) {
    return unchanged()
  }
  // Limit this first rollout to the observed failure mode: AI supplies
  // predominantly single-POI candidates for a duration-constrained walk.
  // Preserve existing well-formed multi-POI batches and manual replenishment.
  const singletonCount = candidates.filter(item =>
    item && Array.isArray(item.waypoints) && item.waypoints.length === 1).length
  if (candidates.length < 3 || singletonCount < 3 ||
      candidates.length > INITIAL_MAX_CANDIDATES) return unchanged()

  const allPois = new Map()
  for (const poi of verifiedWaypointPool) {
    if (poi && typeof poi.poiId === 'string' && poi.poiId &&
        Number.isFinite(poi.latitude) && Number.isFinite(poi.longitude) &&
        !allPois.has(poi.poiId)) allPois.set(poi.poiId, poi)
  }
  if (!allPois.size || !candidates.every(candidate =>
    candidate && Array.isArray(candidate.waypoints) &&
    candidate.waypoints.length > 0 &&
    candidate.waypoints.every(point => point && allPois.has(point.poiId)))) return unchanged()

  const range = getAllowedDurationRange(preferences.durationMinutes)
  if (!range.valid || !range.constrained) return unchanged()
  const routeType = preferences.routeType
  // No segment request. On the initial invocation, this is geometry-only.
  const estimator = createSessionDurationEstimator({
    searchData: { start: location, waypoints: [...allPois.values()] },
    cachedCosts: []
  })

  let entries = candidates.map((candidate, index) => {
    const ids = candidate.waypoints.map(point => point.poiId)
    const estimate = estimateCandidate(ids, estimator, routeType, range)
    return {
      candidate, ids, origin: 'ai', index, key: waypointSetKey(ids),
      score: estimate ? estimate.score : Infinity
    }
  })

  // If input candidates violate subset uniqueness, do not silently replace
  // cloud-provider validation. Preserve their existing behavior.
  if (entries.some((entry, i) => entries.slice(i + 1)
    .some(other => conflictsBySubset(entry.ids, other.ids)))) return unchanged()

  const rankedPois = [...allPois.values()]
    .sort((a, b) =>
      poiPriority(a, preferences) - poiPriority(b, preferences) ||
      (Number.isFinite(a.distanceInMeters) ? a.distanceInMeters : Infinity) -
      (Number.isFinite(b.distanceInMeters) ? b.distanceInMeters : Infinity) ||
      a.poiId.localeCompare(b.poiId))
    .slice(0, INITIAL_POOL_POI_LIMIT)

  const pairs = []
  for (let i = 0; i < rankedPois.length; i++) {
    for (let j = i + 1; j < rankedPois.length; j++) {
      const ids = [rankedPois[i].poiId, rankedPois[j].poiId].sort()
      if (entries.some(entry => entry.key === waypointSetKey(ids))) continue
      const estimate = estimateCandidate(ids, estimator, routeType, range)
      if (!estimate) continue
      const categoryCost = (poiPriority(rankedPois[i], preferences) +
        poiPriority(rankedPois[j], preferences)) / 2
      pairs.push({
        ids, key: waypointSetKey(ids),
        origin: 'deterministic', index: Infinity,
        candidate: { waypoints: ids.map(poiId => ({ poiId })) },
        // Require a real predicted improvement before replacing an AI slot.
        score: estimate.score + categoryCost + 0.07
      })
    }
  }
  pairs.sort((a,b)=>a.score-b.score || a.key.localeCompare(b.key))
  let added = 0
  for (const pair of pairs) {
    if (added >= INITIAL_MAX_SUPPLEMENTAL_PAIRS) break
    const conflictIndices = entries.flatMap((entry,index) =>
      conflictsBySubset(entry.ids, pair.ids) ? [index] : [])
    if (conflictIndices.length > 1) continue
    const aiCount = entries.filter(entry => entry.origin === 'ai').length
    if (aiCount <= Math.max(1, candidates.length - INITIAL_MAX_SUPPLEMENTAL_PAIRS)) break
    // Replace exactly one AI slot; never shrink the batch just to include a pair.
    // A candidate containing {A,B} cannot coexist with the singleton {A}.
    const replaceAt = conflictIndices.length === 1 ? conflictIndices[0]
      : entries.reduce((worst,i,index) =>
        i.origin === 'ai' && (!entries[worst] || i.score > entries[worst].score ||
          (i.score === entries[worst].score && i.index > entries[worst].index))
          ? index : worst, -1)
    if (replaceAt < 0 || entries[replaceAt].origin !== 'ai') continue
    if (!(pair.score + INITIAL_PAIR_MIN_SCORE_GAIN < entries[replaceAt].score)) continue
    const next = entries.filter((_,index)=>index!==replaceAt)
    if (next.some(item => conflictsBySubset(item.ids, pair.ids))) continue
    entries = [...next,pair]
    added++
  }

  entries.sort((a,b)=>a.score-b.score || a.index-b.index || a.key.localeCompare(b.key))
  return {
    candidates: entries.map(item=>item.candidate),
    origins: entries.map(item=>item.origin),
    applied: true,
    supplementalPairCount: added,
    aiCandidateCount: entries.length - added
  }
}

module.exports = { rankInitialCandidates, conflictsBySubset }
