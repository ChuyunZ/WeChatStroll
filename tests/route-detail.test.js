const { mockWalkRecords } = require("./helpers/walk-records");
let walkRecords;
async function flushCloud() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const {
  mockRoutes
} = require(
  "../miniprogram/data/mock-routes"
);


const GENERATED_ROUTE = {
  routeId:
    "generated_park-1_123",

  title:
    "前往人民公园的散步路线",

  durationMinutes:
    4,

  distanceMeters:
    279,

  routeType:
    "point_to_point",

  returnsToStart:
    false,

  crowdLevel:
    "unknown",

  tags: [
    "公园"
  ],

  description:
    "从当前位置步行前往人民公园的真实路线。",

  recommendationReason:
    "根据你的散步环境偏好排序，推荐前往人民公园。",

  startPoint: {
    name:
      "当前位置",

    latitude:
      23.129158,

    longitude:
      113.264939
  },

  endPoint: {
    name:
      "人民公园",

    latitude:
      23.127159,

    longitude:
      113.264345
  },

  polyline: [
    {
      latitude:
        23.129158,

      longitude:
        113.264939
    },

    {
      latitude:
        23.128,

      longitude:
        113.2646
    },

    {
      latitude:
        23.127159,

      longitude:
        113.264345
    }
  ],

  pointsOfInterest: [
    {
      name:
        "人民公园",

      type:
        "park",

      latitude:
        23.127159,

      longitude:
        113.264345
    }
  ],

  updatedAt:
    "2026-09-05T00:00:00.000Z"
};


let pageDefinition;
let page;
let storage;


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


function loadRouteDetailPage({
  eventChannel = null
} = {}) {
  jest.resetModules();

  pageDefinition = null;
  storage = {};
  walkRecords = mockWalkRecords(() => storage);
  jest.doMock("../miniprogram/services/walk-records", () => walkRecords);


  global.Page =
    jest.fn((definition) => {
      pageDefinition =
        definition;
    });


  global.wx = {
    reLaunch: jest.fn(),
    navigateBack:
      jest.fn(),

    navigateTo:
      jest.fn(),

    showModal:
      jest.fn(),

    showToast:
      jest.fn(),

    getStorageSync:
      jest.fn(key => storage[key]),

    setStorageSync:
      jest.fn((key, value) => {
        storage[key] = value;
      }),

    removeStorageSync:
      jest.fn(key => {
        delete storage[key];
      })
  };


  require(
    "../miniprogram/pages/route-detail/route-detail"
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


  pageInstance._routePreferences = { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] };
  return pageInstance;
}


beforeEach(() => {
  page =
    loadRouteDetailPage();
});


afterEach(() => {
  jest.restoreAllMocks();

  delete global.Page;
  delete global.wx;
});

test("direct development Route Detail initializes valid fallback questionnaire context", async () => {
  delete page._routePreferences;
  page.onLoad({ id: mockRoutes[0].routeId });
  expect(page._routePreferences).toEqual({
    durationMinutes: 30,
    routeType: "loop",
    crowdPreference: "medium",
    environmentPreferences: ["公园", "水边", "街道", "商街"]
  });
  await page.beginWalk(mockRoutes[0], false);
  expect(walkRecords.startWalk).toHaveBeenCalledWith({
    routeId: mockRoutes[0].routeId,
    preferences: page._routePreferences,
    trajectoryEnabled: false
  });
});

test("questionnaire context reaches Start separately from the selected route", async () => {
  const eventChannel = createEventChannel();
  page = loadRouteDetailPage({ eventChannel });
  page.onLoad({ id: GENERATED_ROUTE.routeId, from: "routes" });
  const preferences = { durationMinutes: 45, routeType: "loop", crowdPreference: "low", environmentPreferences: ["公园"] };
  eventChannel.handlers.routePreferences(preferences);
  eventChannel.handlers.selectedRoute(GENERATED_ROUTE);
  await page.beginWalk(GENERATED_ROUTE, true);
  expect(walkRecords.startWalk).toHaveBeenCalledWith({ routeId: GENERATED_ROUTE.routeId, preferences, trajectoryEnabled: true });
  expect(storage.activeWalkSession).toMatchObject({ version: 2, walkId: "walk-test", preferences });
  expect(GENERATED_ROUTE).not.toHaveProperty("preferences");
});

