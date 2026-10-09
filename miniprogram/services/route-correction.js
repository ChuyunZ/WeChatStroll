// Bounded, deterministic correction of *verified* waypoint sets. This module
// ranks proposals with geometry/cached costs only. It never supplies route
// facts, replaces provider calls, or weakens final route validation.
const { waypointSetKey } = require('./agentic-route-planning')
const { createWaypointCandidateCache } = require('./waypoint-candidate-cache')
const { createOrderPriorityEstimator } = require('./waypoint-order-priority')
const { createStartNode, createDirectedEdgeKey, buildPrefetchEdgePairs } = require('./route-graph')
const { isProviderUnavailableCode } = require('../utils/provider-errors')
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

function inspectSet(session, ids, targetSeconds) {
  const scope = session.getWaypointSearchData(ids)
  if (!scope || !scope.valid || scope.waypoints.length !== ids.length) return null
  const cachedCosts = session.getCachedSegmentCosts()
  const costByEdge = new Map(cachedCosts.map(cost => [cost.edgeKey, cost]))
  const start = createStartNode(scope.start)
  const nodes = scope.waypoints.map(poi => ({ ...poi, nodeType: 'waypoint', nodeId: poi.poiId }))
  const prefetchEdges = buildPrefetchEdgePairs(start, nodes, scope.routeType)
  const missing = new Set(prefetchEdges.map(([from, to]) => createDirectedEdgeKey(from, to))
    .filter(key => !costByEdge.has(key)))
  const estimate = createOrderPriorityEstimator(scope, cachedCosts, targetSeconds)
  const orders = permutations([...ids].sort())
  let best = null
  let hasExactFeasible = false
  let allOrdersResolved = true
  for (const order of orders) {
    const result = estimate(order)
    const knownRoute = result.failedEdgeCount === 0 &&
      // The number of known edges for a full ordering is checked indirectly:
      // if any prefetch edge is missing, allOrdersResolved becomes false below.
      missing.size === 0
    if (knownRoute && classifyDuration(targetSeconds, result.durationSeconds)) {
      hasExactFeasible = true
    }
    if (!best || result.failedEdgeCount < best.failedEdgeCount ||
        (result.failedEdgeCount === best.failedEdgeCount &&
          result.targetErrorSeconds < best.targetErrorSeconds)) {
      best = result
    }
  }
  if (missing.size > 0) allOrdersResolved = false
  // If every directed edge is cached and no complete traversal could meet the
  // duration window, there is no reason to rebuild this set again.
  if (allOrdersResolved && !hasExactFeasible) return null
  return {
    newSegmentUpperBound: missing.size,
    estimatedTargetErrorSeconds: best.targetErrorSeconds,
    estimatedFeasible: classifyDuration(targetSeconds, best.durationSeconds),
    knownFailedEdges: best.failedEdgeCount,
    fullyCached: missing.size === 0
  }
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
  return [...proposals.values()].map(proposal => {
    const cost = inspectSet(session, proposal.waypointIds, targetSeconds)
    return cost ? { ...proposal, ...cost } : null
  }).filter(Boolean).sort((a, b) =>
    Number(b.estimatedFeasible) - Number(a.estimatedFeasible) ||
    a.knownFailedEdges - b.knownFailedEdges ||
    a.newSegmentUpperBound - b.newSegmentUpperBound ||
    a.estimatedTargetErrorSeconds - b.estimatedTargetErrorSeconds ||
    a.waypointIds.length - b.waypointIds.length ||
    a.key.localeCompare(b.key)
  )
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
  for (let index = 0; index < proposals.length && attemptedCandidates < maxCandidates; index++) {
    const proposal = proposals[index]
    const latest = inspectSet(session, proposal.waypointIds, requestedDurationMinutes * 60)
    if (!latest || latest.newSegmentUpperBound > remainingSegmentBudget) continue
    remainingSegmentBudget -= latest.newSegmentUpperBound
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
