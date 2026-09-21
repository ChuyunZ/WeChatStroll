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
    generateRoutes:
      jest.fn(),

    buildGeneratedRouteFromAiCandidate:
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


    test(
      "showOtherRoutes replaces the first displayed route with the next successful cached candidate",
      async () => {
        const candidate = {
          candidateId:
            "candidate-4",

          waypointIds: [
            "poi-4"
          ]
        };

        const routePlanningSession =
          createRoutePlanningSessionMock();

        const waypointCandidateCache =
          createWaypointCandidateCacheMock({
            unusedCandidates: [
              candidate
            ]
          });

        const replacementRoute = {
          ...GENERATED_ROUTE,

          routeId:
            "generated_ai_1_456",

          title:
            "新的候选路线"
        };

        const originalRoutes = [
          {
            ...GENERATED_ROUTE,
            routeId:
              "route-a"
          },
          {
            ...GENERATED_ROUTE,
            routeId:
              "route-b"
          },
          {
            ...GENERATED_ROUTE,
            routeId:
              "route-c"
          }
        ];

        const walkingRoute = {
          success: true
        };


        routePlanningSession
          .buildRouteForOrder
          .mockResolvedValue(
            walkingRoute
          );

        routeGenerationServiceMock
          .buildGeneratedRouteFromAiCandidate
          .mockReturnValue(
            replacementRoute
          );

        page._routePlanningSession =
          routePlanningSession;

        page._waypointCandidateCache =
          waypointCandidateCache;

        page._routeLocation =
          ROUTE_LOCATION;

        page._rawRoutes =
          originalRoutes;


        await page.showOtherRoutes();


        expect(
          waypointCandidateCache
            .markBuilding
        ).toHaveBeenCalledWith(
          "candidate-4"
        );


        expect(
          routePlanningSession
            .buildRouteForOrder
        ).toHaveBeenCalledWith({
          allowedWaypointIds: [
            "poi-4"
          ],
          orderedWaypointIds: [
            "poi-4"
          ],
          source: "ai"
        });


        expect(
          routeGenerationServiceMock
            .buildGeneratedRouteFromAiCandidate
        ).toHaveBeenCalledWith({
          location:
            ROUTE_LOCATION,
          walkingRoute,
          candidateIndex: 0
        });


        expect(
          waypointCandidateCache
            .markSuccess
        ).toHaveBeenCalledWith(
          "candidate-4",
          replacementRoute
        );


        expect(
          page._rawRoutes.map(
            route => route.routeId
          )
        ).toEqual([
          "route-b",
          "route-c",
          "generated_ai_1_456"
        ]);


        expect(
          page.data.routes.map(
            route => route.routeId
          )
        ).toEqual([
          "route-b",
          "route-c",
          "generated_ai_1_456"
        ]);


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "已更换路线",

          icon:
            "none"
        });
      }
    );


    test(
      "showOtherRoutes skips a failed cached candidate and uses the next successful one",
      async () => {
        const failedCandidate = {
          candidateId:
            "candidate-4",

          waypointIds: [
            "poi-4"
          ]
        };

        const successfulCandidate = {
          candidateId:
            "candidate-5",

          waypointIds: [
            "poi-5"
          ]
        };

        const routePlanningSession =
          createRoutePlanningSessionMock();

        const waypointCandidateCache =
          createWaypointCandidateCacheMock({
            unusedCandidates: [
              failedCandidate,
              successfulCandidate
            ]
          });

        const replacementRoute = {
          ...GENERATED_ROUTE,

          routeId:
            "generated_ai_2_789"
        };


        routePlanningSession
          .buildRouteForOrder
          .mockResolvedValueOnce({
            success: false
          })
          .mockResolvedValueOnce({
            success: true
          });

        routeGenerationServiceMock
          .buildGeneratedRouteFromAiCandidate
          .mockReturnValue(
            replacementRoute
          );

        page._routePlanningSession =
          routePlanningSession;

        page._waypointCandidateCache =
          waypointCandidateCache;

        page._routeLocation =
          ROUTE_LOCATION;

        page._rawRoutes = [
          GENERATED_ROUTE
        ];


        await page.showOtherRoutes();


        expect(
          waypointCandidateCache
            .markFailed
        ).toHaveBeenCalledWith(
          "candidate-4"
        );


        expect(
          waypointCandidateCache
            .markSuccess
        ).toHaveBeenCalledWith(
          "candidate-5",
          replacementRoute
        );


        expect(
          routePlanningSession
            .buildRouteForOrder
        ).toHaveBeenCalledTimes(
          2
        );
      }
    );


    test(
      "showOtherRoutes reports no more routes when all unused candidates fail",
      async () => {
        const candidate = {
          candidateId:
            "candidate-4",

          waypointIds: [
            "poi-4"
          ]
        };

        const routePlanningSession =
          createRoutePlanningSessionMock();

        const waypointCandidateCache =
          createWaypointCandidateCacheMock({
            unusedCandidates: [
              candidate
            ]
          });


        routePlanningSession
          .buildRouteForOrder
          .mockResolvedValue({
            success: false
          });

        page._routePlanningSession =
          routePlanningSession;

        page._waypointCandidateCache =
          waypointCandidateCache;

        page._rawRoutes = [
          GENERATED_ROUTE
        ];


        await page.showOtherRoutes();


        expect(
          waypointCandidateCache
            .markFailed
        ).toHaveBeenCalledWith(
          "candidate-4"
        );


        expect(
          page.setData
        ).not.toHaveBeenCalled();


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "暂无更多路线",

          icon:
            "none"
        });
      }
    );


    test(
      "showOtherRoutes reports no more routes without calling AI when the candidate cache is exhausted",
      async () => {
        const waypointCandidateCache =
          createWaypointCandidateCacheMock();


        page._waypointCandidateCache =
          waypointCandidateCache;


        await page.showOtherRoutes();


        expect(
          routeGenerationServiceMock
            .generateRoutes
        ).not.toHaveBeenCalled();


        expect(
          routeGenerationServiceMock
            .buildGeneratedRouteFromAiCandidate
        ).not.toHaveBeenCalled();


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "暂无更多路线",

          icon:
            "none"
        });
      }
    );

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