test("durable Start failure never creates a local-only walk and remains retryable", async () => {
  walkRecords.startWalk.mockRejectedValueOnce(new Error("database unavailable"));
  await page.beginWalk(GENERATED_ROUTE, false);
  expect(storage.activeWalkSession).toBeUndefined();
  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(page._startingWalk).toBe(false);
  await page.beginWalk(GENERATED_ROUTE, false);
  expect(storage.activeWalkSession.walkId).toBe("walk-test");
  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
});

test("navigation failure after Start keeps durable identity and retry resumes it", async () => {
  wx.navigateTo.mockImplementation(options => { options.fail(); options.complete(); });
  await page.beginWalk(GENERATED_ROUTE, true);
  const local = storage.activeWalkSession;
  await page.beginWalk(GENERATED_ROUTE, false);
  expect(storage.activeWalkSession).toEqual(local);
  expect(walkRecords.startWalk).toHaveBeenCalledTimes(1);
});

test("existing cloud walk on another route blocks Start without local geometry", async () => {
  walkRecords.getActiveWalk.mockResolvedValue({ walkId: "other", routeId: "another-route", status: "active" });
  await page.beginWalk(GENERATED_ROUTE, false);
  expect(walkRecords.startWalk).not.toHaveBeenCalled();
  expect(storage.activeWalkSession).toBeUndefined();
  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("当前设备缺少") }));
});


