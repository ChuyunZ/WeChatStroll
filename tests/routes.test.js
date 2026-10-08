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
        if (result.success) cache.markSuccess(options.candidate.candidateId, result.route);
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


    function prepareReplacement() {
      const session = createRoutePlanningSessionMock();
      const candidate = { candidateId: "candidate-4", waypointIds: ["B", "A"] };
      const cache = createWaypointCandidateCacheMock({ unusedCandidates: [candidate] });
      page._routeRequestId = 1;
      page._routePlanningSession = session;
      page._waypointCandidateCache = cache;
      page._routeLocation = ROUTE_LOCATION;
      page._routePreferences = { durationMinutes: 45 };
      page._rawRoutes = [GENERATED_ROUTE];
      return { session, cache, candidate };
    }

    test("showOtherRoutes uses the shared optimizer service and keeps its route metadata", async () => {
      const { session, cache, candidate } = prepareReplacement();
      const route = { ...GENERATED_ROUTE, routeId: "replacement",
        recommendedWaypointIds: ["A", "B"], optimization: { strategy: "exact" } };
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockResolvedValue({ success: true, route });
      await page.showOtherRoutes();
      expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledWith({
        session, candidateCache: cache, candidate, location: ROUTE_LOCATION,
        candidateIndex: 3, requestedDurationMinutes: 45
      });
      expect(page._rawRoutes).toEqual([route]);
      expect(page.data.routes[0].optimization).toEqual(route.optimization);
      expect(page._routePlanningSession).toBe(session);
    });

    test('showOtherRoutes removes one displayed route then ranks the replacement set', async () => {
      prepareReplacement();
      const removed = { ...GENERATED_ROUTE, routeId: 'removed', durationSeconds: 2700 };
      const retained = { ...GENERATED_ROUTE, routeId: 'retained', durationSeconds: 2900 };
      const replacement = { ...GENERATED_ROUTE, routeId: 'replacement', durationSeconds: 2750 };
      page._rawRoutes = [removed, retained];
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockResolvedValue({ success: true, route: replacement });
      await page.showOtherRoutes();
      expect(page._rawRoutes).toEqual([replacement, retained]);
      expect(page.data.routes.map(route => route.isBestMatch)).toEqual([true, false]);
      expect(routeGenerationServiceMock.generateRoutes).not.toHaveBeenCalled();
    });

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

    test("showOtherRoutes skips failed candidates and displays the next success", async () => {
      const { cache } = prepareReplacement();
      cache.getUnusedCandidates.mockReturnValue([
        { candidateId: "candidate-4", waypointIds: ["A"] },
        { candidateId: "candidate-5", waypointIds: ["B"] }
      ]);
      routeGenerationServiceMock.buildOptimizedCandidateRoute
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true, route: GENERATED_ROUTE });
      await page.showOtherRoutes();
      expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
      expect(page.setData).toHaveBeenCalledTimes(1);
    });

    test("showOtherRoutes handles exhausted and all-failed candidates without AI requests", async () => {
      const { cache } = prepareReplacement();
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockResolvedValue({ success: false });
      await page.showOtherRoutes();
      expect(page.setData).not.toHaveBeenCalled();
      expect(wx.showToast).toHaveBeenCalled();
      cache.getUnusedCandidates.mockReturnValue([]);
      await page.showOtherRoutes();
      expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
      expect(routeGenerationServiceMock.generateRoutes).not.toHaveBeenCalled();
    });

    test.each(["unload", "reload"])("showOtherRoutes ignores stale results after %s", async action => {
      prepareReplacement();
      const deferred = createDeferred();
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValue(deferred.promise);
      const pending = page.showOtherRoutes();
      if (action === "unload") page.onUnload();
      else {
        page.getRoutes = jest.fn().mockResolvedValue(createSuccessfulRouteLoadResult());
        await page.loadRoutes();
      }
      const rawRoutes = page._rawRoutes;
      page.setData.mockClear();
      wx.showToast.mockClear();
      deferred.resolve({ success: true, route: { ...GENERATED_ROUTE, routeId: "stale" } });
      await pending;
      expect(page._rawRoutes).toBe(rawRoutes);
      expect(page.setData).not.toHaveBeenCalled();
      expect(wx.showToast).not.toHaveBeenCalled();
    });

    test("showOtherRoutes ignores duplicate clicks and releases the guard after an exception", async () => {
      prepareReplacement();
      const deferred = createDeferred();
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockReturnValueOnce(deferred.promise);
      const pending = page.showOtherRoutes();
      await page.showOtherRoutes();
      expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(1);
      deferred.reject(new Error("unexpected failure"));
      await pending;
      expect(page._replacementSession).toBeNull();
      expect(page.setData).not.toHaveBeenCalled();
      routeGenerationServiceMock.buildOptimizedCandidateRoute.mockResolvedValue({ success: true, route: GENERATED_ROUTE });
      await page.showOtherRoutes();
      expect(page.setData).toHaveBeenCalledTimes(1);
    });

    test("an old replacement cannot clear the new session's click guard", async () => {
      prepareReplacement();
      const oldDeferred = createDeferred();
      const newDeferred = createDeferred();
      routeGenerationServiceMock.buildOptimizedCandidateRoute
        .mockReturnValueOnce(oldDeferred.promise).mockReturnValueOnce(newDeferred.promise);
      const oldPending = page.showOtherRoutes();
      const { session } = prepareReplacement();
      const newPending = page.showOtherRoutes();
      oldDeferred.resolve({ success: false });
      await oldPending;
      expect(page._replacementSession).toBe(session);
      await page.showOtherRoutes();
      expect(routeGenerationServiceMock.buildOptimizedCandidateRoute).toHaveBeenCalledTimes(2);
      newDeferred.resolve({ success: false });
      await newPending;
      expect(page._replacementSession).toBeNull();
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
