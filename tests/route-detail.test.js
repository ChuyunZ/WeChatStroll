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
              "终点"
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


    test(
      "loop mock routes keep start and end markers visible",
      () => {
        page.loadRoute(
          mockRoutes[0]
        );


        expect(
          page.data.markers[0].latitude
        ).toBe(
          mockRoutes[0]
            .polyline[0]
            .latitude
        );


        expect(
          page.data.markers[0].longitude
        ).toBe(
          mockRoutes[0]
            .polyline[0]
            .longitude
        );


        expect(
          page.data.markers[1].latitude
        ).toBe(
          mockRoutes[0]
            .polyline[
              mockRoutes[0]
                .polyline
                .length - 2
            ]
            .latitude
        );


        expect(
          page.data.markers[1].longitude
        ).toBe(
          mockRoutes[0]
            .polyline[
              mockRoutes[0]
                .polyline
                .length - 2
            ]
            .longitude
        );
      }
    );


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
      "startWalk shows the current placeholder toast",
      () => {
        page.startWalk();


        expect(
          wx.showToast
        ).toHaveBeenCalledWith({
          title:
            "准备开始散步",

          icon:
            "none"
        });
      }
    );

  }
);