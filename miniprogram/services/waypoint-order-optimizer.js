const {
  EXACT_ORDERING_MAX_WAYPOINTS,
  MAX_WAYPOINTS,
  ORDERING_MAX_SEEDS,
  ORDERING_MAX_EVALUATIONS,
  ORDERING_MAX_ROUNDS
} = require('../config/route-planning')
const { createOrderPriorityEstimator } = require('./waypoint-order-priority')

const MOVE_TYPE_PRIORITY = { relocation: 0, swap: 1, two_opt: 2 }

function compareMoveMetadata(left, right) {
  return MOVE_TYPE_PRIORITY[left.type] - MOVE_TYPE_PRIORITY[right.type] ||
    left.fromIndex - right.fromIndex || left.toIndex - right.toIndex ||
    compareIds(left.order, right.order)
}

function compareIds(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return left.length - right.length
}

function* permutations(ids) {
  if (ids.length === 0) {
    yield []
    return
  }
  for (let index = 0; index < ids.length; index++) {
    const rest = ids.filter((_, i) => i !== index)
    for (const tail of permutations(rest)) yield [ids[index], ...tail]
  }
}

// Great-circle distance is used only for seeds, never for route scoring.
function seedDistance(from, to) {
  const radians = Math.PI / 180
  const latitudeDelta = (to.latitude - from.latitude) * radians
  const longitudeDelta = (to.longitude - from.longitude) * radians
  return Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin(longitudeDelta / 2) ** 2
}