describe(
  "Route Detail page",
  () => {

    test.each([
      ['point_to_point', false], ['loop', true], ['out_and_back', true]
    ])('normalizes legacy %s return metadata for the legend', (routeType, returnsToStart) => {
      const legacy = { ...GENERATED_ROUTE, routeType };
      delete legacy.returnsToStart;
      expect(page.prepareRoute(legacy).returnsToStart).toBe(returnsToStart);
      expect(legacy.returnsToStart).toBeUndefined();
    });

    test.each([true, false])('preserves explicit returnsToStart=%s', returnsToStart => {
      expect(page.prepareRoute({ ...GENERATED_ROUTE, returnsToStart }).returnsToStart).toBe(returnsToStart);
    });

    test('map legend uses normalized return metadata for its start label and separate endpoint', () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const template = fs.readFileSync(path.join(__dirname,
        '../miniprogram/pages/route-detail/route-detail.wxml'), 'utf8');
      expect(template).toContain("{{route.returnsToStart ? '起点 / 返回点' : '起点'}}");
      expect(template).toMatch(/<view class="legend-item" wx:if="{{!route.returnsToStart}}">\s*<view class="legend-dot end-dot">/);
    });

    test(
      "onLoad waits for a real route from Routes through EventChannel",
      () => {
        const eventChannel =
          createEventChannel();


        page =
          loadRouteDetailPage({
            eventChannel
          });


        page.onLoad({
          id:
            GENERATED_ROUTE.routeId,

          from:
            "routes"
        });


        expect(
          eventChannel.on
        ).toHaveBeenCalledWith(
          "selectedRoute",
          expect.any(Function)
        );


        expect(
          page.data.loading
        ).toBe(true);


        expect(
          page.data.route
        ).toBeNull();


        eventChannel
          .handlers
          .selectedRoute(
            GENERATED_ROUTE
          );


        expect(
          page.data.loading
        ).toBe(false);


        expect(
          page.data.error
        ).toBe(false);


        expect(
          page.data.route.routeId
        ).toBe(
          GENERATED_ROUTE.routeId
        );


        expect(
          page.data.route.distanceKm
        ).toBe(
          "0.3"
        );


        expect(
          page.data.route.routeTypeText
        ).toBe(
          "单程路线"
        );


        expect(
          page.data.route.crowdText
        ).toBe(
          "暂无数据"
        );
      }
    );


    test(
      "a real route uses the full walking polyline and real start/end markers",
      () => {
        page.loadRoute(
          GENERATED_ROUTE
        );


        expect(
          page.data.mapPoints
        ).toEqual(
          GENERATED_ROUTE.polyline
        );


        expect(
          page.data.mapPolyline
        ).toEqual([
          {
            points:
              GENERATED_ROUTE.polyline,

            color:
              "#20BFEA",

            width:
              6
          }
        ]);


        expect(
          page.data.mapLatitude
        ).toBe(
          23.128
        );


        expect(
          page.data.mapLongitude
        ).toBe(
          113.2646
        );


        expect(
          page.data.markers[0]
        ).toEqual(
          expect.objectContaining({
            id:
              1,

            latitude:
              GENERATED_ROUTE
                .startPoint
                .latitude,

            longitude:
              GENERATED_ROUTE
                .startPoint
                .longitude,

            title:
              "起点"
          })
        );


        expect(
          page.data.markers[1]
        ).toEqual(
          expect.objectContaining({
            id:
              2,

            latitude:
              GENERATED_ROUTE
                .endPoint
                .latitude,

            longitude:
              GENERATED_ROUTE
                .endPoint
                .longitude,

            title:
              "1. 人民公园（终点）"
          })
        );
      }
    );


    test(
      "onLoad falls back to mock route lookup when Route Detail is opened directly",
      () => {
        page.onLoad({
          id:
            mockRoutes[0].routeId
        });


        expect(
          page.data.loading
        ).toBe(false);


        expect(
          page.data.error
        ).toBe(false);


        expect(
          page.data.route.routeId
        ).toBe(
          mockRoutes[0].routeId
        );


        expect(
          page.data.mapPoints
        ).toEqual(
          mockRoutes[0].polyline
        );
      }
    );


    test("loop mock routes use the real shared start/end instead of a fake endpoint", () => {
      page.loadRoute(mockRoutes[0]);
      expect(page.data.markers).toHaveLength(1);
      expect(page.data.markers[0]).toMatchObject({
        latitude: mockRoutes[0].startPoint.latitude,
        longitude: mockRoutes[0].startPoint.longitude
      });
    });

    test("detail displays all POIs in route order, including points off the walking polyline", () => {
      const pointsOfInterest = Array.from({ length: 8 }, (_, index) => ({
        poiId: `poi-${index}`, name: `Place ${index}`,
        latitude: 23.13 + index / 100, longitude: 113.27
      }));
      page.loadRoute({ ...GENERATED_ROUTE, pointsOfInterest, endPoint: pointsOfInterest[7] });
      expect(page.data.markers).toHaveLength(9);
      expect(page.data.route.displayPois.map(poi => poi.poiId)).toEqual(pointsOfInterest.map(poi => poi.poiId));
      pointsOfInterest.forEach(poi => {
        expect(page.data.mapPoints).toContainEqual({ latitude: poi.latitude, longitude: poi.longitude });
      });
    });
    test(
      "Route Detail shows error when EventChannel route ID does not match the URL route ID",
      () => {
        const eventChannel =
          createEventChannel();


        page =
          loadRouteDetailPage({
            eventChannel
          });


        page.onLoad({
          id:
            "different-route-id",

          from:
            "routes"
        });


        eventChannel
          .handlers
          .selectedRoute(
            GENERATED_ROUTE
          );


        expect(
          page.data.loading
        ).toBe(false);


        expect(
          page.data.error
        ).toBe(true);


        expect(
          page.data.route
        ).toBeNull();


        expect(
          page.data.mapPoints
        ).toEqual([]);


        expect(
          page.data.mapPolyline
        ).toEqual([]);


        expect(
          page.data.markers
        ).toEqual([]);
      }
    );


    test(
      "Route Detail rejects an invalid route and clears map data",
      () => {
        page.data.mapPoints =
          GENERATED_ROUTE.polyline;

        page.data.mapPolyline = [
          {
            points:
              GENERATED_ROUTE.polyline
          }
        ];

        page.data.markers = [
          {
            id: 1
          }
        ];


        page.loadRoute({
          ...GENERATED_ROUTE,

          polyline: []
        });


        expect(
          page.data.loading
        ).toBe(false);


        expect(
          page.data.error
        ).toBe(true);


        expect(
          page.data.route
        ).toBeNull();


        expect(
          page.data.mapPoints
        ).toEqual([]);


        expect(
          page.data.mapPolyline
        ).toEqual([]);


        expect(
          page.data.markers
        ).toEqual([]);
        
        expect(
        page.data.mapLatitude
        ).toBe(0);

        expect(
        page.data.mapLongitude
        ).toBe(0);
      }
      
    );


    test(
      "replaceRoute returns to the previous page",
      () => {
        page.replaceRoute();


        expect(
          wx.navigateBack
        ).toHaveBeenCalledTimes(
          1
        );
      }
    );


    test(
      "onLoad clears stale transient guards so Start Walk cannot remain stuck after reload",
      () => {
        page._startPromptOpen = true;
        page._startingWalk = true;
        page._activeWalkRedirecting = true;
        page._activeWalkRedirectStartedAtMs =
          Date.now();

        page.onLoad({
          id: mockRoutes[0].routeId
        });

        expect(page._startPromptOpen).toBe(false);
        expect(page._startingWalk).toBe(false);
        expect(page._activeWalkRedirecting).toBe(false);
        expect(
          page._activeWalkRedirectStartedAtMs
        ).toBe(0);
      }
    );


    test(
      "Route Detail recovers from an interrupted redirect lock",
      async () => {
        wx.setStorageSync("activeWalkSession", {
          version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
          status: "active",
          routeId: GENERATED_ROUTE.routeId,
          route: GENERATED_ROUTE,
          startTimeMs: Date.now(),
          trackingEnabled: false
        });

        page._activeWalkRedirecting = true;
        page._activeWalkRedirectStartedAtMs =
          Date.now() - 4000;

        wx.navigateTo.mockClear();

        await page.onShow();

        expect(wx.navigateTo).toHaveBeenCalledWith(
          expect.objectContaining({
            url:
              `/pages/walking/walking?routeId=${encodeURIComponent(
                GENERATED_ROUTE.routeId
              )}`
          })
        );
      }
    );


    test(
      "startWalk confirms, locks the route, and opens Walking",
      async () => {
        const walkingEventChannel = {
          emit: jest.fn()
        };

        wx.showModal.mockImplementation(options => {
          options.success({
            confirm: true,
            cancel: false
          });
        });

        page.loadRoute(GENERATED_ROUTE);
        page.startWalk();
        await flushCloud();

        expect(wx.showModal).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            title: "确认开始这次散步？",
            content: expect.stringContaining("结束本次散步前无法更换路线"),
            confirmText: "开始散步",
            cancelText: "再看看"
          })
        );

        expect(wx.showModal).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            title: "记录实际步行轨迹？",
            content: expect.stringContaining("腾讯轨迹服务"),
            confirmText: "记录轨迹",
            cancelText: "暂不记录"
          })
        );

        expect(wx.setStorageSync).toHaveBeenCalledWith(
          "activeWalkSession",
          expect.objectContaining({
            version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
            status: "active",
            routeId: GENERATED_ROUTE.routeId,
            route: GENERATED_ROUTE,
            startTimeMs: expect.any(Number),
            trackingEnabled: true
          })
        );

        expect(wx.navigateTo).toHaveBeenCalledTimes(1);

        const navigateOptions = wx.navigateTo.mock.calls[0][0];

        expect(navigateOptions.url).toBe(
          `/pages/walking/walking?routeId=${encodeURIComponent(GENERATED_ROUTE.routeId)}`
        );

        navigateOptions.success({
          eventChannel: walkingEventChannel
        });

        expect(walkingEventChannel.emit).toHaveBeenCalledWith(
          "walkingRoute",
          GENERATED_ROUTE
        );
      }
    );


    test(
      "rapid duplicate Start Walk taps open only one confirmation and one Walking page",
      async () => {
        let confirmStart;
        let confirmTracking;

        wx.showModal.mockImplementation(options => {
          if (options.title === "确认开始这次散步？") {
            confirmStart = () => {
              options.success({
                confirm: true,
                cancel: false
              });
            };
            return;
          }

          confirmTracking = () => {
            options.success({
              confirm: true,
              cancel: false
            });
          };
        });

        page.loadRoute(GENERATED_ROUTE);

        page.startWalk();
        await flushCloud();
        page.startWalk();
        await flushCloud();

        expect(wx.showModal).toHaveBeenCalledTimes(1);
        expect(wx.navigateTo).not.toHaveBeenCalled();

        confirmStart();

        expect(wx.showModal).toHaveBeenCalledTimes(2);

        page.startWalk();
        await flushCloud();

        expect(wx.showModal).toHaveBeenCalledTimes(2);
        expect(wx.navigateTo).not.toHaveBeenCalled();

        confirmTracking();
        await flushCloud();

        expect(wx.navigateTo).toHaveBeenCalledTimes(1);
        expect(wx.setStorageSync).toHaveBeenCalledTimes(1);
      }
    );


    test(
      "declining trajectory recording still starts the walk",
      async () => {
        wx.showModal.mockImplementation(options => {
          if (options.title === "确认开始这次散步？") {
            options.success({
              confirm: true,
              cancel: false
            });
            return;
          }

          options.success({
            confirm: false,
            cancel: true
          });
        });

        page.loadRoute(GENERATED_ROUTE);
        page.startWalk();
        await flushCloud();

        expect(wx.setStorageSync).toHaveBeenCalledWith(
          "activeWalkSession",
          expect.objectContaining({
            routeId: GENERATED_ROUTE.routeId,
            trackingEnabled: false
          })
        );

        expect(wx.navigateTo).toHaveBeenCalledTimes(1);
      }
    );


    test(
      "canceling the start confirmation does not create an active walk",
      async () => {
        wx.showModal.mockImplementation(options => {
          options.success({
            confirm: false,
            cancel: true
          });
        });

        page.loadRoute(GENERATED_ROUTE);
        page.startWalk();
        await flushCloud();

        expect(wx.setStorageSync).not.toHaveBeenCalled();
        expect(wx.navigateTo).not.toHaveBeenCalled();
      }
    );


    test(
      "Route Detail resumes an existing active walk instead of allowing another route",
      async () => {
        wx.setStorageSync("activeWalkSession", {
          version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
          status: "active",
          routeId: GENERATED_ROUTE.routeId,
          route: GENERATED_ROUTE,
          startTimeMs: Date.now()
        });

        wx.navigateTo.mockClear();

        await page.onShow();

        expect(wx.navigateTo).toHaveBeenCalledWith(
          expect.objectContaining({
            url: `/pages/walking/walking?routeId=${encodeURIComponent(GENERATED_ROUTE.routeId)}`
          })
        );
      }
    );


    test(
      "Route Detail clears a completed active-walk lock instead of resuming it",
      async () => {
        const startTimeMs = Date.now() - 30 * 60 * 1000;

        wx.setStorageSync("activeWalkSession", {
          version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
          status: "active",
          routeId: GENERATED_ROUTE.routeId,
          route: GENERATED_ROUTE,
          startTimeMs,
          trackingEnabled: true
        });

        wx.setStorageSync("pendingWalkResult", {
          walkId: "walk-test",
          routeId: GENERATED_ROUTE.routeId,
          route: GENERATED_ROUTE,
          startTime: new Date(startTimeMs).toISOString(),
          endTime: new Date(startTimeMs + 10 * 60 * 1000).toISOString(),
          actualDurationSeconds: 600,
          completionStatus: "completed"
        });

        wx.navigateTo.mockClear();

        await page.onShow();

        expect(wx.navigateTo).not.toHaveBeenCalled();
        expect(
          wx.getStorageSync("activeWalkSession")
        ).toBeUndefined();
      }
    );


    test(
      "Route Detail clears a server-abandoned walk instead of resuming it",
      async () => {
        const startTimeMs =
          Date.now() - 13 * 60 * 60 * 1000;

        wx.setStorageSync("activeWalkSession", {
          version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
          status: "active",
          routeId: GENERATED_ROUTE.routeId,
          route: GENERATED_ROUTE,
          startTimeMs,
          trackingEnabled: true
        });
        walkRecords.getWalk.mockResolvedValueOnce({
          walkId: "walk-test",
          routeId: GENERATED_ROUTE.routeId,
          status: "abandoned",
          completionStatus: "abandoned"
        });

        wx.navigateTo.mockClear();

        await page.onShow();

        expect(wx.navigateTo).not.toHaveBeenCalled();
        expect(wx.getStorageSync("activeWalkSession")).toBeUndefined();
        expect(wx.getStorageSync("pendingWalkResult")).toBeUndefined();
        expect(wx.showToast).toHaveBeenCalledWith({
          title: "上一次散步因长时间未结束，已自动关闭",
          icon: "none"
        });
      }
    );


    test(
      "startWalk does nothing while route editing is active",
      async () => {
        page.loadRoute(GENERATED_ROUTE);
        page.data.editing = true;

        page.startWalk();
        await flushCloud();

        expect(wx.showModal).not.toHaveBeenCalled();
        expect(wx.navigateTo).not.toHaveBeenCalled();
      }
    );

  }
);
test("late consent callbacks cannot create a walk after Route Detail unloads", () => {
  page.loadRoute(GENERATED_ROUTE);
  page.requestTrajectoryConsent(GENERATED_ROUTE);
  const modal = wx.showModal.mock.calls[0][0];
  page.onUnload();
  modal.success({ confirm: true });
  expect(wx.getStorageSync("activeWalkSession")).toBeFalsy();
  expect(wx.navigateTo).not.toHaveBeenCalled();
  wx.showModal.mockClear();
  page.requestTrajectoryConsent(GENERATED_ROUTE);
  expect(wx.showModal).not.toHaveBeenCalled();
});
