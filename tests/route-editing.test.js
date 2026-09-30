jest.mock('../miniprogram/services/cloud-function-client', () => ({ callCloudFunction: jest.fn() }))
jest.mock('../miniprogram/services/waypoint-order-optimizer', () => ({ optimizeWaypointOrder: jest.fn() }))

const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const generation = require('../miniprogram/services/route-generation')
const { isValidEditableOrder } = require('../miniprogram/services/route-editing')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')

const start = { latitude: 30, longitude: 120 }
const pois = ['A', 'B', 'C', 'X'].map((poiId, index) => ({
  poiId, name: `地点 ${poiId}`, category: 'park', latitude: 30.01 + index / 100,
  longitude: 120, address: `${poiId} 路 1 号`, distanceInMeters: 800 + index * 100,
  providerMeta: { type: '公园广场;公园', typecode: '110101' }
}))
const tap = (id, direction) => ({ currentTarget: { dataset: { id, direction } } })
const flush = () => new Promise(resolve => setImmediate(resolve))

function pageAt(name) {
  let definition
  global.Page = value => { definition = value }
  const modulePath = `../miniprogram/pages/${name}/${name}`
  jest.isolateModules(() => require(modulePath))
  const page = { ...definition, data: { ...definition.data } }
  page.setData = jest.fn(updates => Object.assign(page.data, updates))
  return page
}

async function setup(routeType = 'point_to_point', count = 3) {
  const resolver = jest.fn(async (from, to) => ({
    success: true, durationSeconds: 600, distanceMeters: 800,
    polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude }))
  }))
  const session = createRoutePlanningSession({ start, routeType,
    verifiedWaypointPool: pois, segmentResolver: resolver })
  const ids = pois.slice(0, count).map(poi => poi.poiId)
  const walkingRoute = await session.buildRouteForOrder({
    allowedWaypointIds: ids, orderedWaypointIds: ids, source: 'recommended'
  })
  const route = generation.buildGeneratedRouteFromAiCandidate({ location: start, walkingRoute, candidateIndex: 0 })
  const routes = pageAt('routes')
  routes._rawRoutes = [route]
  routes._routePlanningSession = session
  routes._routeRequestId = 1
  routes.setData({ routes: routes.prepareRoutes([route]) })
  const detail = pageAt('route-detail')
  const handlers = {}
  const channel = {
    on: jest.fn((event, handler) => { handlers[event] = handler }),
    off: jest.fn((event) => { delete handlers[event] }),
    emit: jest.fn((event, value) => handlers[event] && handlers[event](value))
  }
  detail.getOpenerEventChannel = () => channel
  wx.navigateTo.mockImplementation(options => {
    Object.assign(handlers, options.events)
    detail.onLoad({ id: route.routeId, from: 'routes' })
    options.success({ eventChannel: channel })
  })
  routes.viewRoute(tap(route.routeId))
  return { session, resolver, route, routes, detail, channel, handlers, walkingRoute }
}

beforeEach(() => {
  jest.clearAllMocks()
  global.wx = { navigateTo: jest.fn(), showToast: jest.fn(), navigateBack: jest.fn() }
})
afterEach(() => { delete global.Page; delete global.wx })

test('generated metadata is copied from verified POIs and recommendation is editable by default', async () => {
  const { route, detail } = await setup()
  expect(route.editableWaypoints).toEqual(pois.slice(0, 3))
  expect(route.editableWaypoints[0].providerMeta).not.toBe(pois[0].providerMeta)
  expect(route.routeOrder).toEqual({ source: 'recommended', orderedWaypointIds: ['A', 'B', 'C'] })
  expect(detail.data.canEdit).toBe(true)
  expect(detail.data.editing).toBe(false)
  expect(detail.data.route.routeOrder.source).toBe('recommended')
  detail.enterRouteEdit()
  expect(detail.data.draftWaypointIds).toEqual(['A', 'B', 'C'])
  expect(detail.data.draftWaypointIds).not.toBe(route.routeOrder.orderedWaypointIds)
  expect(detail.data.activeWaypoints[0]).toMatchObject({ ...pois[0], categoryLabel: '公园', hasDistance: true })
})