function createSeeds(searchData) {
  const remaining = [...searchData.waypoints].sort(
    (a, b) => compareIds([a.poiId], [b.poiId])
  )
  const canonical = remaining.map(point => point.poiId)
  const nearest = []
  let current = searchData.start
  while (remaining.length) {
    let best = 0
    for (let index = 1; index < remaining.length; index++) {
      if (seedDistance(current, remaining[index]) < seedDistance(current, remaining[best])) {
        best = index
      }
    }
    current = remaining.splice(best, 1)[0]
    nearest.push(current.poiId)
  }
  const seen = new Set()
  return [nearest, [...nearest].reverse(), canonical].filter(order => {
    const key = JSON.stringify(order)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, ORDERING_MAX_SEEDS)
}

// Deduplicate all move types, retaining canonical metadata independently of
// generation order. evaluate() still deduplicates across seed frontiers.
function neighbors(order) {
  const currentKey = JSON.stringify(order)
  const candidates = new Map()
  function add(type, candidateOrder, fromIndex, toIndex) {
    const key = JSON.stringify(candidateOrder)
    if (key === currentKey) return
    const candidate = { type, order: candidateOrder, fromIndex, toIndex }
    const existing = candidates.get(key)
    if (!existing || compareMoveMetadata(candidate, existing) < 0) candidates.set(key, candidate)
  }
  for (let from = 0; from < order.length; from++) {
    for (let to = 0; to < order.length; to++) {
      if (from === to) continue
      const moved = [...order]
      moved.splice(to, 0, moved.splice(from, 1)[0])
      add('relocation', moved, from, to)
      if (from < to) {
        const swapped = [...order]
        swapped[from] = order[to]
        swapped[to] = order[from]
        add('swap', swapped, from, to)
        // This is an order transformation only. Directed costs are evaluated
        // in full by the engine, never by a symmetric 2-opt delta formula.
        const reversed = [
          ...order.slice(0, from),
          ...order.slice(from, to + 1).reverse(),
          ...order.slice(to + 1)
        ]
        add('two_opt', reversed, from, to)
      }
    }
  }
  return Array.from(candidates.values())
}

function prioritizeNeighbors(order, estimate) {
  return neighbors(order)
    .map(candidate => ({ ...candidate, priority: estimate(candidate.order) }))
    .sort((left, right) => {
      const a = left.priority
      const b = right.priority
      return a.failedEdgeCount - b.failedEdgeCount ||
        a.targetErrorSeconds - b.targetErrorSeconds ||
        a.durationSeconds - b.durationSeconds ||
        a.distanceMeters - b.distanceMeters || compareMoveMetadata(left, right)
    })
}

async function optimizeWaypointOrder({ session, waypointIds, requestedDurationMinutes } = {}) {
  if (!session || typeof session.getWaypointSearchData !== 'function' ||
      typeof session.evaluateRouteOrder !== 'function' ||
      typeof session.getCachedSegmentCosts !== 'function' ||
      typeof session.prefetchSegments !== 'function') {
    return { success: false, error: 'INVALID_PLANNING_SESSION' }
  }
  const hasTarget = requestedDurationMinutes !== undefined
  if (hasTarget && (!Number.isFinite(requestedDurationMinutes) ||
      requestedDurationMinutes <= 0 || !Number.isFinite(requestedDurationMinutes * 60))) {
    return { success: false, error: 'INVALID_REQUESTED_DURATION' }
  }
  const targetSeconds = hasTarget ? requestedDurationMinutes * 60 : null
  const searchData = session.getWaypointSearchData(waypointIds)
  if (!searchData.valid) {
    return { success: false, error: 'INVALID_WAYPOINT_SET', reason: searchData.reason,
      validationReason: searchData.validationReason }
  }
  const ids = searchData.waypoints.map(point => point.poiId).sort()
  if (ids.length === 0) return { success: false, error: 'NO_WAYPOINTS' }
  if (ids.length > MAX_WAYPOINTS) return { success: false, error: 'TOO_MANY_WAYPOINTS' }

  const exact = ids.length <= EXACT_ORDERING_MAX_WAYPOINTS
  const strategy = exact ? 'exact' : 'heuristic'
  const evaluated = new Map()
  let best = null
  let temporaryFailure = null
  let rounds = 0
  const roundEvaluationCounts = []

  function compare(left, right) {
    if (!right) return -1
    if (hasTarget) {
      const errorDifference = Math.abs(left.durationSeconds - targetSeconds) -
        Math.abs(right.durationSeconds - targetSeconds)
      if (errorDifference !== 0) return errorDifference
    }
    return left.durationSeconds - right.durationSeconds ||
      left.distanceMeters - right.distanceMeters || compareIds(left.order, right.order)
  }

  async function evaluate(order) {
    const key = JSON.stringify(order)
    if (evaluated.has(key)) return evaluated.get(key)
    if (!exact && evaluated.size >= ORDERING_MAX_EVALUATIONS) return null
    const cost = await session.evaluateRouteOrder({
      allowedWaypointIds: ids,
      orderedWaypointIds: order
    })
    if (cost.error === 'AMAP_RATE_LIMITED') temporaryFailure = cost
    const result = cost.success ? { ...cost, order: [...order] } : null
    // Failed orders also consume the budget; never compare partial routes.
    evaluated.set(key, result)
    if (result && compare(result, best) < 0) best = result
    return result
  }

  let seedCount = 0
  if (exact) {
    await session.prefetchSegments(ids)
    for (const order of permutations(ids)) await evaluate(order)
  } else {
    const seeds = createSeeds(searchData)
    seedCount = seeds.length
    let frontiers = []
    for (const order of seeds) {
      frontiers.push({ order, result: await evaluate(order) })
    }
    for (let round = 0; round < ORDERING_MAX_ROUNDS; round++) {
      if (evaluated.size >= ORDERING_MAX_EVALUATIONS) break
      rounds++
      const roundStartEvaluationCount = evaluated.size
      const roundBudget = Math.ceil(
        (ORDERING_MAX_EVALUATIONS - evaluated.size) / (ORDERING_MAX_ROUNDS - round)
      )
      const hasRoundCapacity = () => evaluated.size < ORDERING_MAX_EVALUATIONS &&
        evaluated.size - roundStartEvaluationCount < roundBudget
      const next = frontiers.map(frontier => ({ ...frontier }))
      // Snapshot after seed evaluation / the previous round. Do not resort
      // mid-round as new provider results arrive: all frontiers share facts.
      const estimate = createOrderPriorityEstimator(searchData, session.getCachedSegmentCosts(), targetSeconds)
      const iterators = frontiers.map(frontier =>
        prioritizeNeighbors(frontier.order, estimate)[Symbol.iterator]()
      )
      let active = true
      // Round-robin exploration includes variants of failed seeds.
      while (active && hasRoundCapacity()) {
        active = false
        for (let index = 0; index < iterators.length; index++) {
          if (!hasRoundCapacity()) break
          const step = iterators[index].next()
          if (step.done) continue
          active = true
          const result = await evaluate(step.value.order)
          if (result && compare(result, next[index].result) < 0) {
            next[index] = { order: result.order, result }
          }
        }
      }
      const newEvaluationCount = evaluated.size - roundStartEvaluationCount
      roundEvaluationCounts.push(newEvaluationCount)
      frontiers = next
      // New settled edges can improve the next round's priorities even when
      // no frontier improved. Stop only when no unseen orders were evaluated.
      if (newEvaluationCount === 0) break
    }
  }

  const optimization = {
    strategy,
    waypointCount: ids.length,
    evaluatedOrderCount: evaluated.size,
    evaluationBudget: exact ? null : ORDERING_MAX_EVALUATIONS,
    roundEvaluationCounts,
    seedCount,
    improvementRounds: rounds,
    budgetExhausted: !exact && evaluated.size >= ORDERING_MAX_EVALUATIONS,
    recommendedWaypointIds: best ? [...best.order] : [],
    durationSeconds: best ? best.durationSeconds : null,
    distanceMeters: best ? best.distanceMeters : null,
    targetErrorSeconds: best && hasTarget ? Math.abs(best.durationSeconds - targetSeconds) : null
  }
  if (!best) {
    return { success: false,
      error: temporaryFailure ? 'AMAP_RATE_LIMITED' : 'WAYPOINT_ORDER_NOT_FOUND',
      ...(temporaryFailure ? { failedSegment: temporaryFailure.failedSegment } : {}), optimization }
  }
  return { success: true, recommendedWaypointIds: [...best.order], optimization }
}

module.exports = { optimizeWaypointOrder }
