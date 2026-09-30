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


  global.Page =
    jest.fn((definition) => {
      pageDefinition =
        definition;
    });


  global.wx = {
    navigateBack:
      jest.fn(),

    navigateTo:
      jest.fn(),

    showToast:
      jest.fn()
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
      "startWalk opens Walking and passes the confirmed route through EventChannel",
      () => {
        const walkingEventChannel = {
          emit: jest.fn()
        };

        page.loadRoute(GENERATED_ROUTE);
        page.startWalk();

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
      "startWalk does nothing while route editing is active",
      () => {
        page.loadRoute(GENERATED_ROUTE);
        page.data.editing = true;

        page.startWalk();

        expect(wx.navigateTo).not.toHaveBeenCalled();
      }
    );

  }
);