test('moving, removing and adding back affect only the draft and keep the final active stop', async () => {
  const { detail, route } = await setup()
  const original = JSON.stringify(route)
  detail.enterRouteEdit()
  detail.moveWaypoint(tap('C', -1))
  expect(detail.data.draftWaypointIds).toEqual(['A', 'C', 'B'])
  detail.moveWaypoint(tap('A', 1))
  expect(detail.data.draftWaypointIds).toEqual(['C', 'A', 'B'])
  expect(detail.data.activeWaypoints.filter(poi => poi.isDestination).map(poi => poi.poiId)).toEqual(['B'])
  detail.removeWaypoint(tap('B'))
  detail.removeWaypoint(tap('A'))
  detail.removeWaypoint(tap('C'))
  expect(detail.data.draftWaypointIds).toEqual(['C'])
  expect(detail.data.removedWaypoints).toHaveLength(2)
  expect(detail.data.removedWaypoints[0]).toMatchObject(pois[0])
  detail.addWaypoint(tap('X'))
  detail.addWaypoint(tap('invented'))
  detail.addWaypoint(tap('C'))
  expect(detail.data.draftWaypointIds).toEqual(['C'])
  detail.addWaypoint(tap('B'))
  expect(detail.data.draftWaypointIds).toEqual(['C', 'B'])
  expect(JSON.stringify(route)).toBe(original)
  expect(detail._confirmedRoute).toBe(route)
  expect(detail.data.route.pointsOfInterest.map(poi => poi.poiId)).toEqual(['A', 'B', 'C'])
})

test.each(['point_to_point', 'loop', 'out_and_back'])('preview and confirm %s preserve pool, engine facts and endpoint semantics', async routeType => {
  const { detail, routes, route, session } = await setup(routeType)
  const build = jest.spyOn(session, 'buildRouteForOrder')
  detail.enterRouteEdit()
  detail.updateDraft(['C', 'A'])
  detail.previewRoute()
  detail.previewRoute()
  expect(detail.data.previewLoading).toBe(true)
  detail.confirmRouteEdit()
  expect(routes._rawRoutes[0]).toBe(route)
  await flush()
  expect(build).toHaveBeenCalledTimes(1)
  expect(build).toHaveBeenCalledWith({ allowedWaypointIds: ['A', 'B', 'C'], orderedWaypointIds: ['C', 'A'], source: 'user' })
  const preview = detail._previewRoute
  expect(detail.data.hasPreview).toBe(true)
  expect(preview.pointsOfInterest.map(poi => poi.poiId)).toEqual(['C', 'A'])
  expect(preview.editableWaypoints).toEqual(route.editableWaypoints)
  expect(preview.recommendedWaypointIds).toEqual(['A', 'B', 'C'])
  expect(preview.endPoint).toMatchObject(routeType === 'point_to_point' ?
    { name: pois[0].name, latitude: pois[0].latitude } : start)
  const expectedMinutes = routeType === 'point_to_point' ? 20 : routeType === 'loop' ? 30 : 40
  expect(detail.data.route.durationMinutes).toBe(expectedMinutes)
  expect(detail.data.route.distanceMeters).toBe(expectedMinutes * 80)
  expect(detail.data.route.durationDifference).toBe(expectedMinutes - route.durationMinutes)
  expect(detail.data.mapPolyline[0].points).toEqual(preview.polyline)
  expect(detail._confirmedRoute).toBe(route)
  expect(routes._rawRoutes[0]).toBe(route)
  expect(optimizeWaypointOrder).not.toHaveBeenCalled()
  expect(callCloudFunction).not.toHaveBeenCalled()
  detail.confirmRouteEdit()
  expect(detail.data.editing).toBe(false)
  expect(detail._confirmedRoute).toBe(preview)
  expect(preview.routeOrder.source).toBe('user')
  expect(routes._rawRoutes[0]).toBe(preview)
  expect(routes.data.routes[0].durationMinutes).toBe(expectedMinutes)
  expect(routes.data.routes[0].previewPolyline[0].points).toEqual(preview.polyline)
  expect(routes._routePlanningSession).toBe(session)
  expect(routes.data.routePlanningSession).toBeUndefined()
  // Reopening uses the confirmed subset and can restore the full recommendation.
  routes.viewRoute(tap(route.routeId))
  detail.enterRouteEdit()
  expect(detail.data.draftWaypointIds).toEqual(['C', 'A'])
  detail.restoreRecommendation()
  await flush()
  expect(build).toHaveBeenLastCalledWith({ allowedWaypointIds: ['A', 'B', 'C'], orderedWaypointIds: ['A', 'B', 'C'], source: 'user' })
  expect(detail.data.draftWaypointIds).toEqual(['A', 'B', 'C'])
  expect(detail.data.removedWaypoints).toEqual([])
  expect(detail._confirmedRoute).toBe(preview)
})

test('cancel restores the confirmed map and one active waypoint remains editable after confirmation', async () => {
  const { detail, route, routes } = await setup()
  detail.enterRouteEdit()
  detail.updateDraft(['B'])
  detail.previewRoute()
  await flush()
  detail.cancelRouteEdit()
  expect(detail.data.mapPolyline[0].points).toEqual(route.polyline)
  expect(detail.data.route.routeOrder.source).toBe('recommended')
  detail.enterRouteEdit()
  detail.updateDraft(['B'])
  detail.previewRoute()
  await flush()
  detail.confirmRouteEdit()
  routes.viewRoute(tap(route.routeId))
  expect(detail.data.route.editableWaypoints).toHaveLength(3)
  expect(detail.data.route.routeOrder.orderedWaypointIds).toEqual(['B'])
  detail.enterRouteEdit()
  expect(detail.data.canEdit).toBe(true)
  expect(detail.data.draftWaypointIds).toEqual(['B'])
  expect(detail.data.removedWaypoints).toHaveLength(2)
  detail.addWaypoint(tap('A'))
  expect(detail.data.draftWaypointIds).toEqual(['B', 'A'])
})

