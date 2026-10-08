const {
  mockRoutes
} = require("../miniprogram/data/mock-routes");

const ROUTE_GENERATION_PATH =
  "../miniprogram/services/route-generation";

const ROUTE_LOCATION = {
  latitude: 23.129158,
  longitude: 113.264939
};

const GENERATED_ROUTE = {
  routeId: "generated_park-1_123",
  recommendedWaypointIds: ["A"],
  title: "前往人民公园的散步路线",
  durationMinutes: 4,
  distanceMeters: 279,
  routeType: "point_to_point",
  returnsToStart: false,
  crowdLevel: "unknown",
  tags: [
    "公园"
  ],
  description:
    "从当前位置步行前往人民公园的真实路线。",
  recommendationReason:
    "根据你的散步环境偏好排序，推荐前往人民公园。",

  startPoint: {
    name: "当前位置",
    latitude: 23.129158,
    longitude: 113.264939
  },

  endPoint: {
    name: "人民公园",
    latitude: 23.127159,
    longitude: 113.264345
  },

  polyline: [
    {
      latitude: 23.129158,
      longitude: 113.264939
    },
    {
      latitude: 23.128,
      longitude: 113.2646
    },
    {
      latitude: 23.127159,
      longitude: 113.264345
    }
  ],

  pointsOfInterest: [
    {
      name: "人民公园",
      type: "park",
      latitude: 23.127159,
      longitude: 113.264345
    }
  ],

  updatedAt:
    "2026-09-05T00:00:00.000Z"
};


let pageDefinition;
let page;
let routeGenerationServiceMock;


function createDeferred() {
  let resolve;
  let reject;

  const promise =
    new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

  return {
    promise,
    resolve,
    reject
  };
}


function createEventChannel() {
  const handlers = {};

  return {
    handlers,

    on: jest.fn(
      (eventName, handler) => {
        handlers[eventName] =
          handler;
      }
    )
  };
}


function createRoutePlanningSessionMock() {
  return {
    registerVerifiedWaypoints:
      jest.fn(),

    prefetchSegments:
      jest.fn(),

    evaluateRouteOrder: jest.fn(),
    getWaypointSearchData: jest.fn(),
    getCachedSegmentCosts: jest.fn(),

    buildRouteForOrder:
      jest.fn()
  };
}


function createWaypointCandidateCacheMock({
  unusedCandidates = []
} = {}) {
  return {
    getUnusedCandidates:
      jest.fn(
        () => unusedCandidates
      ),

    markBuilding:
      jest.fn(),

    markSuccess:
      jest.fn(),

    markFailed:
      jest.fn(),

    getSuccessfulRoutes:
      jest.fn(
        () => []
      )
  };
}


function createSuccessfulRouteLoadResult({
  routes = [
    GENERATED_ROUTE
  ],
  routePlanningSession =
    createRoutePlanningSessionMock(),
  waypointCandidateCache =
    createWaypointCandidateCacheMock(),
  location =
    ROUTE_LOCATION
} = {}) {
  return {
    routes,
    routePlanningSession,
    waypointCandidateCache,
    location
  };
}


function loadRoutesPage({
  eventChannel = null
} = {}) {
  jest.resetModules();

  pageDefinition = null;

  routeGenerationServiceMock = {
    logCandidateSummary: jest.fn(),
    generateRoutes:
      jest.fn(),

    buildGeneratedRouteFromAiCandidate:
      jest.fn(),

    buildOptimizedCandidateRoute:
      jest.fn()
  };

  jest.doMock(
    ROUTE_GENERATION_PATH,
    () =>
      routeGenerationServiceMock
  );


  global.Page =
    jest.fn((definition) => {
      pageDefinition =
        definition;
    });


  global.wx = {
    navigateTo:
      jest.fn(),

    redirectTo:
      jest.fn(),

    showToast:
      jest.fn()
  };


  require(
    "../miniprogram/pages/routes/routes"
  );


  const pageInstance = {
    ...pageDefinition,

    data: {
      ...pageDefinition.data
    }
  };


  pageInstance.setData =
    jest.fn((updates) => {
      pageInstance.data = {
        ...pageInstance.data,
        ...updates
      };
    });


  pageInstance.getOpenerEventChannel =
    jest.fn(
      () => eventChannel
    );


  return pageInstance;
}


