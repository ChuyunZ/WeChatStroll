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
      !route.startPoint ||
      !route.endPoint ||
      !Array.isArray(route.polyline) ||
      route.polyline.length < 2
    ) {
      this.setData({
        loading: false,
        error: true
      });

      return;
    }

    const preparedRoute = this.prepareRoute(route);

    const startPoint = route.startPoint
    const endPoint = route.endPoint

    let endMarkerPoint = endPoint

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
      endMarkerPoint =
        route.polyline[route.polyline.length - 2]
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

          latitude: endMarkerPoint.latitude,
          longitude: endMarkerPoint.longitude,

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
    const routeTypeLabels = {
      loop: "环形路线",
      out_and_back: "往返路线",
      point_to_point: "单程路线"
    }

    let crowdText = "未知"

    if (route.crowdLevel === "low") {
      crowdText = "安静"
    } else if (route.crowdLevel === "medium") {
      crowdText = "适中"
    } else if (route.crowdLevel === "high") {
      crowdText = "热闹"
    }

    const displayTags = route.tags;

    return {
      ...route,

      distanceKm:
        (route.distanceMeters / 1000).toFixed(1),

      routeTypeText: routeTypeLabels[route.routeType] || "未知路线",

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