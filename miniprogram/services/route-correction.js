// Bounded, deterministic correction of *verified* waypoint sets. This module
// ranks proposals with geometry/cached costs only. It never supplies route
// facts, replaces provider calls, or weakens final route validation.
const { waypointSetKey } = require('./agentic-route-planning')
const { createWaypointCandidateCache } = require('./waypoint-candidate-cache')
const { createSessionDurationEstimator } = require('./route-correction-estimator')
const { createStartNode, createDirectedEdgeKey, buildPrefetchEdgePairs } = require('./route-graph')
const { isProviderUnavailableCode } = require('../utils/provider-errors')
const { ROUTE_TYPES } = require('../constants/route-types')
const {
  EXACT_ORDERING_MAX_WAYPOINTS,
  MAX_CORRECTION_CANDIDATES,
  MAX_CORRECTION_NEW_SEGMENTS,
  MAX_CORRECTION_WAYPOINTS,
  ROUTE_DURATION_TOLERANCE_RATIO,
  ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
  ROUTE_DURATION_MAX_TOLERANCE_SECONDS
} = require('../config/route-planning')

// These are upper bounds, not targets to spend. All proposed sets are <= the
// exact-ordering limit, where the optimizer eagerly prefetches every directed
// edge. Preflight therefore gives a conservative bound on added map requests.

function normalizeExcludedKeys(sets) {
  const keys = new Set()
  for (const item of sets instanceof Set ? sets : Array.isArray(sets) ? sets : []) {
    if (Array.isArray(item) && item.length) {
      keys.add(waypointSetKey(item))
    } else if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item)
        if (Array.isArray(parsed) && parsed.length) keys.add(waypointSetKey(parsed))
      } catch (_) { /* Ignore malformed exclusion inputs. */ }
    }
  }
  return keys
}

function permutations(values) {
  if (values.length < 2) return [values]
  const result = []
  for (let index = 0; index < values.length; index++) {
    const head = values[index]
    for (const tail of permutations(values.filter((_, i) => i !== index))) {
      result.push([head, ...tail])
    }
  }
  return result
}

function classifyDuration(targetSeconds, durationSeconds) {
  const tolerance = Math.min(ROUTE_DURATION_MAX_TOLERANCE_SECONDS,
    Math.max(ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
      targetSeconds * ROUTE_DURATION_TOLERANCE_RATIO))
  return durationSeconds >= Math.max(0, targetSeconds - tolerance) &&
    durationSeconds <= targetSeconds + tolerance
}

function durationWindow(targetSeconds) {
  const tolerance = Math.min(ROUTE_DURATION_MAX_TOLERANCE_SECONDS,
    Math.max(ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
      targetSeconds * ROUTE_DURATION_TOLERANCE_RATIO))
  return { minSeconds: Math.max(0, targetSeconds - tolerance), maxSeconds: targetSeconds + tolerance }
}

function inspectSet(session, ids, targetSeconds, estimator, cachedCosts) {
  const scope = session.getWaypointSearchData(ids)
  if (!scope || !scope.valid || scope.waypoints.length !== ids.length) return null
  const costByEdge = new Map(cachedCosts.map(cost => [cost.edgeKey, cost]))
  const start = createStartNode(scope.start)
  const nodes = scope.waypoints.map(poi => ({ ...poi, nodeType: 'waypoint', nodeId: poi.poiId }))
  const prefetchEdges = buildPrefetchEdgePairs(start, nodes, scope.routeType)
  const missing = new Set(prefetchEdges.map(([from, to]) => createDirectedEdgeKey(from, to))
    .filter(key => !costByEdge.has(key)))
  const window = durationWindow(targetSeconds)
  const orders = permutations([...ids].sort())
  // A known singleton out-and-back time is a *lower bound* on any longer
  // out-and-back order beginning with that POI (all additional edges are
  // nonnegative). A long singleton therefore cannot be the first waypoint
  // of a feasible expanded route. It does NOT invalidate other first POIs.
  const singleton = new Map()
  if (scope.routeType === ROUTE_TYPES.OUT_AND_BACK) {
    for (const node of nodes) {
      const outward = costByEdge.get(createDirectedEdgeKey(start,node))
      const inward = costByEdge.get(createDirectedEdgeKey(node,start))
      if (outward && inward && outward.success && inward.success &&
          Number.isFinite(outward.durationSeconds) && Number.isFinite(inward.durationSeconds)) {
        singleton.set(node.nodeId, outward.durationSeconds + inward.durationSeconds)
      }
    }
  }
  const overlongCount = ids.filter(id => singleton.has(id) && singleton.get(id) > window.maxSeconds).length
  if (scope.routeType === ROUTE_TYPES.OUT_AND_BACK && overlongCount === ids.length) return null
  // This is a SOFT tie-break for promising expansions: when two singleton
  // walks are short, joining them is preferable to involving an already long
  // or already satisfactory singleton, all else equal.
  const withinWindowCount = ids.filter(id => singleton.has(id) &&
    singleton.get(id) >= window.minSeconds && singleton.get(id) <= window.maxSeconds).length
  const evidencePenalty = overlongCount * 0.65 + withinWindowCount * 0.25
  let best = null
  for (const order of orders) {
    if (scope.routeType === ROUTE_TYPES.OUT_AND_BACK &&
        singleton.has(order[0]) && singleton.get(order[0]) > window.maxSeconds) continue
    const estimate = estimator.estimate(order, scope.routeType, targetSeconds,
      window.minSeconds, window.maxSeconds)
    // A known unwalkable directed segment makes this order impossible. Other
    // orders are still evaluated; a whole set is removed only if none survives.
    if (estimate.failedEdges > 0) continue
    if (!best || estimate.tier < best.tier ||
        (estimate.tier === best.tier && estimate.quality < best.quality)) best = estimate
  }
  if (!best || (missing.size === 0 && best.tier !== 0)) return null
  return {
    newSegmentUpperBound: missing.size,
    estimatedTargetErrorSeconds: Math.abs(best.durationSeconds - targetSeconds),
    estimatedFeasible: best.feasible,
    estimatedLowSeconds: best.lowSeconds,
    estimatedHighSeconds: best.highSeconds,
    rankTier: best.tier,
    rankQuality: best.quality,
    rankEvidencePenalty: evidencePenalty,
    knownFailedEdges: 0,
    fullyCached: missing.size === 0
  }
}

