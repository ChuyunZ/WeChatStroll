const routeGenerationService = require(
  "../../services/route-generation"
);

Page({
  data: {
    routes: [],
    routeState: "loading"
  },

  onLoad(options = {}) {
    this._routePreferences = {};
    this._rawRoutes = [];

    // 从 Preferences 页面进入时，
    // 等待 EventChannel 把问卷结果传过来。
    if (
      options.from === "preferences" &&
      typeof this.getOpenerEventChannel === "function"
    ) {
      const eventChannel =
        this.getOpenerEventChannel();

      if (
        eventChannel &&
        typeof eventChannel.on === "function"
      ) {
        eventChannel.on(
          "routePreferences",
          (preferences) => {
            this._routePreferences =
              preferences &&
              typeof preferences === "object" &&
              !Array.isArray(preferences)
                ? preferences
                : {};

            this.loadRoutes();
          }
        );

        return;
      }
    }

    // 开发阶段直接打开 Routes 时，
    // 允许使用默认空 preferences。
    this.loadRoutes();
  },

  onUnload() {
    // 页面关闭后，让仍在运行的旧请求失效。
    this._routeRequestId =
      (this._routeRequestId || 0) + 1;
  },

  async loadRoutes() {
    const requestId =
      (this._routeRequestId || 0) + 1;

    this._routeRequestId = requestId;

    // 新请求开始后，
    // 清除上一批原始 Route。
    this._rawRoutes = [];

    this.setData({
      routes: [],
      routeState: "loading"
    });

    try {
      const routes =
        await this.getRoutes();

      // 新请求已经开始，
      // 当前结果已经过期。
      if (
        requestId !==
        this._routeRequestId
      ) {
        return;
      }

      if (!Array.isArray(routes)) {
        throw new Error(
          "Invalid route data"
        );
      }

      if (routes.length === 0) {
        this._rawRoutes = [];

        this.setData({
          routes: [],
          routeState: "empty"
        });

        return;
      }

      // 保存业务层的原始 Route。
      // Route Detail 会拿这个对象。
      this._rawRoutes = routes;

      const preparedRoutes =
        this.prepareRoutes(routes);

      this.setData({
        routes: preparedRoutes,
        routeState: "success"
      });
    } catch (error) {
      if (
        requestId !==
        this._routeRequestId
      ) {
        return;
      }

      this._rawRoutes = [];

      console.error(
        "[Routes] Failed to load routes:",
        error
      );

      this.setData({
        routes: [],
        routeState: "error"
      });
    }
  },

  async getRoutes() {
    const result =
      await routeGenerationService
        .generateFirstRoute(
          this._routePreferences || {}
        );

    if (
      !result ||
      typeof result !== "object"
    ) {
      throw new Error(
        "Invalid route generation result"
      );
    }

    if (result.status === "empty") {
      return [];
    }

    if (
      result.status !== "success" ||
      !result.route
    ) {
      throw new Error(
        "Invalid route generation result"
      );
    }

    // 当前 ticket 只生成第一条真实路线。
    return [
      result.route
    ];
  },

  prepareRoutes(routes) {
    return routes.map((route) => {
      const middleIndex =
        Math.floor(
          route.polyline.length / 2
        );

      const centerPoint =
        route.polyline[middleIndex];

      const displayTags =
        Array.isArray(route.tags)
          ? route.tags.filter(
              (tag) =>
                tag !== "环形路线"
            )
          : [];

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

        displayTags,

        previewLatitude:
          centerPoint.latitude,

        previewLongitude:
          centerPoint.longitude,

        previewPolyline: [
          {
            points:
              route.polyline,

            color:
              "#20BFEA",

            width:
              5
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
      url:
        "/pages/preferences/preferences"
    });
  },

  viewRoute(event) {
    const routeId =
      event.currentTarget.dataset.id;

    const rawRoutes =
      Array.isArray(this._rawRoutes)
        ? this._rawRoutes
        : [];

    // 优先拿没有 UI 辅助字段的原始 Route。
    let selectedRoute =
      rawRoutes.find(
        (route) =>
          route.routeId === routeId
      );

    // 兼容开发 / 测试场景。
    if (!selectedRoute) {
      selectedRoute =
        this.data.routes.find(
          (route) =>
            route.routeId === routeId
        );
    }

    if (!selectedRoute) {
      wx.showToast({
        title: "无法打开这条路线",
        icon: "none"
      });

      return;
    }

    wx.navigateTo({
      url:
        `/pages/route-detail/route-detail?id=${routeId}&from=routes`,

      success(res) {
        if (
          res.eventChannel &&
          typeof res.eventChannel.emit === "function"
        ) {
          res.eventChannel.emit(
            "selectedRoute",
            selectedRoute
          );
        }
      }
    });
  },

  showOtherRoutes() {
    const newRoutes = [
      ...this.data.routes
    ];

    if (newRoutes.length <= 1) {
      wx.showToast({
        title: "暂无其他路线",
        icon: "none"
      });

      return;
    }

    const firstRoute =
      newRoutes.shift();

    newRoutes.push(firstRoute);

    this.setData({
      routes: newRoutes
    });

    wx.showToast({
      title: "已更换路线",
      icon: "none"
    });
  }
});