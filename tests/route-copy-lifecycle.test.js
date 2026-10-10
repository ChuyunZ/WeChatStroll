const { preferences, history, copy, route, deferred, flush, setData } = require('./helpers/route-copy');
const { mockWalkRecords } = require('./helpers/walk-records');
const tap = id => ({ currentTarget: { dataset: { id } } });
const genericCopy = {
  title: '沿着自己的步调探索',
  description: '从当前位置出发，再返回起点。不妨给自己留一段悠闲的散步时光，带着探索的心情，按自己的步调换换心情。',
  recommendationReason: '结合你这次的散步偏好，可以把这条路线作为日常探索的选择，留一点自在安排的空间。'
};
let pages, storage, routeCopy, generation, requests, send, scheduler, walkRecords;
function pageAt(name) {
  let definition;
  global.Page = value => { definition = value; };
  require(`../miniprogram/pages/${name}/${name}`);
  const page = { ...definition, data: { ...definition.data } };
  page.setData = jest.fn(setData.bind(page)); pages.push(page); return page;
}
function eventChannel() {
  const handlers = {};
  return { handlers,
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    off: jest.fn((event, handler) => { if (handlers[event] === handler) delete handlers[event]; }),
    emit: jest.fn((event, value) => { if (handlers[event]) handlers[event](value); }) };
}
function alternative(id) {
  const r = route(id);
  r.pointsOfInterest = r.pointsOfInterest.map(p => ({ ...p, poiId: `${id}-${p.poiId}` }));
  r.editableWaypoints = r.pointsOfInterest;
  r.recommendedWaypointIds = r.pointsOfInterest.map(p => p.poiId);
  r.routeOrder.orderedWaypointIds = r.recommendedWaypointIds;
  return r;
}
beforeEach(() => {
  jest.resetModules(); jest.useFakeTimers(); pages = []; storage = {}; requests = [];
  global.wx = { navigateTo: jest.fn(), showToast: jest.fn(), navigateBack: jest.fn(), redirectTo: jest.fn(),
    getStorageSync: jest.fn(key => storage[key]), setStorageSync: jest.fn((key, value) => { storage[key] = value; }),
    removeStorageSync: jest.fn(key => { delete storage[key]; }) };
  walkRecords = mockWalkRecords(() => storage);
  jest.doMock('../miniprogram/services/walk-records', () => walkRecords);
  routeCopy = require('../miniprogram/services/route-copy');
  scheduler = routeCopy.createScheduler();
  send = jest.fn(() => { const p = deferred(); requests.push(p); return p.promise; });
  const create = routeCopy.createSession;
  jest.spyOn(routeCopy, 'createSession').mockImplementation(() => create({ scheduler, request: send }));
  generation = require('../miniprogram/services/route-generation');
});
afterEach(async () => {
  pages.slice().reverse().forEach(p => p.onUnload());
  requests.forEach(p => p.resolve({ success: false, error: { code: 'COPY_INVALID_OUTPUT' } }));
  await flush(); jest.restoreAllMocks(); jest.useRealTimers(); delete global.Page; delete global.wx;
});
async function setup({ holdRender = false, candidates = [] } = {}) {
  const { createRoutePlanningSession } = require('../miniprogram/services/route-engine');
  const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache');
  const initial = route(), pois = initial.pointsOfInterest;
  const session = createRoutePlanningSession({ start: initial.startPoint, routeType: 'loop', verifiedWaypointPool: pois,
    segmentResolver: async (from, to) => ({ success: true, durationSeconds: 600, distanceMeters: 900,
      polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude })) }) });
  const walkingRoute = await session.buildRouteForOrder({ allowedWaypointIds: initial.recommendedWaypointIds,
    orderedWaypointIds: initial.recommendedWaypointIds, source: 'recommended' });
  const raw = generation.buildGeneratedRouteFromAiCandidate({ location: initial.startPoint, walkingRoute, candidateIndex: 0 });
  const cache = createWaypointCandidateCache(candidates.map(r => ({ waypoints: r.pointsOfInterest })));
  jest.spyOn(generation, 'generateRoutes').mockResolvedValue({ status: 'success', routes: [raw],
    routePlanningSession: session, waypointCandidateCache: cache, location: initial.startPoint, historicalPreferenceProfile: history });
  const routes = pageAt('routes'), renders = [];
  if (holdRender) routes.setData.mockImplementation((data, done) => { setData.call(routes, data); if (done) renders.push(done); });
  routes.onLoad(); await flush();
  function openDetail() {
    const detail = pageAt('route-detail'), channel = eventChannel();
    detail.getOpenerEventChannel = () => channel;
    wx.navigateTo.mockImplementation(options => {
      Object.assign(channel.handlers, options.events);
      detail.onLoad({ id: raw.routeId, from: 'routes' }); options.success({ eventChannel: channel });
    });
    routes.viewRoute(tap(raw.routeId)); return { detail, channel };
  }
  return { routes, raw, session, cache, renders, openDetail };
}

