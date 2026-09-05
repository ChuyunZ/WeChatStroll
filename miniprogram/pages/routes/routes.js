const { mockRoutes } = require("../../data/mock-routes");

Page({
  data: {
    routes: [],
    routeState: "loading",
    preferences: null
  },

  onLoad() {
    const app = getApp()
  
    const currentPreferences = app.globalData.currentPreferences
  
    // console.log(
    //   "Routes received preferences:",
    //   currentPreferences
    // )

    this.setData({
      preferences: currentPreferences
    })

    this.loadRoutes()
  },

  onUnload() {
    // Invalidate any request that is still in flight when the page closes.
    this._routeRequestId = (this._routeRequestId || 0) + 1;
  },

  async loadRoutes() {
    // test the preferences are loaded
    // console.log(
    //   "loadRoutes preferences:",
    //   this.data.preferences
    // )

    // Give every route request a unique increasing ID.
    const requestId = (this._routeRequestId || 0) + 1;
    this._routeRequestId = requestId;

    // Every load/retry starts from the loading state.
    this.setData({
      routes: [],
      routeState: "loading"
    });

    try {
      const routes = await this.getRoutes(this.data.preferences);

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

  // TO BE UPDATED
  getRoutes(preferences) {
    // console.log(
    //   "getRoutes preferences:",
    //   preferences
    // )
    
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(mockRoutes);
      }, 2000);
    });
  },

  // TO BE UPDATED
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