const {
  createStartNode,
  createDirectedEdgeKey,
  buildTraversalNodes,
  buildEdgePairs
} = require('./route-graph')

const EARTH_RADIUS_METERS = 6371000
// Only a unit conversion for missing-edge exploration priority, never a
// walking-time promise or a replacement for the provider's route costs.
const ESTIMATED_WALKING_METERS_PER_SECOND = 1.4

function estimateDistanceMeters(from, to) {
  const radians = Math.PI / 180
  const latitudeDelta = (to.latitude - from.latitude) * radians
  const longitudeDelta = (to.longitude - from.longitude) * radians
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))))
}

// One fixed snapshot per improvement round, shared by all seed frontiers.
// Only trusted search data and copied settled facts enter this pure estimator.
function createOrderPriorityEstimator(searchData, cachedCosts, targetSeconds) {
  const start = createStartNode(searchData.start)
  const nodes = new Map(searchData.waypoints.map(point => [point.poiId, {
    ...point, nodeType: 'waypoint', nodeId: point.poiId
  }]))
  const costs = new Map(cachedCosts.map(cost => [cost.edgeKey, { ...cost }]))

  return function estimateOrderPriority(order) {
    const traversal = buildTraversalNodes(start, order.map(id => nodes.get(id)), searchData.routeType)
    let durationSeconds = 0
    let distanceMeters = 0
    let failedEdgeCount = 0
    for (const [from, to] of buildEdgePairs(traversal)) {
      const cost = costs.get(createDirectedEdgeKey(from, to))
      if (cost && cost.success) {
        durationSeconds += cost.durationSeconds
        distanceMeters += cost.distanceMeters
      } else {
        // Known failures rank behind candidates without known failures. The
        // geometric numbers only break ties; they never make this route valid.
        if (cost) failedEdgeCount++
        const estimatedDistance = estimateDistanceMeters(from, to)
        distanceMeters += estimatedDistance
        durationSeconds += estimatedDistance / ESTIMATED_WALKING_METERS_PER_SECOND
      }
    }
    return {
      failedEdgeCount,
      durationSeconds,
      distanceMeters,
      targetErrorSeconds: targetSeconds === null ? 0 : Math.abs(durationSeconds - targetSeconds)
    }
  }
}

module.exports = { createOrderPriorityEstimator }
