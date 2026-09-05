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

  onLoad(options) {
    const routeId = options.id;

    this.loadRoute(routeId);
  },

  loadRoute(routeId) {
    this.setData({
      loading: true,
      error: false
    });

    const route = mockRoutes.find(
      (item) => item.routeId === routeId
    );

    if (
      !route ||
      !route.polyline ||
      route.polyline.length < 2
    ) {
      this.setData({
        loading: false,
        error: true
      });

      return;
    }

    const preparedRoute = this.prepareRoute(route);

    const startPoint = route.polyline[0];

    let endPoint =
      route.polyline[route.polyline.length - 1];

    /*
     * Loop routes in our mock data currently end
     * at the same coordinate as the start point.
     *
     * If that happens, use the previous point for
     * the end marker so both markers remain visible.
     */
    if (
      startPoint.latitude === endPoint.latitude &&
      startPoint.longitude === endPoint.longitude &&
      route.polyline.length >= 3
    ) {
      endPoint =
        route.polyline[route.polyline.length - 2];
    }

    const middleIndex =
      Math.floor(route.polyline.length / 2);

    const middlePoint =
      route.polyline[middleIndex];

    this.setData({
      route: preparedRoute,

      loading: false,
      error: false,

      mapLatitude: middlePoint.latitude,
      mapLongitude: middlePoint.longitude,

      mapPoints: route.polyline,

      mapPolyline: [
        {
          points: route.polyline,
          color: "#20BFEA",
          width: 6
        }
      ],

      markers: [
        {
          id: 1,

          latitude: startPoint.latitude,
          longitude: startPoint.longitude,

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

          latitude: endPoint.latitude,
          longitude: endPoint.longitude,

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

  prepareRoute(route) {
    let crowdText = "适中";

    if (route.crowdLevel === "quiet") {
      crowdText = "安静";
    } else if (route.crowdLevel === "busy") {
      crowdText = "较拥挤";
    }

    const displayTags = route.tags.filter(
      (tag) => tag !== "环形路线"
    );

    return {
      ...route,

      distanceKm:
        (route.distanceMeters / 1000).toFixed(1),

      routeTypeText:
        route.routeType === "loop"
          ? "环形路线"
          : "单程路线",

      crowdText,

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