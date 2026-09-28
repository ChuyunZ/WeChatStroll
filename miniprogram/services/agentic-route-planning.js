// Request-local orchestration helpers. Only allowlisted facts reach the model.
function waypointSetKey(ids) {
  return JSON.stringify([...new Set(ids)].sort())
}

function normalizePlanningFailure(result = {}, waypointIds = []) {
  const code = result.code || result.error
  if (code === 'INVALID_AI_ROUTE_PLAN' || code === 'EMPTY_AI_RESPONSE') {
    return { type: 'INVALID_AI_PLAN' }
  }
  if (result.reason === 'ROUTE_DURATION_OUT_OF_RANGE') {
    const actual = result.actualDurationSeconds
    const type = actual < result.minDurationSeconds ? 'DURATION_TOO_SHORT'
      : actual > result.maxDurationSeconds ? 'DURATION_TOO_LONG' : null
    if (type && Number.isFinite(actual) && Number.isFinite(result.targetDurationSeconds)) {
      return { type, actualDurationSeconds: actual, targetDurationSeconds: result.targetDurationSeconds }
    }
  }
  const segment = result.failedSegment
  if (segment && ['ROUTE_NOT_FOUND', 'UNREACHABLE'].includes(segment.causeCode || segment.error)) {
    const failure = { type: 'UNWALKABLE_SEGMENT' }
    // START is an application node, not a POI; never substitute coordinates.
    if (waypointIds.includes(segment.from)) failure.fromPoiId = segment.from
    if (waypointIds.includes(segment.to)) failure.toPoiId = segment.to
    return failure
  }
  if (code === 'WAYPOINT_ORDER_NOT_FOUND' && !segment) return { type: 'NO_COMPLETE_ROUTE' }
  return { type: 'ROUTE_BUILD_FAILED' }
}

function isReplannableFailure(failure) {
  return ['INVALID_AI_PLAN', 'UNWALKABLE_SEGMENT', 'NO_COMPLETE_ROUTE',
    'DURATION_TOO_SHORT', 'DURATION_TOO_LONG'].includes(failure.type)
}

module.exports = { waypointSetKey, normalizePlanningFailure, isReplannableFailure }
