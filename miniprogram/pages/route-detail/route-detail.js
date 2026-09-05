const { mockRoutes } = require("../../data/mock-routes");

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

    const startPoint =
      this.getRouteStartPoint(route);

    let endPoint =
      this.getRouteEndPoint(route);

    /*
     * 旧 mock loop route 的终点与起点完全重合时，
     * 使用倒数第二个 polyline point 作为终点 marker，
     * 避免两个 marker 完全叠在一起。
     */
    if (
      startPoint.latitude === endPoint.latitude &&
      startPoint.longitude === endPoint.longitude &&
      polyline.length >= 3
    ) {
      endPoint =
        polyline[polyline.length - 2];
    }

    const middleIndex =
      Math.floor(
        polyline.length / 2
      );

    const middlePoint =
      polyline[middleIndex];

    this.setData({
      route: preparedRoute,

      loading: false,
      error: false,

      mapLatitude:
        middlePoint.latitude,

      mapLongitude:
        middlePoint.longitude,

      // include-points 使用整条真实 polyline，
      // 让地图自动覆盖完整路线。
      mapPoints: polyline,

      mapPolyline: [
        {
          points: polyline,
          color: "#20BFEA",
          width: 6
        }
      ],

      markers: [
        {
          id: 1,

          latitude:
            startPoint.latitude,

          longitude:
            startPoint.longitude,

          width: 28,
          height: 36,

          title: "起点",

          label: {
            content: "起点",
            color: "#ffffff",
            fontSize: 12,
            borderRadius: 12,
            bgColor: "#58b978",
            padding: 5,
            textAlign: "center"
          }
        },

        {
          id: 2,

          latitude:
            endPoint.latitude,

          longitude:
            endPoint.longitude,

          width: 28,
          height: 36,

          title: "终点",

          label: {
            content: "终点",
            color: "#ffffff",
            fontSize: 12,
            borderRadius: 12,
            bgColor: "#e66a63",
            padding: 5,
            textAlign: "center"
          }
        }
      ]
    });
  },

  isValidPoint(point) {
    return (
      point &&
      typeof point === "object" &&
      !Array.isArray(point) &&
      typeof point.latitude === "number" &&
      typeof point.longitude === "number" &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      point.latitude >= -90 &&
      point.latitude <= 90 &&
      point.longitude >= -180 &&
      point.longitude <= 180
    );
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

  getRouteStartPoint(route) {
    if (
      this.isValidPoint(
        route.startPoint
      )
    ) {
      return route.startPoint;
    }

    return route.polyline[0];
  },

  getRouteEndPoint(route) {
    if (
      this.isValidPoint(
        route.endPoint
      )
    ) {
      return route.endPoint;
    }

    return route.polyline[
      route.polyline.length - 1
    ];
  },

  showRouteError() {
    this.setData({
      route: null,
      loading: false,
      error: true,
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
      loop: "环形路线",
      out_and_back: "往返路线",
      point_to_point: "单程路线"
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