function createRankingContext(session, poolIds) {
  const scope = session.getWaypointSearchData(poolIds)
  if (!scope || !scope.valid || scope.waypoints.length !== poolIds.length) return null
  const cachedCosts = session.getCachedSegmentCosts()
  return { cachedCosts, estimator: createSessionDurationEstimator({
    searchData: scope, cachedCosts
  }) }
}

function compareRankedProposals(a, b) {
  return a.rankTier - b.rankTier ||
    a.rankEvidencePenalty - b.rankEvidencePenalty ||
    a.rankQuality - b.rankQuality ||
    a.newSegmentUpperBound - b.newSegmentUpperBound ||
    a.estimatedTargetErrorSeconds - b.estimatedTargetErrorSeconds ||
    a.waypointIds.length - b.waypointIds.length ||
    a.key.localeCompare(b.key)
}

function proposeDeterministicWaypointSets({
  session, verifiedWaypointPool = [], observations = [], excludedWaypointSets = [],
  requestedDurationMinutes, allowPairFallback = false
} = {}) {
  if (!session || typeof session.getWaypointSearchData !== 'function' ||
      typeof session.getCachedSegmentCosts !== 'function' ||
      !Number.isFinite(requestedDurationMinutes) || requestedDurationMinutes <= 0) return []

  const poolIds = [...new Set(verifiedWaypointPool
    .map(poi => poi && poi.poiId)
    .filter(id => typeof id === 'string' && id.trim() !== '')
    .map(id => id.trim()))].sort()
  const pool = new Set(poolIds)
  const excluded = normalizeExcludedKeys(excludedWaypointSets)
  const proposals = new Map()
  function add(ids, reason) {
    const normalized = [...new Set(ids)].sort()
    if (normalized.length === 0 || normalized.length > Math.min(MAX_CORRECTION_WAYPOINTS, EXACT_ORDERING_MAX_WAYPOINTS) ||
        !normalized.every(id => pool.has(id))) return
    const key = waypointSetKey(normalized)
    if (!excluded.has(key) && !proposals.has(key)) {
      proposals.set(key, { waypointIds: normalized, reason, key })
    }
  }
  for (const observation of observations) {
    const ids = observation && observation.waypointIds
    const type = observation && observation.failure && observation.failure.type
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        !ids.every(id => pool.has(id))) continue
    if (type === 'DURATION_TOO_LONG' && ids.length > 1) {
      for (let index = 0; index < ids.length; index++) {
        add(ids.filter((_, i) => i !== index), 'remove')
      }
    }
    if (type === 'DURATION_TOO_SHORT' && ids.length < Math.min(MAX_CORRECTION_WAYPOINTS, EXACT_ORDERING_MAX_WAYPOINTS)) {
      for (const id of poolIds) {
        if (!ids.includes(id)) add([...ids, id], 'insert')
      }
    }
  }
  // The manual Add/Replace case: all singletons were surfaced/excluded, but
  // the planner returned no new sets. Pairs are novel hypotheses, not assumed
  // valid. They must still pass the real optimizer + full validator.
  if (allowPairFallback && poolIds.length >= 2) {
    for (let i = 0; i < poolIds.length; i++) {
      for (let j = i + 1; j < poolIds.length; j++) {
        add([poolIds[i], poolIds[j]], 'novel_pair')
      }
    }
  }

  const targetSeconds = requestedDurationMinutes * 60
  const context = createRankingContext(session, poolIds)
  if (!context) return []
  return [...proposals.values()].map(proposal => {
    const cost = inspectSet(session, proposal.waypointIds, targetSeconds,
      context.estimator, context.cachedCosts)
    return cost ? { ...proposal, ...cost } : null
  }).filter(Boolean).sort(compareRankedProposals)
}