test.each([[], ['A', 'A'], ['A', 'X'], ['fake'], [1], null])('route boundary rejects invalid request %j before invoking the engine', async ids => {
  const { route, session, handlers, channel } = await setup()
  const build = jest.spyOn(session, 'buildRouteForOrder')
  expect(isValidEditableOrder(route, ids)).toBe(false)
  await handlers.previewRoute({ routeId: route.routeId, orderedWaypointIds: ids, requestId: 1 })
  expect(build).not.toHaveBeenCalled()
  expect(channel.emit).toHaveBeenLastCalledWith('routePreviewResult', expect.objectContaining({ message: expect.any(String) }))
})

test('a single-waypoint editable pool does not offer or allow editing', async () => {
  const { detail } = await setup('point_to_point', 1)
  expect(detail.data.canEdit).toBe(false)
  detail.enterRouteEdit()
  expect(detail.data.editing).toBe(false)
  expect(detail.data.draftWaypointIds).toEqual([])
})

test.each([2, 3])('supports a variable pool of %i waypoints', async count => {
  const { detail } = await setup('point_to_point', count)
  detail.enterRouteEdit()
  expect(detail.data.activeWaypoints).toHaveLength(count)
  detail.updateDraft(['A'])
  detail.removeWaypoint(tap('A'))
  expect(detail.data.draftWaypointIds).toEqual(['A'])
})

test.each([
  { success: false, error: 'MULTI_SEGMENT_ROUTE_FAILED', message: 'secret provider payload' },
  { success: false, error: 'AMAP_RATE_LIMITED' }
])('failed preview remains recoverable and preserves confirmed route (%j)', async failure => {
  const { detail, session, route, routes } = await setup()
  jest.spyOn(session, 'buildRouteForOrder').mockResolvedValueOnce(failure)
  detail.enterRouteEdit()
  detail.updateDraft(['B', 'A'])
  detail.previewRoute()
  await flush()
  expect(detail.data.previewLoading).toBe(false)
  expect(detail.data.hasPreview).toBe(false)
  expect(detail.data.editing).toBe(true)
  expect(detail.data.draftWaypointIds).toEqual(['B', 'A'])
  expect(detail._confirmedRoute).toBe(route)
  expect(routes._rawRoutes[0]).toBe(route)
  expect(detail.data.editMessage).toContain(failure.error === 'AMAP_RATE_LIMITED' ? '繁忙' : '调整地点')
  expect(detail.data.editMessage).not.toContain('secret')
  detail.restoreRecommendation()
  await flush()
  expect(detail.data.hasPreview).toBe(true)
})

test('explicit route outside duration tolerance is previewable', async () => {
  const { detail, session, walkingRoute } = await setup()
  jest.spyOn(session, 'buildRouteForOrder').mockResolvedValue({ ...walkingRoute,
    durationSeconds: 9000, durationMinutes: 150, distanceMeters: 10000 })
  detail.enterRouteEdit()
  detail.previewRoute()
  await flush()
  expect(detail.data.route.durationMinutes).toBe(150)
  expect(detail.data.hasPreview).toBe(true)
})

test('rebuild preserves identity and recommendation metadata while replacing all walking facts', async () => {
  const { route, session } = await setup()
  const baseRoute = { ...route, candidateWaypointIds: ['C', 'A', 'B'],
    optimization: { strategy: 'exact' }, planning: { attempts: 1 },
    environmentStats: { old: true } }
  const snapshot = JSON.stringify(baseRoute)
  const walkingRoute = await session.buildRouteForOrder({
    allowedWaypointIds: ['A', 'B', 'C'], orderedWaypointIds: ['B'], source: 'user'
  })
  const rebuilt = generation.rebuildGeneratedRouteForOrder({ baseRoute, walkingRoute })
  for (const field of ['routeId', 'startPoint', 'editableWaypoints', 'recommendedWaypointIds',
    'recommendedDurationMinutes', 'recommendationReason', 'candidateWaypointIds', 'optimization', 'planning']) {
    expect(rebuilt[field]).toEqual(baseRoute[field])
  }
  for (const field of ['durationSeconds', 'durationMinutes', 'distanceMeters', 'polyline', 'environmentStats']) {
    expect(rebuilt[field]).toEqual(walkingRoute[field])
  }
  expect(rebuilt.pointsOfInterest).toHaveLength(1)
  expect(rebuilt.pointsOfInterest[0]).toMatchObject(pois[1])
  expect(JSON.stringify(baseRoute)).toBe(snapshot)
  expect(() => generation.rebuildGeneratedRouteForOrder({ baseRoute,
    walkingRoute: { ...walkingRoute, routeOrder: { orderedWaypointIds: ['X'] } } })).toThrow()
})

