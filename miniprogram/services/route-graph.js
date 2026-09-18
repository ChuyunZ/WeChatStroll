const {
  ROUTE_TYPES
} = require('../constants/route-types')

const START_NODE_ID = 'START'

function createStartNode(start) {
  return {
    nodeType: 'start',
    nodeId: START_NODE_ID,
    latitude: start.latitude,
    longitude: start.longitude
  }
}

function getNodeId(node) {
  return node.nodeId
}

function createDirectedEdgeKey(fromNode, toNode) {
  return JSON.stringify([
    [fromNode.nodeType, fromNode.nodeId],
    [toNode.nodeType, toNode.nodeId]
  ])
}

function buildTraversalNodes(
  startNode,
  waypointNodes,
  routeType
) {
  if (routeType === ROUTE_TYPES.POINT_TO_POINT) {
    return [
      startNode,
      ...waypointNodes
    ]
  }

  if (routeType === ROUTE_TYPES.LOOP) {
    return [
      startNode,
      ...waypointNodes,
      startNode
    ]
  }

  const returnWaypointNodes = waypointNodes
    .slice(0, -1)
    .reverse()

  return [
    startNode,
    ...waypointNodes,
    ...returnWaypointNodes,
    startNode
  ]
}

function buildEdgePairs(nodes) {
  const edgePairs = []

  for (let index = 0; index < nodes.length - 1; index++) {
    edgePairs.push([
      nodes[index],
      nodes[index + 1]
    ])
  }

  return edgePairs
}

function buildPrefetchEdgePairs(
  startNode,
  waypointNodes,
  routeType
) {
  const edgePairs = []

  for (const waypoint of waypointNodes) {
    edgePairs.push([
      startNode,
      waypoint
    ])
  }

  for (const fromWaypoint of waypointNodes) {
    for (const toWaypoint of waypointNodes) {
      if (fromWaypoint.nodeId === toWaypoint.nodeId) {
        continue
      }

      edgePairs.push([
        fromWaypoint,
        toWaypoint
      ])
    }
  }

  if (routeType !== ROUTE_TYPES.POINT_TO_POINT) {
    for (const waypoint of waypointNodes) {
      edgePairs.push([
        waypoint,
        startNode
      ])
    }
  }

  return edgePairs
}

module.exports = {
  START_NODE_ID,
  createStartNode,
  getNodeId,
  createDirectedEdgeKey,
  buildTraversalNodes,
  buildEdgePairs,
  buildPrefetchEdgePairs
}