function providerErrorCode(result) {
  const codes = [result && result.code, result && result.error,
    result && result.causeCode, result && result.failedSegment && result.failedSegment.error,
    result && result.failedSegment && result.failedSegment.causeCode]
  return codes.find(isProviderUnavailableCode) || null
}

async function runBoundedRouteCorrections({
  session, verifiedWaypointPool, observations = [], excludedWaypointSets = [],
  requestedDurationMinutes, allowPairFallback = false, buildCandidateRoute,
  maxCandidates = MAX_CORRECTION_CANDIDATES,
  maxNewSegmentCalls = MAX_CORRECTION_NEW_SEGMENTS
} = {}) {
  if (typeof buildCandidateRoute !== 'function') {
    throw new TypeError('buildCandidateRoute must be a function')
  }
  const proposals = proposeDeterministicWaypointSets({
    session, verifiedWaypointPool, observations, excludedWaypointSets,
    requestedDurationMinutes, allowPairFallback
  })
  const attemptedWaypointSets = []
  const failures = []
  let remainingSegmentBudget = Math.max(0, Math.floor(maxNewSegmentCalls))
  let attemptedCandidates = 0
  // Candidate cache is ephemeral; the UI's original candidate cache is never
  // replaced. Successful routes keep their complete waypoint-set identity.
  const cache = createWaypointCandidateCache(proposals.map(proposal => ({
    waypoints: proposal.waypointIds.map(poiId => ({ poiId }))
  })))
  const entries = cache.getAllCandidates()
  const pending = new Set(proposals.map((_, index) => index))
  const targetSeconds = requestedDurationMinutes * 60
  const poolIds = [...new Set(verifiedWaypointPool.map(poi => poi.poiId))].sort()
  while (pending.size > 0 && attemptedCandidates < maxCandidates) {
    // Re-rank AFTER each builder resolves new directed edges. The initial list
    // is only a proposal pool; it is not a fixed execution order.
    const context = createRankingContext(session, poolIds)
    if (!context) break
    const next = [...pending].map(index => {
      const proposal = proposals[index]
      const latest = inspectSet(session, proposal.waypointIds, targetSeconds,
        context.estimator, context.cachedCosts)
      return latest ? { ...proposal, ...latest, index } : null
    }).filter(candidate => candidate && candidate.newSegmentUpperBound <= remainingSegmentBudget)
      .sort(compareRankedProposals)[0]
    if (!next) break
    const index = next.index
    const proposal = proposals[index]
    pending.delete(index)
    remainingSegmentBudget -= next.newSegmentUpperBound
    attemptedCandidates++
    attemptedWaypointSets.push([...proposal.waypointIds])
    const candidate = entries[index]
    let result
    try {
      result = await buildCandidateRoute({ candidate, candidateCache: cache, candidateIndex: index })
    } catch (error) {
      const code = providerErrorCode(error)
      if (code) return { success: false, providerError: code, attemptedCandidates,
        attemptedWaypointSets, failures, remainingSegmentBudget }
      failures.push({ waypointIds: [...proposal.waypointIds], result: {
        error: error && error.code || 'UNEXPECTED_CANDIDATE_ERROR'
      } })
      continue
    }
    const code = providerErrorCode(result)
    if (code) return { success: false, providerError: code, attemptedCandidates,
      attemptedWaypointSets, failures, remainingSegmentBudget }
    if (result && result.success === true) {
      return { success: true, route: result.route, attemptedCandidates,
        attemptedWaypointSets, failures, remainingSegmentBudget }
    }
    failures.push({ waypointIds: [...proposal.waypointIds], result: result || {
      error: 'NO_VALID_ROUTE'
    } })
  }
  return { success: false, attemptedCandidates, attemptedWaypointSets,
    failures, remainingSegmentBudget }
}

module.exports = {
  proposeDeterministicWaypointSets,
  runBoundedRouteCorrections
}