test('preview and restore reuse the same directed segment cache', async () => {
  const { detail, resolver } = await setup()
  expect(resolver).toHaveBeenCalledTimes(3)
  detail.enterRouteEdit()
  detail.updateDraft(['A', 'C'])
  detail.previewRoute()
  await flush()
  expect(resolver).toHaveBeenCalledTimes(4) // Only A -> C is new.
  detail.confirmRouteEdit()
  detail.enterRouteEdit()
  detail.restoreRecommendation()
  await flush()
  expect(resolver).toHaveBeenCalledTimes(4)
  expect(detail.data.route.durationMinutes).toBe(30)
})

test.each(['cancel', 'edit', 'unload', 'session'])('pending preview cannot overwrite state after %s', async action => {
  const { detail, session, walkingRoute, route, routes } = await setup()
  let resolve
  jest.spyOn(session, 'buildRouteForOrder').mockImplementation(() => new Promise(done => { resolve = done }))
  detail.enterRouteEdit()
  detail.previewRoute()
  if (action === 'cancel') detail.cancelRouteEdit()
  if (action === 'edit') detail.updateDraft(['C'])
  if (action === 'unload') detail.onUnload()
  if (action === 'session') routes.onUnload()
  resolve(walkingRoute)
  await flush()
  expect(detail._previewRoute).toBeNull()
  expect(detail._confirmedRoute).toBe(route)
  expect(routes._rawRoutes[0]).toBe(route)
})

test('late response is ignored after a newer successful preview', async () => {
  const { detail, session, walkingRoute } = await setup()
  let resolve
  jest.spyOn(session, 'buildRouteForOrder').mockImplementationOnce(() => new Promise(done => { resolve = done }))
  detail.enterRouteEdit()
  detail.previewRoute()
  detail.updateDraft(['B'])
  detail.previewRoute()
  await flush()
  const preview = detail._previewRoute
  resolve(walkingRoute)
  await flush()
  expect(detail._previewRoute).toBe(preview)
  expect(detail.data.route.pointsOfInterest.map(poi => poi.poiId)).toEqual(['B'])
})

test('confirmation accepts only the latest built preview, not supplied route facts', async () => {
  const { handlers, routes, route, detail } = await setup()
  const confirmedDisplay = {
    route: detail.data.route,
    mapPolyline: detail.data.mapPolyline,
    markers: detail.data.markers,
    mapPoints: detail.data.mapPoints
  }
  handlers.confirmRoute({ routeId: route.routeId, requestId: 100, route: { durationMinutes: 1 } })
  expect(routes._rawRoutes[0]).toBe(route)
  detail.enterRouteEdit()
  detail.updateDraft(['B'])
  detail.previewRoute()
  await flush()
  expect(detail.data.hasPreview).toBe(true)
  expect(detail.data.route.routeOrder.orderedWaypointIds).toEqual(['B'])
  expect(detail.data.mapPolyline).not.toEqual(confirmedDisplay.mapPolyline)
  routes.onUnload()
  detail.confirmRouteEdit()
  expect(detail.data.editing).toBe(true)
  expect(detail.data.confirming).toBe(false)
  expect(detail.data.editMessage).toContain('过期')
  expect(detail._confirmedRoute).toBe(route)
  expect(routes._rawRoutes[0]).toBe(route)
  expect(detail._previewRoute).toBeNull()
  expect(detail.data.hasPreview).toBe(false)
  expect(detail.data.draftWaypointIds).toEqual(['B'])
  expect(detail.data).toMatchObject(confirmedDisplay)
  detail.addWaypoint(tap('A'))
  expect(detail.data.draftWaypointIds).toEqual(['B', 'A'])
})

test('editing template exposes trusted metadata, removed stops, destination and disabled actions', () => {
  const fs = require('fs')
  const template = fs.readFileSync(require('path').join(__dirname,
    '../miniprogram/pages/route-detail/route-detail.wxml'), 'utf8')
  expect(template).toMatch(/<view class="content-card" wx:if="{{canEdit}}">\s*<text class="card-title">路线地点<\/text>\s*<button[^>]*bindtap="enterRouteEdit"/)
  for (const field of ['poi.address', 'poi.providerMeta.type', 'poi.distanceInMeters',
    'poi.isDestination', 'removedWaypoints', 'activeWaypoints.length === 1', 'route.durationDifference']) {
    expect(template).toContain(field)
  }
})