test('first route renders and detail/start work before copy is sent or completed', async () => {
  const { routes, raw, renders, openDetail } = await setup({ holdRender: true });
  expect(routes.data.routeState).toBe('success'); expect(routes.data.routes[0].copySource).toBe('fallback');
  expect(send).not.toHaveBeenCalled();
  const { detail } = openDetail();
  expect(detail._confirmedRoute).toBe(raw); expect(detail.data.loading).toBe(false);
  renders.forEach(done => done()); await flush(); expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].historicalPreferenceProfile).toEqual(history);
  wx.navigateTo.mockImplementation(() => {});
  await detail.beginWalk(raw, false);
  expect(walkRecords.startWalk).toHaveBeenCalledTimes(1);
  expect(storage.activeWalkSession.route).toBe(raw);
  expect(routes.data.routeState).toBe('success');
});
test('AI updates an open detail and hidden Routes without rebuilding maps or changing references', async () => {
  const { routes, raw, openDetail } = await setup(); const { detail } = openDetail();
  const original = JSON.stringify(raw), map = detail.data.mapPolyline;
  const display = jest.spyOn(detail, 'displayRoute');
  requests[0].resolve({ success: true, copy }); await flush();
  expect(routes.data.routes[0]).toMatchObject({ ...copy, copySource: 'ai' });
  expect(detail.data.route).toMatchObject({ ...copy, copySource: 'ai' });
  expect(detail.data.mapPolyline).toBe(map); expect(display).not.toHaveBeenCalled();
  expect(routes._rawRoutes[0]).toBe(raw); expect(detail._confirmedRoute).toBe(raw);
  expect(JSON.stringify(raw)).toBe(original);
  detail.onUnload(); expect(routes._copySession.inspect().listeners).toBe(1);
  expect(routes.data.routes[0].title).toBe(copy.title);
});
test('preview rejects old overlay, cancel restores copy that arrived during preview, draft never sends', async () => {
  const { routes, raw, openDetail } = await setup(); const { detail } = openDetail();
  detail.enterRouteEdit(); detail.removeWaypoint(tap('poi-0')); detail.previewRoute(); await flush();
  expect(detail.data.hasPreview).toBe(true); expect(detail.data.route.copySource).toBe('fallback');
  expect(detail.data.route.description).not.toContain('人民公园');
  requests[0].resolve({ success: true, copy }); await flush();
  expect(detail.data.route.copySource).toBe('fallback'); expect(send).toHaveBeenCalledTimes(1);
  detail.cancelRouteEdit(); expect(detail.data.route).toMatchObject({ ...copy, copySource: 'ai' });
  expect(routes._rawRoutes[0]).toBe(raw); expect(detail._confirmedRoute).toBe(raw);
});
test('confirmed same-ID edit immediately drops all old text; late response cannot overwrite it', async () => {
  const { routes, raw, openDetail } = await setup(); const { detail } = openDetail();
  detail.enterRouteEdit(); detail.removeWaypoint(tap('poi-0')); detail.previewRoute(); await flush();
  const preview = detail._previewRoute;
  detail.confirmRouteEdit();
  expect(routes._rawRoutes[0]).toBe(preview); expect(preview.routeId).toBe(raw.routeId);
  expect(detail._confirmedRoute).toBe(preview);
  expect(detail.data.route.copySource).toBe('fallback');
  expect(routes.data.routes[0].copySource).toBe('fallback');
  for (const key of ['title', 'description', 'recommendationReason']) {
    expect(detail.data.route[key]).not.toContain('人民公园');
    expect(routes.data.routes[0][key]).not.toContain('人民公园');
  }
  requests[0].resolve({ success: true, copy }); await flush();
  expect(detail.data.route.copySource).toBe('fallback'); expect(send).toHaveBeenCalledTimes(2);
  requests[1].resolve({ success: true, copy: genericCopy }); await flush();
  expect(detail.data.route).toMatchObject({ ...genericCopy, copySource: 'ai' });
});
test('confirmed edit clears an already displayed AI copy even when replacement copy fails', async () => {
  const { routes, openDetail } = await setup(); const { detail } = openDetail();
  requests[0].resolve({ success: true, copy }); await flush();
  expect(detail.data.route.copySource).toBe('ai');
  detail.enterRouteEdit(); detail.removeWaypoint(tap('poi-0')); detail.previewRoute(); await flush();
  detail.confirmRouteEdit(); await flush();
  requests[1].resolve({ success: false, error: { code: 'COPY_INVALID_OUTPUT' } }); await flush();
  expect(detail.data.route.copySource).toBe('fallback');
  expect(JSON.stringify([detail.data.route.title, detail.data.route.description, detail.data.route.recommendationReason])).not.toContain('人民公园');
  expect(routes.data.routes[0].recommendationReason).toBe(detail.data.route.recommendationReason);
});
test('restoring original facts uses cache without another send, with a fallback render on confirm', async () => {
  const { openDetail } = await setup(); const { detail } = openDetail();
  requests[0].resolve({ success: true, copy }); await flush();
  detail.enterRouteEdit(); detail.removeWaypoint(tap('poi-0')); detail.previewRoute(); await flush();
  detail.confirmRouteEdit(); await flush(); requests[1].resolve({ success: true, copy: genericCopy }); await flush();
  detail.enterRouteEdit(); detail.restoreRecommendation(); await flush();
  detail.setData.mockClear(); detail.confirmRouteEdit(); await flush();
  expect(detail.setData.mock.calls.some(([update]) => update.route && update.route.copySource === 'fallback')).toBe(true);
  expect(detail.data.route).toMatchObject({ ...copy, copySource: 'ai' }); expect(send).toHaveBeenCalledTimes(2);
});
test('new questionnaire disposes old session; late old response cannot affect new page data', async () => {
  const { routes } = await setup(); const old = routes._copySession;
  routes.startCopySession(); await routes.loadRoutes(); await flush();
  expect(old.inspect()).toMatchObject({ disposed: true, listeners: 0, entries: 0 });
  requests[0].resolve({ success: true, copy }); await flush();
  expect(routes.data.routes[0].copySource).toBe('fallback'); expect(send).toHaveBeenCalledTimes(2);
  requests[1].resolve({ success: true, copy: genericCopy }); await flush();
  expect(routes.data.routes[0].title).toBe(genericCopy.title);
});
test('render callbacks and responses after unload are ignored and listeners removed', async () => {
  const { routes, renders, openDetail } = await setup({ holdRender: true }); const { detail, channel } = openDetail();
  const session = routes._copySession;
  detail.onUnload(); routes.onUnload();
  detail.setData.mockClear(); routes.setData.mockClear(); renders.forEach(done => done()); await flush();
  expect(send).not.toHaveBeenCalled(); expect(detail.setData).not.toHaveBeenCalled(); expect(routes.setData).not.toHaveBeenCalled();
  expect(session.inspect()).toMatchObject({ disposed: true, listeners: 0 });
  expect(channel.handlers.routeCopyContext).toBeUndefined();
});
test('AI text and metadata never enter actual walk snapshot, start request or storage', async () => {
  const { routes, raw, openDetail } = await setup(); const { detail } = openDetail();
  requests[0].resolve({ success: true, copy }); await flush();
  expect(detail.data.route.copySource).toBe('ai');
  wx.navigateTo.mockImplementation(() => {}); await detail.beginWalk(detail._confirmedRoute, false);
  const persisted = JSON.stringify([storage, walkRecords.startWalk.mock.calls, wx.setStorageSync.mock.calls]);
  for (const forbidden of [copy.title, copy.description, copy.recommendationReason, 'copySource', 'fingerprint', 'copy-session-']) {
    expect(persisted).not.toContain(forbidden);
  }
  expect(storage.activeWalkSession.route).toBe(raw);
  expect(routes._rawRoutes[0]).toBe(raw);
});
test('progressive and manual add/replace enqueue only routes actually accepted on screen', async () => {
  const alternatives = ['r2', 'r3', 'r4', 'r5'].map(alternative);
  const build = jest.spyOn(generation, 'buildOptimizedCandidateRoute').mockImplementation(async ({ candidateCache, candidate }) => {
    const r = alternatives.find(item => item.recommendedWaypointIds[0] === candidate.waypointIds[0]);
    candidateCache.markSuccess(candidate.candidateId, r); return { success: true, route: r };
  });
  const { routes, raw, cache } = await setup({ candidates: alternatives });
  await routes._initialFillPromise; await flush();
  expect(routes._rawRoutes).toHaveLength(3); expect(build).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(1); expect(routes._copySession.inspect().states.filter(s => s === 'queued')).toHaveLength(2);
  // Simulate a valid two-card result to exercise the existing Add path.
  routes._rawRoutes = [raw, alternatives[0]]; routes.renderRoutes();
  routes.updateManualAlternativeControls(); await routes.showOtherRoutes(); await flush();
  expect(routes._rawRoutes).toHaveLength(3); expect(routes._manualAlternativeActionCount).toBe(1);
  const old = routes._rawRoutes.find(r => r !== raw && r !== alternatives[0]);
  routes.showOtherRoutes(); await routes.selectRouteToReplace(tap(old.routeId)); await flush();
  expect(routes._rawRoutes).not.toContain(old); expect(routes._manualAlternativeActionCount).toBe(2);
  expect(cache.getUnusedCandidates()).toHaveLength(0);
  requests[0].resolve({ success: true, copy }); await flush();
  requests[1].resolve({ success: true, copy }); await flush();
  requests[2].resolve({ success: true, copy }); await flush();
  expect(send).toHaveBeenCalledTimes(3); // removed queued routes never spent budget
  expect(routes._copySession.inspect().sent).toBe(3);
});
test('validated deterministic fallback route also receives copy without replanning', async () => {
  const { routes, raw } = await setup();
  const fallback = { ...raw, routeId: 'generated_fallback_123' };
  routes._rawRoutes = [fallback]; routes.renderRoutes();
  requests[0].resolve({ success: true, copy }); await flush();
  expect(routes.data.routes[0].copySource).toBe('ai'); expect(generation.generateRoutes).toHaveBeenCalledTimes(1);
});
test('replacing a route with an in-flight copy rejects its late result', async () => {
  const { routes, raw } = await setup();
  const replacement = alternative('replacement');
  routes._rawRoutes = [replacement]; routes.renderRoutes(); await flush();
  expect(send).toHaveBeenCalledTimes(1); expect(routes.data.routes[0].copySource).toBe('fallback');
  requests[0].resolve({ success: true, copy }); await flush();
  expect(routes.data.routes[0].routeId).toBe(replacement.routeId);
  expect(routes.data.routes[0].copySource).toBe('fallback');
  expect(routes._copySession.get(raw)).toBeNull();
  requests[1].resolve({ success: true, copy: genericCopy }); await flush();
  expect(routes.data.routes[0].title).toBe(genericCopy.title);
});
test('failed manual replacement preserves the original route and accepted copy', async () => {
  const extra = alternative('unused');
  jest.spyOn(generation, 'buildOptimizedCandidateRoute').mockResolvedValue({ success: false, error: 'NO_COMPLETE_ROUTE' });
  const { routes, raw } = await setup();
  requests[0].resolve({ success: true, copy }); await flush();
  const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache');
  routes._waypointCandidateCache = createWaypointCandidateCache([{ waypoints: extra.pointsOfInterest }]);
  routes._rawRoutes = [raw, alternative('other1'), alternative('other2')]; routes.renderRoutes();
  routes.updateManualAlternativeControls(); routes.showOtherRoutes();
  await routes.selectRouteToReplace(tap(raw.routeId)); await flush();
  expect(routes._rawRoutes).toContain(raw);
  expect(routes.data.routes.find(r => r.routeId === raw.routeId)).toMatchObject({ ...copy, copySource: 'ai' });
  expect(routes._manualAlternativeActionCount).toBe(0);
});
test('unload during request detaches both pages; settlement never calls setData', async () => {
  const { routes, openDetail } = await setup(); const { detail } = openDetail();
  detail.onUnload(); routes.onUnload(); detail.setData.mockClear(); routes.setData.mockClear();
  expect(scheduler.inspect().inFlight).toBe(true);
  requests[0].resolve({ success: true, copy }); await flush();
  expect(detail.setData).not.toHaveBeenCalled(); expect(routes.setData).not.toHaveBeenCalled();
});
test('unknown execution pauses copy while detail editing stays usable', async () => {
  const { routes, openDetail } = await setup(); const { detail } = openDetail();
  requests[0].reject(new Error('connection lost')); await flush();
  expect(scheduler.inspect().paused).toBe(true);
  detail.enterRouteEdit(); detail.removeWaypoint(tap('poi-0')); detail.previewRoute(); await flush();
  detail.confirmRouteEdit(); await flush();
  expect(detail.data.editing).toBe(false); expect(detail.data.route.copySource).toBe('fallback');
  expect(routes.data.routeState).toBe('success'); expect(send).toHaveBeenCalledTimes(1);
});
test('compatibility navigation never promotes an AI display object to a business route', async () => {
  const { routes, raw } = await setup();
  requests[0].resolve({ success: true, copy }); await flush();
  routes._rawRoutes = []; routes.viewRoute(tap(raw.routeId));
  expect(wx.navigateTo).not.toHaveBeenCalled(); expect(wx.showToast).toHaveBeenCalled();
});

