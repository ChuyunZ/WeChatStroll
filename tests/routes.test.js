const {
  mockRoutes
} = require("../miniprogram/data/mock-routes");

const ROUTE_GENERATION_PATH =
  "../miniprogram/services/route-generation";

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


function createSuccessfulRouteLoadResult({
  routes = [
    GENERATED_ROUTE
  ],
  routePlanningSession =
    createRoutePlanningSessionMock()
} = {}) {
  return {
    routes,
    routePlanningSession
  };
}


function loadRoutesPage({
  eventChannel = null
} = {}) {
  jest.resetModules();

  pageDefinition = null;

  routeGenerationServiceMock = {
    generateRoutes:
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
      "onLoad directly loads routes with empty preferences when not opened from Preferences",
      () => {
        page.loadRoutes =
          jest.fn();


        page.onLoad({});


        expect(
          page._routePreferences
        ).toEqual({});


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
      "getRoutes passes preferences to route generation and returns the route with its planning session",
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

            routePlanningSession
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

          routePlanningSession
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
          routePlanningSession: null
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
            newSession
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
      "loadRoutes sets success and stores both raw routes and the planning session",
      async () => {
        const routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn()
            .mockResolvedValue({
              routes: [
                GENERATED_ROUTE
              ],

              routePlanningSession
            });


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
      }
    );


    test(
      "loadRoutes keeps the planning session out of serialized page data",
      async () => {
        const routePlanningSession =
          createRoutePlanningSessionMock();


        page.getRoutes =
          jest.fn()
            .mockResolvedValue({
              routes: [
                GENERATED_ROUTE
              ],

              routePlanningSession
            });


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
            newSession
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
            oldSession
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
            newSession
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
      "showOtherRoutes rotates the route order when multiple routes exist without replacing the planning session",
      () => {
        const routePlanningSession =
          createRoutePlanningSessionMock();

        page._routePlanningSession =
          routePlanningSession;


        page.data.routes = [
          {
            routeId:
              "route-a"
          },
          {
            routeId:
              "route-b"
          },
          {
            routeId:
              "route-c"
          }
        ];


        page.showOtherRoutes();


        expect(
          page.data.routes
        ).toEqual([
          {
            routeId:
              "route-b"
          },
          {
            routeId:
              "route-c"
          },
          {
            routeId:
              "route-a"
          }
        ]);


        expect(
          page._routePlanningSession
        ).toBe(
          routePlanningSession
        );


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
      "showOtherRoutes reports no alternatives when only one route exists",
      () => {
        page.data.routes = [
          GENERATED_ROUTE
        ];


        page.showOtherRoutes();


        expect(
          page.setData
        ).not.toHaveBeenCalled();


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "暂无其他路线",

          icon:
            "none"
        });
      }
    );


    test(
      "onUnload clears the planning session",
      () => {
        page._routePlanningSession =
          createRoutePlanningSessionMock();


        page.onUnload();


        expect(
          page._routePlanningSession
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