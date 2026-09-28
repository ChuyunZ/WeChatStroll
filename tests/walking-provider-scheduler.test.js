const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const { WALKING_PROVIDER_MIN_INTERVAL_MS } = require('../miniprogram/config/route-planning')

const start = { latitude: 30, longitude: 120 }
const pool = ['A', 'B'].map((poiId, index) => ({ poiId, latitude: 30 + index / 100, longitude: 121 }))
const order = { allowedWaypointIds: ['A'], orderedWaypointIds: ['A'] }
const success = (from, to) => ({ success: true, durationSeconds: 10, distanceMeters: 20, polyline: [from, to] })
const limited = { success: false, error: 'AMAP_RATE_LIMITED' }

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(0)
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test('new directed requests start deterministically 400 ms apart; final cache hits use no slots', async () => {
  const starts = []
  const resolver = jest.fn(async (from, to) => {
    starts.push({ time: Date.now(), edge: `${from.nodeId}->${to.nodeId}` })
    return success(from, to)
  })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const prefetch = session.prefetchSegments(['A', 'B'])
  await jest.runAllTimersAsync()
  await prefetch
  expect(starts).toHaveLength(4)
  expect(starts.map(item => item.time)).toEqual([0, 400, 800, 1200])
  expect(WALKING_PROVIDER_MIN_INTERVAL_MS).toBe(400)
  const previousTime = Date.now()
  await session.evaluateRouteOrder(order)
  await session.buildRouteForOrder(order)
  expect(resolver).toHaveBeenCalledTimes(4)
  expect(Date.now()).toBe(previousTime)
  expect(jest.getTimerCount()).toBe(0)
})

test('concurrent duplicates share a pending provider response without waiting on another slot', async () => {
  let complete
  const resolver = jest.fn((from, to) => new Promise(resolve => { complete = () => resolve(success(from, to)) }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const first = session.evaluateRouteOrder(order)
  const duplicate = session.buildRouteForOrder(order)
  await jest.advanceTimersByTimeAsync(0)
  expect(resolver).toHaveBeenCalledTimes(1)
  expect(session.getCachedSegmentCosts()).toEqual([])
  complete()
  expect((await first).success).toBe(true)
  expect((await duplicate).success).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
})

test('500/1000 ms bounded retries go through the same limiter and eventual success is cached', async () => {
  const starts = []
  let attempts = 0
  const resolver = jest.fn(async (from, to) => {
    starts.push(Date.now())
    return ++attempts <= 2 ? limited : success(from, to)
  })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const pending = session.evaluateRouteOrder(order)
  const duplicate = session.buildRouteForOrder(order)
  await jest.advanceTimersByTimeAsync(0)
  expect(session.getCachedSegmentCosts()).toEqual([])
  await jest.runAllTimersAsync()
  expect((await pending).success).toBe(true)
  expect((await duplicate).success).toBe(true)
  expect(starts).toEqual([0, 500, 1500])
  await session.evaluateRouteOrder(order)
  expect(resolver).toHaveBeenCalledTimes(3)
  expect(session.getCachedSegmentCosts()[0].success).toBe(true)
})

test('retry starts respect queued requests as well as their backoff', async () => {
  const starts = []
  let first = true
  const resolver = jest.fn(async (from, to) => {
    starts.push(Date.now())
    if (first) { first = false; return limited }
    return success(from, to)
  })
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const pending = session.prefetchSegments(['A', 'B'])
  await jest.runAllTimersAsync()
  await pending
  expect(starts).toEqual([0, 400, 800, 1200, 1600])
})

test('a slow response does not block the next scheduled start or cause a burst', async () => {
  const completions = []
  const starts = []
  const resolver = jest.fn((from, to) => new Promise(resolve => {
    starts.push(Date.now())
    completions.push(() => resolve(success(from, to)))
  }))
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const pending = session.prefetchSegments(['A', 'B'])
  await jest.advanceTimersByTimeAsync(1200)
  expect(starts).toEqual([0, 400, 800, 1200])
  for (const complete of completions) complete()
  await pending
})

test('exhausted throttles remain temporary through optimizer and never become unreachable cost facts', async () => {
  const resolver = jest.fn(async () => limited)
  const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
  const pending = optimizeWaypointOrder({ session, waypointIds: ['A'] })
  await jest.runAllTimersAsync()
  expect(await pending).toMatchObject({ success: false, error: 'AMAP_RATE_LIMITED',
    failedSegment: { from: 'START', to: 'A', error: 'AMAP_RATE_LIMITED' } })
  expect(resolver).toHaveBeenCalledTimes(3)
  expect(session.getCachedSegmentCosts()).toEqual([])
  expect((await session.evaluateRouteOrder(order)).error).toBe('AMAP_RATE_LIMITED')
  expect(resolver).toHaveBeenCalledTimes(3)
})

test.each(['ROUTE_NOT_FOUND', 'WALKING_ROUTE_FAILED', 'INVALID_WALKING_ROUTE_RESPONSE'])(
  '%s is not automatically retried', async causeCode => {
    const resolver = jest.fn(async () => ({ success: false, error: 'WALKING_SEGMENT_FAILED', causeCode }))
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool, segmentResolver: resolver })
    const pending = session.evaluateRouteOrder(order)
    await jest.runAllTimersAsync()
    expect(await pending).toMatchObject({ failedSegment: { causeCode } })
    expect(resolver).toHaveBeenCalledTimes(1)
  }
)

test('cloud application rate-limit code survives walking-segment and engine normalization', async () => {
  global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue({ result: {
    success: false, error: { code: 'AMAP_RATE_LIMITED', message: 'Temporary rate limit' }
  } }) } }
  try {
    const session = createRoutePlanningSession({ start, verifiedWaypointPool: pool })
    const pending = session.evaluateRouteOrder(order)
    await jest.runAllTimersAsync()
    expect(await pending).toMatchObject({ error: 'AMAP_RATE_LIMITED' })
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(3)
  } finally { delete global.wx }
})