describe('progressive initial route loading', () => {
  function setup() {
    const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache');
    const cache = createWaypointCandidateCache(['A', 'B', 'C', 'D', 'E'].map(poiId => ({ waypoints: [{ poiId }] })));
    cache.markBuilding('candidate-1');
    cache.markSuccess('candidate-1', GENERATED_ROUTE);
    const pending = [];
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementation(options => {
      expect(cache.markBuilding(options.candidate.candidateId)).toBe(true);
      const deferred = createDeferred();
      pending.push({ options, ...deferred });
      return deferred.promise.then(result => {
        if (result.success) {
          result.route.recommendedWaypointIds = [...options.candidate.waypointIds];
          cache.markSuccess(options.candidate.candidateId, result.route);
        }
        else cache.markFailed(options.candidate.candidateId);
        return result;
      });
    });
    page.getRoutes = jest.fn().mockResolvedValue(createSuccessfulRouteLoadResult({ waypointCandidateCache: cache }));
    return { cache, pending };
  }

  async function settle(entry, result) {
    entry.resolve(result);
    await entry.promise;
    // Drain the service settlement and page continuation.
    await Promise.resolve();
    await Promise.resolve();
  }

  test('first route stays usable while later routes append, failed candidates are skipped, and display stops at three', async () => {
    const { cache, pending } = setup();
    await page.loadRoutes();
    expect(page.data.routeState).toBe('success');
    expect(page.data.routes).toHaveLength(1);
    expect(page.data.isLoadingMoreRoutes).toBe(true);
    expect(page.data.manualAlternativeAction).toBe('');
    page.viewRoute({ currentTarget: { dataset: { id: GENERATED_ROUTE.routeId } } });
    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
    await page.showOtherRoutes();
    await page.showOtherRoutes();
    expect(pending).toHaveLength(1);
    await settle(pending[0], { success: false, error: 'PROVIDER_RATE_LIMITED' });
    expect(page.data.routes).toHaveLength(1);
    await settle(pending[1], { success: true, route: { ...GENERATED_ROUTE, routeId: 'second' } });
    expect(page.data.routes).toHaveLength(2);
    await settle(pending[2], { success: true, route: { ...GENERATED_ROUTE, routeId: 'third' } });
    await page._initialFillPromise;
    expect(page.data.routes.map(route => route.routeId)).toEqual([GENERATED_ROUTE.routeId, 'second', 'third']);
    expect(page.data.isLoadingMoreRoutes).toBe(false);
    expect(cache.getUnusedCandidates()).toHaveLength(1);
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(3);
  });

  test.each(['reload', 'unload', 'preferences'])('stale fill after %s cannot change page data or claim another candidate', async action => {
    const { pending } = setup();
    await page.loadRoutes();
    const oldFill = page._initialFillPromise;
    if (action === 'reload') {
      page.getRoutes.mockResolvedValue(createSuccessfulRouteLoadResult());
      await page.loadRoutes();
    } else if (action === 'unload') page.onUnload();
    else page.changePreferences();
    const calls = page.setData.mock.calls.length;
    await settle(pending[0], { success: true, route: { ...GENERATED_ROUTE, routeId: 'stale' } });
    await oldFill;
    expect(page.setData).toHaveBeenCalledTimes(calls);
    expect(page.data.routes.some(route => route.routeId === 'stale')).toBe(false);
    expect(pending).toHaveLength(1);
  });

  test('background exceptions preserve the first route and clear the loading-more state', async () => {
    const { pending } = setup();
    await page.loadRoutes();
    pending[0].reject(new Error('test failure'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    for (let i = 1; i < 4; i++) {
      await settle(pending[i], { success: false });
    }
    await page._initialFillPromise;
    expect(page.data.routeState).toBe('success');
    expect(page.data.routes).toHaveLength(1);
    expect(page.data.isLoadingMoreRoutes).toBe(false);
  });

  test('progressive ranking renders immediately, reranks each success and never scores a failure', async () => {
    const { pending } = setup();
    const ranking = require('../miniprogram/services/route-ranking');
    const rank = jest.spyOn(ranking, 'rankRoutes');
    const first = { ...GENERATED_ROUTE, durationSeconds: 2100 };
    const second = { ...GENERATED_ROUTE, routeId: 'second', durationSeconds: 1920 };
    const third = { ...GENERATED_ROUTE, routeId: 'third', durationSeconds: 1800 };
    const initial = await page.getRoutes();
    page.getRoutes.mockResolvedValue({ ...initial, routes: [first] });
    page._routePreferences = { durationMinutes: 30 };
    await page.loadRoutes();
    expect(page.data.routeState).toBe('success');
    expect(page.data.routes).toHaveLength(1);
    expect(page.data.routes[0].isBestMatch).toBe(false);
    page.viewRoute({ currentTarget: { dataset: { id: first.routeId } } });
    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
    await settle(pending[0], { success: false, route: { ...first, routeId: 'invalid' } });
    expect(rank).toHaveBeenCalledTimes(1);
    await settle(pending[1], { success: true, route: second });
    expect(page._rawRoutes).toEqual([second, first]);
    expect(page.data.routes.map(route => route.isBestMatch)).toEqual([true, false]);
    await settle(pending[2], { success: true, route: third });
    await page._initialFillPromise;
    expect(page._rawRoutes).toEqual([third, second, first]);
    expect(rank).toHaveBeenCalledTimes(3);
    expect(page.data.routes.map(route => route.isBestMatch)).toEqual([true, false, false]);
    expect(page._rawRoutes.every(route => !('isBestMatch' in route) && !('totalScore' in route))).toBe(true);
  });

  test('an open route detail remains current when a better background route reranks ahead of it', async () => {
    const { pending } = setup();
    const first = {
      ...GENERATED_ROUTE,
      durationSeconds: 2100,
      editableWaypoints: [{ poiId: 'A' }]
    };
    const second = {
      ...GENERATED_ROUTE,
      routeId: 'second',
      durationSeconds: 1800,
      editableWaypoints: [{ poiId: 'B' }]
    };
    const initial = await page.getRoutes();
    page.getRoutes.mockResolvedValue({ ...initial, routes: [first] });
    page._routePreferences = { durationMinutes: 30 };

    await page.loadRoutes();
    const session = page._routePlanningSession;
    page.viewRoute({ currentTarget: { dataset: { id: first.routeId } } });
    const navigateOptions = wx.navigateTo.mock.calls[0][0];

    await settle(pending[0], { success: true, route: second });
    expect(page._rawRoutes).toEqual([second, first]);
    expect(page._rawRoutes).toContain(first);

    await navigateOptions.events.previewRoute({
      routeId: first.routeId,
      orderedWaypointIds: ['A'],
      requestId: 1
    });
    expect(session.buildRouteForOrder).toHaveBeenCalledWith({
      allowedWaypointIds: ['A'],
      orderedWaypointIds: ['A'],
      source: 'user'
    });

    for (let index = 1; index < 4; index++) {
      await settle(pending[index], { success: false });
    }
    await page._initialFillPromise;
  });
});

describe('bounded manual alternatives', () => {
  const tap = id => ({ currentTarget: { dataset: { id } } });
  const route = (ids, id = ids.join('-')) => ({ ...GENERATED_ROUTE,
    routeId: id, recommendedWaypointIds: ids, durationSeconds: 1800 });

  function setup(count = 1, sets = [['A', 'B'], ['A', 'C'], ['A', 'D'], ['A', 'E']]) {
    const { createWaypointCandidateCache } = require('../miniprogram/services/waypoint-candidate-cache');
    const cache = createWaypointCandidateCache(sets.map(ids => ({ waypoints: ids.map(poiId => ({ poiId })) })));
    page.resetManualAlternatives();
    page._initialCandidateProcessingComplete = true;
    page._routeRequestId = (page._routeRequestId || 0) + 1;
    page._routePlanningSession = createRoutePlanningSessionMock();
    page._waypointCandidateCache = cache;
    page._routeLocation = ROUTE_LOCATION;
    page._routePreferences = { durationMinutes: 30 };
    page._historicalPreferenceProfile = { environmentWeights: { park: 1 } };
    page._rawRoutes = Array.from({ length: count }, (_, i) => route([`initial-${i}`]));
    page._rawRoutes.forEach(item => page.rememberSurfacedRoute(item));
    page.setData({ routeState: 'success', routes: page.prepareRoutes(page._rawRoutes) });
    page.updateManualAlternativeControls();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementation(async ({ candidate }) => {
      expect(cache.markBuilding(candidate.candidateId)).toBe(true);
      const built = route(candidate.waypointIds);
      cache.markSuccess(candidate.candidateId, built);
      return { success: true, route: built };
    });
    return cache;
  }

  test.each([1, 2])('settled with %i routes adds exactly one and reranks using the same history and session', async count => {
    setup(count);
    const original = [...page._rawRoutes];
    const session = page._routePlanningSession;
    const history = page._historicalPreferenceProfile;
    const rank = jest.spyOn(page, 'rankCurrentRoutes');
    expect(page.data.manualAlternativeAction).toBe('add');
    await page.showOtherRoutes();
    expect(page._rawRoutes).toHaveLength(count + 1);
    original.forEach(item => expect(page._rawRoutes).toContain(item));
    expect(page._manualAlternativeActionCount).toBe(1);
    expect(rank).toHaveBeenCalledTimes(1);
    expect(page._historicalPreferenceProfile).toBe(history);
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledWith(expect.objectContaining({
      session, candidateCache: page._waypointCandidateCache, location: ROUTE_LOCATION,
      requestedDurationMinutes: 30
    }));
    expect(page.data.manualAlternativeAction).toBe(count === 2 ? 'replace' : 'add');
    expect(routeGenerationServiceMock.generateRoutes).not.toHaveBeenCalled();
  });

  test('replacement is explicit, cancellable, and preserves the selected old route until success', async () => {
    setup(3);
    const original = [...page._rawRoutes];
    const pending = createDeferred();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(pending.promise);
    await page.showOtherRoutes();
    expect(page.data.replacementSelection).toBe(true);
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).not.toHaveBeenCalled();
    page.cancelReplacementSelection();
    expect(page._manualAlternativeActionCount).toBe(0);
    await page.selectRouteToReplace(tap(original[1].routeId));
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).not.toHaveBeenCalled();
    page.showOtherRoutes();
    const operation = page.selectRouteToReplace(tap(original[1].routeId));
    expect(page._rawRoutes).toEqual(original);
    expect(page.data.replacingRouteId).toBe(original[1].routeId);
    expect(page.data.manualAlternativeAction).toBe('');
    await page.selectRouteToReplace(tap(original[2].routeId));
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
    const replacement = route(['A', 'B']);
    pending.resolve({ success: true, route: replacement });
    await operation;
    expect(page._rawRoutes).toEqual(expect.arrayContaining([original[0], original[2], replacement]));
    expect(page._rawRoutes).not.toContain(original[1]);
    expect(page._manualAlternativeActionCount).toBe(1);
    expect(page.data.routes.filter(item => item.isBestMatch)).toHaveLength(1);
  });

  test.each([1, 2, 3])('shared budget stops at three successful changes starting with %i routes', async count => {
    setup(count);
    for (let i = 0; i < 3; i++) {
      if (page._rawRoutes.length < 3) await page.showOtherRoutes();
      else {
        page.showOtherRoutes();
        await page.selectRouteToReplace(tap(page._rawRoutes[1].routeId));
      }
    }
    expect(page._manualAlternativeActionCount).toBe(3);
    expect(page.data.manualAlternativeAction).toBe('');
    const original = page._rawRoutes;
    await page.showOtherRoutes();
    await page.buildManualAlternative(page._rawRoutes[0]);
    expect(page._rawRoutes).toBe(original);
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(3);
    expect(page.data).not.toHaveProperty('_seenWaypointSetKeys');
    expect(page.data).not.toHaveProperty('_manualAlternativeActionCount');
  });

  test('normalized exact sets and reordered sets are skipped; partial overlap is allowed regardless of random IDs', async () => {
    setup(1, [[' B ', 'A'], ['A', 'B'], ['A', 'C']]);
    page._rawRoutes = [route(['A', 'B'], 'random-old')];
    page.rememberSurfacedRoute(page._rawRoutes[0]);
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
    expect(page._rawRoutes.map(item => item.recommendedWaypointIds)).toContainEqual(['A', 'C']);
    expect(page._manualAlternativeActionCount).toBe(1);
    expect(page.data.manualAlternativeAction).toBe('');
  });

  test('a replaced complete set stays excluded even after its route leaves the page', async () => {
    setup(3, [['A', 'B'], ['initial-1'], ['B', 'A']]);
    page.showOtherRoutes();
    await page.selectRouteToReplace(tap('initial-1'));
    expect(page._rawRoutes.some(item => item.routeId === 'initial-1')).toBe(false);
    expect(page.getEligibleCandidates()).toEqual([]);
    expect(page.data.manualAlternativeAction).toBe('');
    expect(page._seenWaypointSetKeys.has('["initial-1"]')).toBe(true);
  });

  test.each(['failure', 'exception', 'duplicate', 'wrong-set'])('%s preserves original routes and budget, and restores controls', async mode => {
    const cache = setup(3, [['A', 'B']]);
    const original = page._rawRoutes;
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementation(async ({ candidate }) => {
      cache.markBuilding(candidate.candidateId);
      if (mode === 'exception') throw new Error('provider failure');
      if (mode === 'failure') { cache.markFailed(candidate.candidateId); return { success: false }; }
      const built = mode === 'duplicate' ? route(['initial-0'], 'different-random-id') : route(['unknown']);
      cache.markSuccess(candidate.candidateId, built);
      return { success: true, route: built };
    });
    page.showOtherRoutes();
    await page.selectRouteToReplace(tap('initial-1'));
    expect(page._rawRoutes).toBe(original);
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page._manualAlternativePending).toBeNull();
    expect(page.data.manualAlternativeAction).toBe('');
    expect(wx.showToast).toHaveBeenCalledWith({ title: '暂无更多路线', icon: 'none' });
    expect(routeGenerationServiceMock.generateRoutes).not.toHaveBeenCalled();
  });

  test.each(['thrown', 'returned'])('provider unavailable %s stops manual candidate processing without consuming budget', async mode => {
    const cache = setup(1, [['A', 'B'], ['A', 'C']]);
    const original = page._rawRoutes;
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementation(async ({ candidate }) => {
      cache.markBuilding(candidate.candidateId);
      cache.markFailed(candidate.candidateId);
      if (mode === 'thrown') {
        const error = new Error('Provider unavailable');
        error.code = 'PROVIDER_RATE_LIMITED';
        throw error;
      }
      return { success: false, error: 'PROVIDER_GATEWAY_FAILED' };
    });
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
    expect(page._rawRoutes).toBe(original);
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page._manualAlternativePending).toBeNull();
    expect(cache.getUnusedCandidates()).toHaveLength(1);
    expect(page.data.manualAlternativeAction).toBe('add');
    expect(wx.showToast).toHaveBeenCalledWith({
      title: '路线服务暂时繁忙，请稍后重新规划', icon: 'none'
    });
  });

  test.each(['thrown', 'returned'])('last candidate provider outage preserves routes and budget with actionable guidance (%s)', async mode => {
    const cache = setup(1, [['A', 'B']]);
    const original = page._rawRoutes;
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementation(async ({ candidate }) => {
      cache.markBuilding(candidate.candidateId);
      cache.markFailed(candidate.candidateId);
      if (mode === 'thrown') {
        const error = new Error('Provider temporarily unavailable');
        error.code = 'PROVIDER_RATE_LIMITED';
        throw error;
      }
      return { success: false, error: 'PROVIDER_GATEWAY_FAILED' };
    });
    await page.showOtherRoutes();
    expect(page._rawRoutes).toBe(original);
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page._manualAlternativePending).toBeNull();
    expect(cache.getUnusedCandidates()).toHaveLength(0);
    expect(page.data.manualAlternativeAction).toBe('');
    expect(wx.showToast).toHaveBeenCalledWith({
      title: '路线服务暂时繁忙，请稍后重新规划', icon: 'none'
    });
  });

  test('initial fill settles duplicate candidates rather than leaving them unused', async () => {
    const cache = setup(1, [['initial-0'], ['A', 'B'], [' B ', ' A '], ['A', 'C']]);
    page._initialCandidateProcessingComplete = false;
    await page.fillInitialRoutes(page._routeRequestId);
    const entries = cache.getAllCandidates();
    expect(entries[0].status).toBe('failed');
    expect(entries[1].status).toBe('success');
    expect(entries[2].status).toBe('failed');
    expect(entries[3].status).toBe('success');
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
    expect(page._rawRoutes).toHaveLength(3);
  });

  test('failed candidates are skipped and only the next success consumes budget', async () => {
    const cache = setup();
    const build = routeGenerationServiceMock.buildOptimizedCandidateRoute.getMockImplementation();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockImplementationOnce(async ({ candidate }) => {
      cache.markFailed(candidate.candidateId);
      return { success: false };
    }).mockImplementation(build);
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
    expect(page._manualAlternativeActionCount).toBe(1);
    expect(page._rawRoutes).toHaveLength(2);
  });

  test('exhausted pool and initial processing never launch a manual build', async () => {
    setup(1, []);
    await page.showOtherRoutes();
    expect(page.data.manualAlternativeAction).toBe('');
    setup();
    page._initialCandidateProcessingComplete = false;
    page.updateManualAlternativeControls();
    await page.showOtherRoutes();
    expect(page.data.manualAlternativeAction).toBe('');
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).not.toHaveBeenCalled();
    expect(page._manualAlternativeActionCount).toBe(0);
  });

  test('initial fill excludes repeated sets, stops at three and leaves eligible candidates unused', async () => {
    const cache = setup(1, [['initial-0'], ['A', 'B'], [' B ', ' A '], ['A', 'C'], ['A', 'D']]);
    page._initialCandidateProcessingComplete = false;
    await page.fillInitialRoutes(page._routeRequestId);
    expect(page._rawRoutes).toHaveLength(3);
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
    expect(cache.getUnusedCandidates().map(item => item.waypointIds)).toContainEqual(['A', 'D']);
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page.data.manualAlternativeAction).toBe('replace');
  });

  test('an edited selected route is not overwritten by a pending replacement', async () => {
    setup(3);
    const selected = page._rawRoutes[1];
    const deferred = createDeferred();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(deferred.promise);
    page.showOtherRoutes();
    const pending = page.selectRouteToReplace(tap(selected.routeId));
    const edited = { ...selected, durationSeconds: 1900 };
    page._rawRoutes = page._rawRoutes.map(item => item === selected ? edited : item);
    deferred.resolve({ success: true, route: route(['A', 'B']) });
    await pending;
    expect(page._rawRoutes).toContain(edited);
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page._manualAlternativePending).toBeNull();
    expect(page.data.manualAlternativeAction).toBe('replace');
  });

  test.each(['reload', 'unload'])('pending additions and double taps stay safe after %s', async action => {
    setup();
    const deferred = createDeferred();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(deferred.promise);
    const pending = page.showOtherRoutes();
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
    if (action === 'reload') {
      page.getRoutes = jest.fn().mockResolvedValue(createSuccessfulRouteLoadResult());
      await page.loadRoutes();
    } else page.onUnload();
    const current = page._rawRoutes;
    page.setData.mockClear();
    deferred.resolve({ success: true, route: route(['A', 'B']) });
    await pending;
    expect(page._rawRoutes).toBe(current);
    expect(page.setData).not.toHaveBeenCalled();
    expect(page._manualAlternativeActionCount).toBe(0);
    expect(page._seenWaypointSetKeys.has('["A","B"]')).toBe(false);
  });

  test('old completion cannot unlock an operation in a newer session', async () => {
    setup();
    const old = createDeferred();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(old.promise);
    const oldPending = page.showOtherRoutes();
    setup();
    const next = createDeferred();
    routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(next.promise);
    const nextPending = page.showOtherRoutes();
    const operation = page._manualAlternativePending;
    old.resolve({ success: false });
    await oldPending;
    expect(page._manualAlternativePending).toBe(operation);
    await page.showOtherRoutes();
    expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
    next.resolve({ success: true, route: route(['A', 'B']) });
    await nextPending;
    expect(page._manualAlternativeActionCount).toBe(1);
  });

  test('reload resets a consumed budget and removed-route history', async () => {
    setup();
    await page.showOtherRoutes();
    page.getRoutes = jest.fn().mockResolvedValue(createSuccessfulRouteLoadResult());
    await page.loadRoutes();
    expect(page._manualAlternativeActionCount).toBe(0);
    expect([...page._seenWaypointSetKeys]).toEqual(['["A"]']);
  });

  test('a removed route editor cannot preview or confirm through old callbacks', async () => {
    setup(3);
    const old = page._rawRoutes[1];
    old.editableWaypoints = [{ poiId: 'initial-1' }];
    const channel = { emit: jest.fn() };
    wx.navigateTo.mockImplementation(options => options.success({ eventChannel: channel }));
    page.viewRoute(tap(old.routeId));
    const events = wx.navigateTo.mock.calls[0][0].events;
    page.showOtherRoutes();
    await page.selectRouteToReplace(tap(old.routeId));
    await events.previewRoute({ routeId: old.routeId, requestId: 1, orderedWaypointIds: ['initial-1'] });
    events.confirmRoute({ routeId: old.routeId, requestId: 1 });
    expect(page._routePlanningSession.buildRouteForOrder).not.toHaveBeenCalled();
    expect(page._rawRoutes).not.toContain(old);
    expect(channel.emit).toHaveBeenCalledWith('routeConfirmResult', expect.objectContaining({ message: expect.any(String) }));
  });

  test('template exposes inline selection and exact labels without a blocking overlay', () => {
    const fs = require('fs');
    const template = fs.readFileSync(require('path').join(__dirname, '../miniprogram/pages/routes/routes.wxml'), 'utf8');
    expect(template).toContain('增加一个路线');
    expect(template).toContain('换一个路线');
    expect(template).toContain('bindtap="selectRouteToReplace"');
    expect(template).toContain('bindtap="cancelReplacementSelection"');
    expect(template).toContain('wx:if="{{manualAlternativeAction && !replacementSelection}}"');
    expect(template).not.toContain('换一批路线');
    expect(template).not.toContain('cover-view');
  });
});

