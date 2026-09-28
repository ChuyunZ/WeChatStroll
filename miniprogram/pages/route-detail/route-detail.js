const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const {
  ROUTE_TYPES
} = require("../../constants/route-types");

Page({
  data: {
    route: null,

    loading: true,
    error: false,

    mapLatitude: 0,
    mapLongitude: 0,

    mapPoints: [],
    mapPolyline: [],
    markers: []
  },

  onLoad(options = {}) {
    const routeId = options.id;

    // 正常从 Routes 页面进入时，
    // 真实 Route 会通过 EventChannel 传过来。
    if (
      options.from === "routes" &&
      typeof this.getOpenerEventChannel === "function"
    ) {
      const eventChannel =
        this.getOpenerEventChannel();

      if (
        eventChannel &&
        typeof eventChannel.on === "function"
      ) {
        eventChannel.on(
          "selectedRoute",
          (route) => {
            if (
              routeId &&
              route &&
              route.routeId &&
              route.routeId !== routeId
            ) {
              this.showRouteError();
              return;
            }

            this.loadRoute(route);
          }
        );

        return;
      }
    }

    // 兼容开发阶段直接通过 routeId
    // 打开旧的 mock Route Detail。
    const mockRoute = mockRoutes.find(
      (item) => item.routeId === routeId
    );

    this.loadRoute(mockRoute);
  },

  loadRoute(route) {
    this.setData({
      loading: true,
      error: false
    });

    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    const preparedRoute =
      this.prepareRoute(route);

    const polyline =
      route.polyline;

    const routeMap = buildRouteMap(route);

    const middleIndex =
      Math.floor(
        polyline.length / 2
      );

    const middlePoint =
      polyline[middleIndex];

    this.setData({
      route: { ...preparedRoute, displayPois: routeMap.displayPois },

      loading: false,
      error: false,

      mapLatitude:
        middlePoint.latitude,

      mapLongitude:
        middlePoint.longitude,

      // 覆盖真实折线和所有地点，包括未落在道路折线上的 POI。
      mapPoints: routeMap.mapPoints,

      mapPolyline: [
        {
          points: polyline,
          color: "#20BFEA",
          width: 6
        }
      ],

      markers: routeMap.markers
    });
  },

  isValidPoint(point) {
    return isValidGeoPoint(point);
  },

  isValidRoute(route) {
    return (
      route &&
      typeof route === "object" &&
      !Array.isArray(route) &&
      Array.isArray(route.polyline) &&
      route.polyline.length >= 2 &&
      route.polyline.every(
        (point) =>
          this.isValidPoint(point)
      )
    );
  },

  showRouteError() {
    this.setData({
      route: null,
      loading: false,
      error: true,

      mapLatitude: 0,
      mapLongitude: 0,

      mapPoints: [],
      mapPolyline: [],
      markers: []
    });
  },

  prepareRoute(route) {
    const crowdTextMap = {
      low: "安静",
      medium: "适中",
      high: "热闹",
      unknown: "暂无数据",

      // 兼容旧 mock 数据。
      quiet: "安静",
      busy: "较拥挤"
    };

    const routeTypeTextMap = {
      [ROUTE_TYPES.LOOP]: "环形路线",
      [ROUTE_TYPES.OUT_AND_BACK]: "往返路线",
      [ROUTE_TYPES.POINT_TO_POINT]: "单程路线"
    };

    const displayTags =
      Array.isArray(route.tags)
        ? route.tags.filter(
            (tag) =>
              tag !== "环形路线"
          )
        : [];

    return {
      ...route,

      distanceKm:
        (
          route.distanceMeters /
          1000
        ).toFixed(1),

      routeTypeText:
        routeTypeTextMap[
          route.routeType
        ] || "步行路线",

      crowdText:
        crowdTextMap[
          route.crowdLevel
        ] || "暂无数据",

      displayTags
    };
  },

  replaceRoute() {
    wx.navigateBack();
  },

  startWalk() {
    wx.showToast({
      title: "准备开始散步",
      icon: "none"
    });
  }
});
