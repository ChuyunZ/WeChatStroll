const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { SEGMENT_FETCH_CONCURRENCY } = require('../miniprogram/config/route-planning')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const start = { latitude: 30, longitude: 120 }
const pool = ['A', 'B', 'C'].map((poiId, i) => ({ poiId, latitude: 30 + i / 100, longitude: 121 }))
const order = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }
const success = (from, to) => ({ success: true, durationSeconds: 10, distanceMeters: 20, polyline: [from, to] })

test('cloud transport rejection stays temporary through optimization and repeated evaluation', async () => {
  global.wx = { cloud: { callFunction: jest.fn().mockRejectedValue(new Error('private transport details')) } }
  try {
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
    expect(await optimizeWaypointOrder({ session, waypointIds: ['A'] }))
      .toMatchObject({ success: false, error: 'PROVIDER_GATEWAY_FAILED' })
    expect(await session.evaluateRouteOrder(order)).toMatchObject({
      error: 'PROVIDER_GATEWAY_FAILED',
      failedSegment: { error: 'PROVIDER_GATEWAY_FAILED', causeCode: 'PROVIDER_GATEWAY_FAILED' }
    })
    expect(session.getCachedSegmentCosts()).toEqual([])
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
  } finally { delete global.wx }
})

test('logical segment concurrency stays bounded and has no client QPS timers', async () => {
  jest.useFakeTimers()
  try {
    const complete = []
    let active = 0
    let peak = 0
    const resolver = jest.fn((from, to) => new Promise(resolve => {
      active++
      peak = Math.max(peak, active)
      complete.push(() => { active--; resolve(success(from, to)) })
    }))
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
    const pending = session.prefetchSegments(['A', 'B', 'C'])
    await jest.advanceTimersByTimeAsync(0)
    expect(resolver).toHaveBeenCalledTimes(SEGMENT_FETCH_CONCURRENCY)
    expect(jest.getTimerCount()).toBe(0)
    while (complete.length) {
      complete.shift()()
      await jest.advanceTimersByTimeAsync(0)
    }
    expect((await pending).allEdgesAvailable).toBe(true)
    expect(peak).toBe(SEGMENT_FETCH_CONCURRENCY)
    expect(resolver).toHaveBeenCalledTimes(9)
  } finally { jest.useRealTimers() }
})

test('same directed edge shares its in-flight request and settled L1 value', async () => {
  let finish
  const resolver = jest.fn((from, to) => new Promise(resolve => { finish = () => resolve(success(from, to)) }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const first = session.evaluateRouteOrder(order)
  const duplicate = session.buildRouteForOrder(order)
  await Promise.resolve()
  expect(resolver).toHaveBeenCalledTimes(1)
  finish()
  expect((await first).success).toBe(true)
  expect((await duplicate).success).toBe(true)
  await session.evaluateRouteOrder(order)
  expect(resolver).toHaveBeenCalledTimes(1)
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])('backend busy is not retried locally or recorded as an unreachable edge', async code => {
  const resolver = jest.fn(async () => ({ success: false, error: code }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  expect(await optimizeWaypointOrder({ session, waypointIds: ['A'] }))
    .toMatchObject({ success: false, error: code })
  expect(resolver).toHaveBeenCalledTimes(1)
  expect(session.getCachedSegmentCosts()).toEqual([])
  expect((await session.evaluateRouteOrder(order)).error).toBe(code)
  expect(resolver).toHaveBeenCalledTimes(1)
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])('cloud busy response crosses walking-segment and engine in one backend call', async code => {
  global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue({ result: {
    success: false, error: { code: code, message: 'Provider is temporarily busy' }
  } }) } }
  try {
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
    expect(await session.evaluateRouteOrder(order)).toMatchObject({ error: code })
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'mapProvider', data: {
      action: 'walkingRoute', start, destination: { latitude: pool[0].latitude, longitude: pool[0].longitude }
    } })
  } finally { delete global.wx }
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'].flatMap(code => ['throw', 'causeCode'].map(mode => [mode, code])))('temporary %s resolver failures retain their classification without local retries', async (mode, code) => {
  const resolver = jest.fn(async () => {
    if (mode === 'throw') throw Object.assign(new Error('busy'), { code: code })
    return { success: false, error: 'WALKING_SEGMENT_FAILED', causeCode: code }
  })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  expect(await session.evaluateRouteOrder(order)).toMatchObject({ error: code })
  expect(resolver).toHaveBeenCalledTimes(1)
  expect(session.getCachedSegmentCosts()).toEqual([])
})
