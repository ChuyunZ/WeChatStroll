const { mockRoutes } = require("../../data/mock-routes");

Page({
  data: {
    routes: [],
    loading: true,
    error: false
  },

  onLoad() {
    this.loadRoutes();
  },

  loadRoutes() {
    this.setData({
      loading: true,
      error: false
    });

    setTimeout(() => {
      const preparedRoutes = this.prepareRoutes(mockRoutes);

      this.setData({
        routes: preparedRoutes,
        loading: false
      });
    }, 2000);
  },

  prepareRoutes(routes) {
    return routes.map((route) => {
      const middleIndex = Math.floor(route.polyline.length / 2);
      const centerPoint = route.polyline[middleIndex];

      const displayTags = route.tags.filter(
        (tag) => tag !== "环形路线"
      );

      let crowdText = "适中";

      if (route.crowdLevel === "quiet") {
        crowdText = "安静";
      } else if (route.crowdLevel === "busy") {
        crowdText = "较拥挤";
      }

      return {
        ...route,

        distanceKm: (route.distanceMeters / 1000).toFixed(1),

        routeTypeText:
          route.routeType === "loop"
            ? "环形路线"
            : "单程路线",

        crowdText,

        displayTags,

        previewLatitude: centerPoint.latitude,
        previewLongitude: centerPoint.longitude,

        previewPolyline: [
          {
            points: route.polyline,
            color: "#20BFEA",
            width: 5
          }
        ]
      };
    });
  },

  viewRoute(event) {
    const routeId = event.currentTarget.dataset.id;

    wx.navigateTo({
      url: `/pages/route-detail/route-detail?id=${routeId}`
    });
  },

  showOtherRoutes() {
    const newRoutes = [...this.data.routes];

    if (newRoutes.length > 1) {
      const firstRoute = newRoutes.shift();
      newRoutes.push(firstRoute);
    }

    this.setData({
      routes: newRoutes
    });

    wx.showToast({
      title: "已更换路线",
      icon: "none"
    });
  }
});