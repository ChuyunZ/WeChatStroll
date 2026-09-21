const routeGenerationService = require(
  "../../services/route-generation"
);

const {
  ROUTE_TYPES
} = require("../../constants/route-types");

const DEV_DEFAULT_PREFERENCES = {
  durationMinutes: 30,
  routeType: ROUTE_TYPES.LOOP,
  crowdPreference: "medium",
  environmentPreferences: [
    "公园",
    "水边",
    "街道",
    "商街"
  ]
};

function isValidRoutePlanningSession(session) {
  return (
    session &&
    typeof session === "object" &&
    typeof session.registerVerifiedWaypoints === "function" &&
    typeof session.prefetchSegments === "function" &&
    typeof session.buildRouteForOrder === "function"
  );
}

function isValidWaypointCandidateCache(cache) {
  return (
    cache &&
    typeof cache === "object" &&
    typeof cache.getUnusedCandidates === "function" &&
    typeof cache.markBuilding === "function" &&
    typeof cache.markSuccess === "function" &&
    typeof cache.markFailed === "function" &&
    typeof cache.getSuccessfulRoutes === "function"
  );
}

Page({
  data: {
    routes: [],
    routeState: "loading"
  },

  onLoad(options = {}) {
    this._routePreferences = {};
    this._rawRoutes = [];
    this._routePlanningSession = null;
    this._waypointCandidateCache = null;
    this._routeLocation = null;

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
    // 使用一组完整的默认 preferences。
    this._routePreferences = {
      ...DEV_DEFAULT_PREFERENCES,
      environmentPreferences: [
        ...DEV_DEFAULT_PREFERENCES
          .environmentPreferences
      ]
    };

    this.loadRoutes();
  },

  onUnload() {
    // 页面关闭后，让仍在运行的旧请求失效。
    this._routeRequestId =
      (this._routeRequestId || 0) + 1;

    // Planning Session 只属于当前这一次规划流程。
    // 页面真正销毁后，不再保留其中的 Map / Promise / closure 状态。
    this._routePlanningSession = null;

    this._waypointCandidateCache = null;
    this._routeLocation = null;
  },

  async loadRoutes() {
    const requestId =
      (this._routeRequestId || 0) + 1;

    this._routeRequestId = requestId;

    // 新的 first-route 请求代表新的 Planning Session。
    // 旧 session 不能跨新规划请求继续复用。
    this._routePlanningSession = null;
    this._waypointCandidateCache = null;
    this._routeLocation = null;

    // 新请求开始后，
    // 清除上一批原始 Route。
    this._rawRoutes = [];

    this.setData({
      routes: [],
      routeState: "loading"
    });

    try {
      const routeLoadResult =
        await this.getRoutes();

      // 新请求已经开始，
      // 当前结果已经过期。
      if (
        requestId !==
        this._routeRequestId
      ) {
        return;
      }

      if (
        !routeLoadResult ||
        typeof routeLoadResult !== "object" ||
        !Array.isArray(routeLoadResult.routes)
      ) {
        throw new Error(
          "Invalid route data"
        );
      }

      const routes =
        routeLoadResult.routes;

      if (routes.length === 0) {
        this._rawRoutes = [];
        this._routePlanningSession = null;
        this._waypointCandidateCache = null;
        this._routeLocation = null;

        this.setData({
          routes: [],
          routeState: "empty"
        });

        return;
      }

      if (
        !isValidRoutePlanningSession(
          routeLoadResult.routePlanningSession
        )
      ) {
        throw new Error(
          "Invalid route planning session"
        );
      }

      if (
        !isValidWaypointCandidateCache(
          routeLoadResult.waypointCandidateCache
        )
      ) {
        throw new Error(
          "Invalid waypoint candidate cache"
        );
      }

      // 保存业务层的原始 Route。
      // Route Detail 会拿这个对象。
      this._rawRoutes = routes;

      // Session 是运行时对象，里面包含函数、Map、Promise 和 closure。
      // 因此只保存在 Page 实例的私有字段里，不放进 data。
      this._routePlanningSession =
        routeLoadResult.routePlanningSession;
      
      this._waypointCandidateCache =
        routeLoadResult.waypointCandidateCache;

      this._routeLocation = routeLoadResult.location;

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
      this._routePlanningSession = null;
      this._waypointCandidateCache = null;
      this._routeLocation = null;

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
        .generateRoutes(
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
      return {
        routes: [],
        routePlanningSession: null,
        waypointCandidateCache: null
      };
    }

    if (
      result.status !== "success" ||
      !Array.isArray(result.routes) ||
      !isValidRoutePlanningSession(
        result.routePlanningSession
      ) ||
      !isValidWaypointCandidateCache(
        result.waypointCandidateCache
      )
    ) {
      throw new Error(
        "Invalid route generation result"
      );
    }

    return {
      routes: result.routes,
      routePlanningSession:
        result.routePlanningSession,
      waypointCandidateCache:
        result.waypointCandidateCache,
      location: result.location
    }
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
        [ROUTE_TYPES.LOOP]: "环形路线",
        [ROUTE_TYPES.OUT_AND_BACK]: "往返路线",
        [ROUTE_TYPES.POINT_TO_POINT]: "单程路线"
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

  async showOtherRoutes() {
    const unusedCandidates = this._waypointCandidateCache.getUnusedCandidates();

    if (unusedCandidates.length === 0) {
      wx.showToast({
        title: "暂无更多路线",
        icon: "none"
      });
    
      return;
    }

    let routeReplaced = false;
    for (const [candidateIndex, candidate] of unusedCandidates.entries()) {
      this._waypointCandidateCache.markBuilding(candidate.candidateId);
    
      const walkingRoute = await this._routePlanningSession.buildRouteForOrder({
            allowedWaypointIds: candidate.waypointIds,
            orderedWaypointIds: candidate.waypointIds,
            source: "ai"});
    
      if (!walkingRoute || walkingRoute.success !== true) {
        this._waypointCandidateCache.markFailed(candidate.candidateId);
        continue;
      }

      const route = routeGenerationService.buildGeneratedRouteFromAiCandidate(
        {location: this._routeLocation,
          walkingRoute,
          candidateIndex
        })

      this._waypointCandidateCache.markSuccess(candidate.candidateId, route)

      const newRawRoutes = [...this._rawRoutes]
      
      // 删掉第一条
      newRawRoutes.shift()
      newRawRoutes.push(route)
      this._rawRoutes = newRawRoutes

      routeReplaced = true;
      break;
    }

    if (!routeReplaced) {
      wx.showToast({
        title: "暂无更多路线",
        icon: "none"
      });
    
      return;
    }

    const preparedRoutes = this.prepareRoutes(this._rawRoutes);

    this.setData({routes: preparedRoutes});

    wx.showToast({
      title: "已更换路线",
      icon: "none"
    });
  }
});