beforeEach(() => {
  page =
    loadRoutesPage();
});


afterEach(() => {
  jest.restoreAllMocks();

  delete global.Page;
  delete global.wx;
});


describe(
  "Routes page integration and state handling",
  () => {

    test(
      "onLoad waits for route preferences when opened from Preferences",
      () => {
        const eventChannel =
          createEventChannel();

        page =
          loadRoutesPage({
            eventChannel
          });

        page.loadRoutes =
          jest.fn();


        const preferences = {
          durationMinutes: 30,

          routeType:
            "loop",

          crowdPreference:
            "low",

          environmentPreferences: [
            "街道",
            "公园",
            "水边",
            "商街"
          ]
        };


        page.onLoad({
          from: "preferences"
        });


        expect(
          eventChannel.on
        ).toHaveBeenCalledWith(
          "routePreferences",
          expect.any(Function)
        );


        expect(
          page.loadRoutes
        ).not.toHaveBeenCalled();


        expect(
          page._routePlanningSession
        ).toBeNull();


        eventChannel
          .handlers
          .routePreferences(
            preferences
          );


        expect(
          page._routePreferences
        ).toEqual(
          preferences
        );


        expect(
          page.loadRoutes
        ).toHaveBeenCalledTimes(
          1
        );
      }
    );


    test(
      "onLoad uses development default preferences when not opened from Preferences",
      () => {
        page.loadRoutes =
          jest.fn();


        page.onLoad({});


        expect(
          page._routePreferences
        ).toEqual({
          durationMinutes: 30,
          routeType: "loop",
          crowdPreference: "medium",
          environmentPreferences: [
            "公园",
            "水边",
            "街道",
            "商街"
          ]
        });


        expect(
          page._rawRoutes
        ).toEqual([]);


        expect(
          page._routePlanningSession
        ).toBeNull();


        expect(
          page.loadRoutes
        ).toHaveBeenCalledTimes(
          1
        );
      }
    );


    test(
      "getRoutes passes preferences to route generation and returns routes with runtime planning state",
      async () => {
        const preferences = {
          durationMinutes: 30,

          routeType:
            "loop",

          crowdPreference:
            "low",

          environmentPreferences: [
            "公园",
            "水边",
            "街道",
            "商街"
          ]
        };

        const routePlanningSession =
          createRoutePlanningSessionMock();

        const waypointCandidateCache =
          createWaypointCandidateCacheMock();


        page._routePreferences =
          preferences;


        routeGenerationServiceMock
          .generateRoutes
          .mockResolvedValue({
            status:
              "success",

            routes: [
              GENERATED_ROUTE
            ],

            routePlanningSession,
            waypointCandidateCache,
            location:
              ROUTE_LOCATION
          });


        const result =
          await page.getRoutes();


        expect(
          routeGenerationServiceMock
            .generateRoutes
        ).toHaveBeenCalledWith(
          preferences
        );


        expect(
          result
        ).toEqual({
          routes: [
            GENERATED_ROUTE
          ],

          routePlanningSession,
          waypointCandidateCache,
          historicalPreferenceProfile: null,
          location:
            ROUTE_LOCATION
        });
      }
    );

    test(
      "getRoutes converts an explicit empty generation result to an empty route load result",
      async () => {
        routeGenerationServiceMock
          .generateRoutes
          .mockResolvedValue({
            status:
              "empty",

            reason:
              "NO_VALID_POI"
          });


        const result =
          await page.getRoutes();


        expect(
          result
        ).toEqual({
          routes: [],
          routePlanningSession: null,
          waypointCandidateCache: null
        });
      }
    );


    test(
      "getRoutes rejects a success result without a valid planning session",
      async () => {
        routeGenerationServiceMock
          .generateRoutes
          .mockResolvedValue({
            status:
              "success",

            routes: [
              GENERATED_ROUTE
            ],

            routePlanningSession: {}
          });


        await expect(
          page.getRoutes()
        ).rejects.toThrow(
          "Invalid route generation result"
        );
      }
    );


    test.each([undefined, null, {}])(
      "getRoutes rejects a session with an invalid cache inspection method (%s)",
      async getCachedSegmentCosts => {
        const session = createRoutePlanningSessionMock();
        session.getCachedSegmentCosts = getCachedSegmentCosts;
        routeGenerationServiceMock.generateRoutes.mockResolvedValue({
          status: "success",
          routes: [GENERATED_ROUTE],
          routePlanningSession: session,
          waypointCandidateCache: createWaypointCandidateCacheMock()
        });
        await expect(page.getRoutes()).rejects.toThrow("Invalid route generation result");
      }
    );


    test(
      "getRoutes rejects an invalid route generation result",
      async () => {
        routeGenerationServiceMock
          .generateRoutes
          .mockResolvedValue({
            status:
              "unexpected"
          });


        await expect(
          page.getRoutes()
        ).rejects.toThrow(
          "Invalid route generation result"
        );
      }
    );


    test(
      "loadRoutes starts in loading state and clears the previous planning session",
      async () => {
        const deferred =
          createDeferred();

        const oldSession =
          createRoutePlanningSessionMock();

        const newSession =
          createRoutePlanningSessionMock();

        const newCandidateCache =
          createWaypointCandidateCacheMock();


        page.data.routeState =
          "success";

        page.data.routes =
          mockRoutes;

        page._rawRoutes =
          mockRoutes;

        page._routePlanningSession =
          oldSession;


        page.getRoutes =
          jest.fn(
            () =>
              deferred.promise
          );


        const loadPromise =
          page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "loading"
        );


        expect(
          page.data.routes
        ).toEqual([]);


        expect(
          page._rawRoutes
        ).toEqual([]);


        expect(
          page._routePlanningSession
        ).toBeNull();


        deferred.resolve({
          routes:
            mockRoutes,

          routePlanningSession:
            newSession,

          waypointCandidateCache:
            newCandidateCache,

          location:
            ROUTE_LOCATION
        });


        await loadPromise;


        expect(
          page._routePlanningSession
        ).toBe(
          newSession
        );
      }
    );


    test(
      "loadRoutes sets success and stores raw routes with runtime planning state",
      async () => {
        const routePlanningSession =
          createRoutePlanningSessionMock();

        const waypointCandidateCache =
          createWaypointCandidateCacheMock();


        page.getRoutes =
          jest.fn()
            .mockResolvedValue(
              createSuccessfulRouteLoadResult({
                routePlanningSession,
                waypointCandidateCache
              })
            );


        await page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "success"
        );


        expect(
          page.data.routes
        ).toHaveLength(1);


        expect(
          page._rawRoutes
        ).toEqual([
          GENERATED_ROUTE
        ]);


        expect(
          page._routePlanningSession
        ).toBe(
          routePlanningSession
        );


        expect(
          page._waypointCandidateCache
        ).toBe(
          waypointCandidateCache
        );


        expect(
          page._routeLocation
        ).toEqual(
          ROUTE_LOCATION
        );
      }
    );


    test(
      "loadRoutes keeps the planning session out of serialized page data",
      async () => {
        const routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn()
            .mockResolvedValue(
              createSuccessfulRouteLoadResult({
                routePlanningSession
              })
            );


        await page.loadRoutes();


        expect(
          page._routePlanningSession
        ).toBe(
          routePlanningSession
        );


        expect(
          page.data
        ).not.toHaveProperty(
          "routePlanningSession"
        );
      }
    );


    test(
      "loadRoutes sets empty and clears raw routes and planning session when no routes exist",
      async () => {
        page._rawRoutes = [
          GENERATED_ROUTE
        ];

        page._routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn()
            .mockResolvedValue({
              routes: [],
              routePlanningSession: null
            });


        await page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "empty"
        );


        expect(
          page.data.routes
        ).toEqual([]);


        expect(
          page._rawRoutes
        ).toEqual([]);


        expect(
          page._routePlanningSession
        ).toBeNull();
      }
    );


    test(
      "loadRoutes sets error and clears raw routes and planning session when request fails",
      async () => {
        const consoleErrorSpy =
          jest
            .spyOn(
              console,
              "error"
            )
            .mockImplementation(
              () => {}
            );


        page._rawRoutes = [
          GENERATED_ROUTE
        ];

        page._routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn()
            .mockRejectedValue(
              new Error(
                "Mock route loading failed"
              )
            );


        await page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "error"
        );


        expect(
          page.data.routes
        ).toEqual([]);


        expect(
          page._rawRoutes
        ).toEqual([]);


        expect(
          page._routePlanningSession
        ).toBeNull();


        expect(
          consoleErrorSpy
        ).toHaveBeenCalled();
      }
    );


    test(
      "loadRoutes rejects malformed route load results",
      async () => {
        const consoleErrorSpy =
          jest
            .spyOn(
              console,
              "error"
            )
            .mockImplementation(
              () => {}
            );


        page.getRoutes =
          jest.fn()
            .mockResolvedValue([
              GENERATED_ROUTE
            ]);


        await page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "error"
        );


        expect(
          page._rawRoutes
        ).toEqual([]);


        expect(
          page._routePlanningSession
        ).toBeNull();


        expect(
          consoleErrorSpy
        ).toHaveBeenCalled();
      }
    );


    test('route previews retain every POI, numbered markers and fitting coordinates', () => {
      const pointsOfInterest = Array.from({ length: 8 }, (_, index) => ({
        poiId: `poi-${index}`, name: `Place ${index}`,
        latitude: 23.13 + index / 100, longitude: 113.27
      }));
      const route = { ...GENERATED_ROUTE, pointsOfInterest, endPoint: pointsOfInterest[7] };
      const [prepared] = page.prepareRoutes([route]);
      expect(prepared.previewMarkers).toHaveLength(9);
      expect(prepared.displayPois.map(poi => poi.poiId)).toEqual(pointsOfInterest.map(poi => poi.poiId));
      pointsOfInterest.forEach((poi, index) => {
        expect(prepared.previewMarkers[index + 1].title).toContain(`${index + 1}. ${poi.name}`);
        expect(prepared.previewPoints).toContainEqual({ latitude: poi.latitude, longitude: poi.longitude });
      });
      expect(route.displayPois).toBeUndefined();
    });

    test(
      "prepareRoutes formats a generated real route correctly",
      () => {
        const [
          preparedRoute
        ] =
          page.prepareRoutes([
            GENERATED_ROUTE
          ]);


        expect(
          preparedRoute
            .distanceKm
        ).toBe(
          "0.3"
        );


        expect(
          preparedRoute
            .routeTypeText
        ).toBe(
          "单程路线"
        );


        expect(
          preparedRoute
            .crowdText
        ).toBe(
          "暂无数据"
        );


        expect(
          preparedRoute
            .displayTags
        ).toEqual([
          "公园"
        ]);


        expect(
          preparedRoute
            .previewLatitude
        ).toBe(
          23.128
        );


        expect(
          preparedRoute
            .previewLongitude
        ).toBe(
          113.2646
        );


        expect(
          preparedRoute
            .previewPolyline
        ).toEqual([
          {
            points:
              GENERATED_ROUTE
                .polyline,

            color:
              "#20BFEA",

            width:
              5
          }
        ]);
      }
    );


    test(
      "retryLoadRoutes uses the normal loadRoutes flow",
      () => {
        page.loadRoutes =
          jest.fn();


        page.retryLoadRoutes();


        expect(
          page.loadRoutes
        ).toHaveBeenCalledTimes(
          1
        );
      }
    );


    test(
      "stale success cannot overwrite a newer success or its planning session",
      async () => {
        const firstRequest =
          createDeferred();

        const secondRequest =
          createDeferred();


        const oldRoutes = [
          {
            ...mockRoutes[0],

            title:
              "旧请求路线"
          }
        ];


        const newRoutes = [
          {
            ...mockRoutes[0],

            title:
              "最新请求路线"
          }
        ];


        const oldSession =
          createRoutePlanningSessionMock();

        const newSession =
          createRoutePlanningSessionMock();

        const oldCandidateCache =
          createWaypointCandidateCacheMock();

        const newCandidateCache =
          createWaypointCandidateCacheMock();


        page.getRoutes =
          jest.fn()
            .mockImplementationOnce(
              () =>
                firstRequest.promise
            )
            .mockImplementationOnce(
              () =>
                secondRequest.promise
            );


        const oldLoadPromise =
          page.loadRoutes();


        const newLoadPromise =
          page.loadRoutes();


        secondRequest.resolve({
          routes:
            newRoutes,

          routePlanningSession:
            newSession,

          waypointCandidateCache:
            newCandidateCache,

          location:
            ROUTE_LOCATION
        });


        await newLoadPromise;


        expect(
          page.data.routeState
        ).toBe(
          "success"
        );


        expect(
          page.data
            .routes[0]
            .title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._routePlanningSession
        ).toBe(
          newSession
        );


        firstRequest.resolve({
          routes:
            oldRoutes,

          routePlanningSession:
            oldSession,

          waypointCandidateCache:
            oldCandidateCache,

          location:
            ROUTE_LOCATION
        });


        await oldLoadPromise;


        expect(
          page.data.routeState
        ).toBe(
          "success"
        );


        expect(
          page.data
            .routes[0]
            .title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._rawRoutes[0].title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._routePlanningSession
        ).toBe(
          newSession
        );
      }
    );


    test(
      "stale error cannot overwrite a newer success or clear its planning session",
      async () => {
        const firstRequest =
          createDeferred();

        const secondRequest =
          createDeferred();


        const newRoutes = [
          {
            ...mockRoutes[0],

            title:
              "最新请求路线"
          }
        ];


        const newSession =
          createRoutePlanningSessionMock();

        const newCandidateCache =
          createWaypointCandidateCacheMock();


        page.getRoutes =
          jest.fn()
            .mockImplementationOnce(
              () =>
                firstRequest.promise
            )
            .mockImplementationOnce(
              () =>
                secondRequest.promise
            );


        const oldLoadPromise =
          page.loadRoutes();


        const newLoadPromise =
          page.loadRoutes();


        secondRequest.resolve({
          routes:
            newRoutes,

          routePlanningSession:
            newSession,

          waypointCandidateCache:
            newCandidateCache,

          location:
            ROUTE_LOCATION
        });


        await newLoadPromise;


        expect(
          page.data.routeState
        ).toBe(
          "success"
        );


        expect(
          page.data
            .routes[0]
            .title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._routePlanningSession
        ).toBe(
          newSession
        );


        firstRequest.reject(
          new Error(
            "Old request failed"
          )
        );


        await oldLoadPromise;


        expect(
          page.data.routeState
        ).toBe(
          "success"
        );


        expect(
          page.data
            .routes[0]
            .title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._rawRoutes[0].title
        ).toBe(
          "最新请求路线"
        );


        expect(
          page._routePlanningSession
        ).toBe(
          newSession
        );
      }
    );


    test(
      "viewRoute passes the selected raw route to Route Detail through EventChannel",
      () => {
        const detailEventChannel = {
          emit:
            jest.fn()
        };


        wx.navigateTo
          .mockImplementation(
            ({ success }) => {
              success({
                eventChannel:
                  detailEventChannel
              });
            }
          );


        page._rawRoutes = [
          GENERATED_ROUTE
        ];


        page.data.routes =
          page.prepareRoutes([
            GENERATED_ROUTE
          ]);


        page.viewRoute({
          currentTarget: {
            dataset: {
              id:
                GENERATED_ROUTE.routeId
            }
          }
        });


        expect(
          wx.navigateTo
        ).toHaveBeenCalledTimes(
          1
        );


        expect(
          wx.navigateTo
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            url:
              `/pages/route-detail/route-detail?id=${GENERATED_ROUTE.routeId}&from=routes`,

            success:
              expect.any(Function)
          })
        );


        expect(
          detailEventChannel.emit
        ).toHaveBeenCalledWith(
          "selectedRoute",
          GENERATED_ROUTE
        );
        expect(detailEventChannel.emit).toHaveBeenCalledWith("routePreferences", page._routePreferences);
      }
    );


    test(
      "viewRoute shows an error toast when the route cannot be found",
      () => {
        page._rawRoutes = [];
        page.data.routes = [];


        page.viewRoute({
          currentTarget: {
            dataset: {
              id:
                "missing-route"
            }
          }
        });


        expect(
          wx.navigateTo
        ).not.toHaveBeenCalled();


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "无法打开这条路线",

          icon:
            "none"
        });
      }
    );


    test('ranking reuses the returned history privately and resets it on a new load and unload', async () => {
      const history = { environmentWeights: { park: 0, water: 1 } };
      const park = { ...GENERATED_ROUTE, routeId: 'park', durationSeconds: 1800, pointsOfInterest: [{ category: 'park' }] };
      const water = { ...park, routeId: 'water', pointsOfInterest: [{ category: 'water' }] };
      page._routePreferences = { durationMinutes: 30 };
      routeGenerationServiceMock.generateRoutes.mockResolvedValue({
        status: 'success', ...createSuccessfulRouteLoadResult({ routes: [park, water] }),
        historicalPreferenceProfile: history
      });
      await page.loadRoutes();
      expect(page._historicalPreferenceProfile).toBe(history);
      expect(page._rawRoutes).toEqual([water, park]);
      expect(page.data).not.toHaveProperty('historicalPreferenceProfile');
      const ranking = require('../miniprogram/services/route-ranking');
      const rank = jest.spyOn(ranking, 'rankRoutes');
      page.rankCurrentRoutes([park, water]);
      expect(rank.mock.calls[0][1].historicalPreferenceProfile).toBe(history);
      const deferred = createDeferred();
      routeGenerationServiceMock.generateRoutes.mockReturnValueOnce(deferred.promise);
      const load = page.loadRoutes();
      expect(page._historicalPreferenceProfile).toBeNull();
      deferred.resolve({ status: 'success', ...createSuccessfulRouteLoadResult() });
      await load;
      expect(page._historicalPreferenceProfile).toBeNull();
      page._historicalPreferenceProfile = history;
      page.onUnload();
      expect(page._historicalPreferenceProfile).toBeNull();
    });

    test(
      "onUnload clears runtime planning state",
      () => {
        page._routePlanningSession =
          createRoutePlanningSessionMock();

        page._waypointCandidateCache =
          createWaypointCandidateCacheMock();

        page._routeLocation =
          ROUTE_LOCATION;


        page.onUnload();


        expect(
          page._routePlanningSession
        ).toBeNull();


        expect(
          page._waypointCandidateCache
        ).toBeNull();


        expect(
          page._routeLocation
        ).toBeNull();
      }
    );


    test(
      "onUnload invalidates an in-flight route request and prevents its session from being restored",
      async () => {
        const deferred =
          createDeferred();

        const routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn(
            () =>
              deferred.promise
          );


        const loadPromise =
          page.loadRoutes();


        expect(
          page.data.routeState
        ).toBe(
          "loading"
        );


        page.onUnload();


        deferred.resolve({
          routes:
            mockRoutes,

          routePlanningSession
        });


        await loadPromise;


        expect(
          page.setData
        ).toHaveBeenCalledTimes(
          1
        );


        expect(
          page._routePlanningSession
        ).toBeNull();
      }
    );

  }
);