test('Routes and open Detail agree when async duplicate titles arrive and card order changes', async () => {
  const { routes, raw, openDetail } = await setup();
  const other = alternative('duplicate-detail');
  routes._rawRoutes = [raw, other]; routes.renderRoutes(); await flush();
  const { detail } = openDetail();
  expect(detail.data.route.copySource).toBe('fallback');
  requests[0].resolve({ success: true, copy }); await flush();
  requests[1].resolve({ success: true, copy: { ...copy, title: copy.title + '！' } }); await flush();
  expect(detail.data.route.copySource).toBe('ai');
  expect(routes.data.routes.find(r => r.routeId === raw.routeId).title).toBe(detail.data.route.title);
  expect(new Set(routes.data.routes.map(r => r.title)).size).toBe(2);

  // Reordering should transfer the displayed AI title deterministically.
  routes._rawRoutes = [other, raw]; routes.renderRoutes(); await flush();
  const display = routes.data.routes.find(r => r.routeId === raw.routeId);
  expect(display.copySource).toBe('fallback');
  expect(detail.data.route).toMatchObject({
    title: display.title, description: display.description,
    recommendationReason: display.recommendationReason, copySource: 'fallback'
  });
  expect(new Set(routes.data.routes.map(r => r.title)).size).toBe(2);
  expect(send).toHaveBeenCalledTimes(2);

  routes._rawRoutes = [raw, other]; routes.renderRoutes(); await flush();
  expect(detail.data.route.copySource).toBe('ai');
  expect(detail.data.route.title).toBe(routes.data.routes[0].title);
});
