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

    // 如果是开发阶段直接打开 Routes，
    // 仍然允许使用默认空 preferences 生成路线。
    this.loadRoutes();
  },

  onUnload() {
    // 页面关闭后，让仍在运行的旧请求失效。
    this._routeRequestId =
      (this._routeRequestId || 0) + 1;
  },

  async loadRoutes() {
    // 每次请求都有新的 ID。
    const requestId =
      (this._routeRequestId || 0) + 1;

    this._routeRequestId = requestId;

    // 每次首次加载 / retry
    // 都重新进入 loading。
    this.setData({
      routes: [],
      routeState: "loading"
    });

    try {
      const routes =
        await this.getRoutes();

      // 如果期间已经开始了更新的请求，
      // 当前结果已经过期，直接忽略。
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

      // 正常执行完 pipeline，
      // 但没有找到可用路线。
      if (routes.length === 0) {
        this.setData({
          routes: [],
          routeState: "empty"
        });

        return;
      }

      const preparedRoutes =
        this.prepareRoutes(routes);

      this.setData({
        routes: preparedRoutes,
        routeState: "success"
      });
    } catch (error) {
      // 旧请求的 error 也不能覆盖新请求。
      if (
        requestId !==
        this._routeRequestId
      ) {
        return;
      }

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

    // route-generation service
    // 明确告诉我们这是正常的空结果。
    if (result.status === "empty") {
      return [];
    }

    // 除 success / empty 外，
    // 其他奇怪格式都视为异常。
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

        // 暂时兼容旧 mock 数据。
        quiet: "安静",
        busy: "热闹"
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
      url:
        "/pages/preferences/preferences"
    });
  },

  viewRoute(event) {
    const routeId =
      event.currentTarget.dataset.id;

    wx.navigateTo({
      url:
        `/pages/route-detail/route-detail?id=${routeId}`
    });
  },

  showOtherRoutes() {
    const newRoutes = [
      ...this.data.routes
    ];

    // 当前 ticket 可能只有一条真实路线。
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