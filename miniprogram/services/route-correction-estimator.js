// Candidate PRIORITY only. Unresolved walking segments never become route facts.
// The existing RoutePlanningSession, optimizer and validator remain authoritative.
const { createStartNode, createDirectedEdgeKey, buildTraversalNodes, buildEdgePairs } = require('./route-graph')

const EARTH_RADIUS_METERS = 6371000
const DEFAULT_SPEED_METERS_PER_SECOND = 1.4
const MIN_CALIBRATION_DISTANCE_METERS = 75
const CALIBRATION_PRIOR_WEIGHT = 4

function straightLineMeters(from, to) {
  const radians = Math.PI / 180
  const lat = (to.latitude - from.latitude) * radians
  const lng = (to.longitude - from.longitude) * radians
  const h = Math.sin(lat / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(lng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))))
}

function median(sorted) {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function clamp(min, max, value) { return Math.max(min, Math.min(max, value)) }

function createSessionDurationEstimator({ searchData, cachedCosts }) {
  const start = createStartNode(searchData.start)
  const nodes = new Map(searchData.waypoints.map(point => [point.poiId, {
    ...point, nodeType: 'waypoint', nodeId: point.poiId
  }]))
  const nodesByKey = new Map([[JSON.stringify(['start', start.nodeId]), start],
    ...Array.from(nodes.values(), node => [JSON.stringify(['waypoint', node.nodeId]), node])])
  const costs = new Map(cachedCosts.map(cost => [cost.edgeKey, cost]))
  const ratios = []
  for (const [key, cost] of costs) {
    if (!cost || cost.success !== true || !Number.isFinite(cost.durationSeconds) || cost.durationSeconds <= 0) continue
    let ends
    try { ends = JSON.parse(key) } catch (_) { continue }
    if (!Array.isArray(ends) || ends.length !== 2) continue
    const from = nodesByKey.get(JSON.stringify(ends[0]))
    const to = nodesByKey.get(JSON.stringify(ends[1]))
    if (!from || !to) continue
    const distance = straightLineMeters(from, to)
    if (distance < MIN_CALIBRATION_DISTANCE_METERS) continue
    const ratio = cost.durationSeconds / (distance / DEFAULT_SPEED_METERS_PER_SECOND)
    // Extreme detours and anomalous segments must not set the prior for other streets.
    if (ratio >= 0.6 && ratio <= 4.5) ratios.push(ratio)
  }
  ratios.sort((a, b) => a - b)
  const typical = median(ratios)
  const influence = ratios.length / (ratios.length + CALIBRATION_PRIOR_WEIGHT)
  const correctionRatio = typical === null ? 1 : clamp(0.8, 2.5, 1 + influence * (typical - 1))
  // Conservative *heuristic* spread, not a calibrated statistical confidence interval.
  // Avoid narrowing drastically even with many samples because street geometry varies.
  const relativeSpread = clamp(0.55, 1.1, 1.1 - ratios.length * 0.05)

  function estimate(order, routeType, targetSeconds, minSeconds, maxSeconds) {
    const traversal = buildTraversalNodes(start, order.map(id => nodes.get(id)), routeType)
    let durationSeconds = 0
    let lowSeconds = 0
    let highSeconds = 0
    let unresolvedEdges = 0
    let failedEdges = 0
    for (const [from, to] of buildEdgePairs(traversal)) {
      const cost = costs.get(createDirectedEdgeKey(from, to))
      if (cost) {
        if (cost.success !== true || !Number.isFinite(cost.durationSeconds)) {
          failedEdges++
          continue
        }
        durationSeconds += cost.durationSeconds
        lowSeconds += cost.durationSeconds
        highSeconds += cost.durationSeconds
      } else {
        unresolvedEdges++
        const seconds = straightLineMeters(from, to) / DEFAULT_SPEED_METERS_PER_SECOND * correctionRatio
        durationSeconds += seconds
        lowSeconds += seconds * (1 - relativeSpread * 0.65)
        highSeconds += seconds * (1 + relativeSpread * 1.4)
      }
    }
    const exact = unresolvedEdges === 0 && failedEdges === 0
    const feasible = durationSeconds >= minSeconds && durationSeconds <= maxSeconds
    const intervalGap = highSeconds < minSeconds ? minSeconds - highSeconds
      : lowSeconds > maxSeconds ? lowSeconds - maxSeconds : 0
    const overlap = Math.max(0, Math.min(highSeconds, maxSeconds) - Math.max(lowSeconds, minSeconds))
    const span = highSeconds - lowSeconds
    const overlapFraction = span === 0 ? Number(feasible) : overlap / span
    const distanceToWindow = durationSeconds < minSeconds ? minSeconds - durationSeconds
      : durationSeconds > maxSeconds ? durationSeconds - maxSeconds : 0
    const tier = exact && feasible ? 0 : feasible ? 1 : intervalGap === 0 ? 2 : 3
    // Normalized priority; none of these estimates can validate or reject an unbuilt route.
    const quality = distanceToWindow / targetSeconds +
      (1 - overlapFraction) * 0.8 +
      (span / targetSeconds) * 0.075 +
      Math.abs(durationSeconds - targetSeconds) / targetSeconds * 0.1
    return { durationSeconds, lowSeconds, highSeconds, failedEdges, unresolvedEdges,
      exact, feasible, tier, quality, intervalGap, overlapFraction }
  }
  return { estimate, calibrationSampleCount: ratios.length, correctionRatio }
}

module.exports = { createSessionDurationEstimator, straightLineMeters }
