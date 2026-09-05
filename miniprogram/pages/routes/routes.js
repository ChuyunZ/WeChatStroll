const { mockRoutes } = require("../../data/mock-routes");

Page({
  data: {
    routes: [],
    routeState: "loading"
  },

  onLoad() {
    this.loadRoutes();
  },

  onUnload() {
    // Invalidate any request that is still in flight when the page closes.
    this._routeRequestId = (this._routeRequestId || 0) + 1;
  },

  async loadRoutes() {
    // Give every route request a unique increasing ID.
    const requestId = (this._routeRequestId || 0) + 1;
    this._routeRequestId = requestId;

    // Every load/retry starts from the loading state.
    this.setData({
      routes: [],
      routeState: "loading"
    });

    try {
      const routes = await this.getRoutes();

      // A newer request has already started.
      // Ignore this stale response.
      if (requestId !== this._routeRequestId) {
        return;
      }

      if (!Array.isArray(routes)) {
        throw new Error("Invalid route data");
      }

      // Request succeeded, but no routes were found.
      if (routes.length === 0) {
        this.setData({
          routes: [],
          routeState: "empty"
        });
        return;
      }

      const preparedRoutes = this.prepareRoutes(routes);

      this.setData({
        routes: preparedRoutes,
        routeState: "success"
      });
    } catch (error) {
      // A newer request has already started.
      // Ignore errors from stale requests.
      if (requestId !== this._routeRequestId) {
        return;
      }

      console.error("[Routes] Failed to load routes:", error);

      this.setData({
        routes: [],
        routeState: "error"
      });
    }
  },

  getRoutes() {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(mockRoutes);
      }, 2000);
    });
  },

  prepareRoutes(routes) {
    const routeTypeLabels = {
      loop: "环形路线",
      out_and_back: "往返路线",
      point_to_point: "单程路线"
    }

    return routes.map((route) => {
      const middleIndex = Math.floor(route.polyline.length / 2);
      const centerPoint = route.polyline[middleIndex];

      const displayTags = route.tags;

      let crowdText = "未知"

      if (route.crowdLevel === "low") {
        crowdText = "安静"
      } else if (route.crowdLevel === "medium") {
        crowdText = "适中"
      } else if (route.crowdLevel === "high") {
        crowdText = "热闹"
      }

      return {
        ...route,

        distanceKm: (route.distanceMeters / 1000).toFixed(1),

        routeTypeText: routeTypeLabels[route.routeType] || "未知路线",

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

  retryLoadRoutes() {
    this.loadRoutes();
  },

  changePreferences() {
    wx.redirectTo({
      url: "/pages/preferences/preferences"
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