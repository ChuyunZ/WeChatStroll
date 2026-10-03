const { waypointSetKey, normalizePlanningFailure, isReplannableFailure } =
  require('../miniprogram/services/agentic-route-planning')

test('canonical sets ignore order without delimiter collisions', () => {
  expect(waypointSetKey(['C', 'A', 'B'])).toBe(waypointSetKey(['A', 'B', 'C']))
  expect(waypointSetKey(['A|B', 'C'])).not.toBe(waypointSetKey(['A', 'B|C']))
})

test('observations project only directed verified POI IDs and normalized failure', () => {
  expect(normalizePlanningFailure({ error: 'MULTI_SEGMENT_ROUTE_FAILED',
    failedSegment: { from: 'B', to: 'C', error: 'WALKING_SEGMENT_FAILED', causeCode: 'ROUTE_NOT_FOUND',
      latitude: 30, rawPayload: 'secret', polyline: [] } }, ['B', 'C']))
    .toEqual({ type: 'UNWALKABLE_SEGMENT', fromPoiId: 'B', toPoiId: 'C' })
  expect(normalizePlanningFailure({ error: 'WAYPOINT_ORDER_NOT_FOUND' }))
    .toEqual({ type: 'NO_COMPLETE_ROUTE' })
})

test.each(['AI_CONFIG_UNAVAILABLE', 'AI_REQUEST_FAILED', 'AI_ROUTE_PLANNING_FAILED',
  'INVALID_LOCATION', 'PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED', 'INVALID_PLANNING_SESSION', 'INVALID_REQUESTED_DURATION'])('%s is not replannable', error => {
  expect(isReplannableFailure(normalizePlanningFailure({ error }))).toBe(false)
})

test.each(['INVALID_AI_ROUTE_PLAN', 'EMPTY_AI_RESPONSE', 'INVALID_WAYPOINT_SET',
  'NO_WAYPOINTS', 'TOO_MANY_WAYPOINTS'])('%s permits another generation', error => {
  expect(isReplannableFailure(normalizePlanningFailure({ error }))).toBe(true)
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])(
  '%s takes precedence over stale waypoint failure metadata', code => {
    const failure = normalizePlanningFailure({
      error: code, reason: 'ROUTE_DURATION_OUT_OF_RANGE', actualDurationSeconds: 1,
      minDurationSeconds: 100, targetDurationSeconds: 150,
      failedSegment: { from: 'A', to: 'B', causeCode: 'ROUTE_NOT_FOUND' }
    }, ['A', 'B'])
    expect(isReplannableFailure(failure)).toBe(false)
  })
