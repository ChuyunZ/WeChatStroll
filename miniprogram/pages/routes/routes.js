const routeGenerationService = require(
  "../../services/route-generation"
);
const { buildRouteMap } = require("../../utils/route-map");
const routeRankingService = require("../../services/route-ranking");
const { waypointSetKey } = require("../../services/agentic-route-planning");
const { isProviderUnavailableCode } = require("../../utils/provider-errors");
const { validateGeneratedWalkingRoute } = require("../../services/route-validation");
const { isValidEditableOrder, routeEditErrorMessage } = require("../../services/route-editing");

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

// Recommendation identity remains the complete verified set after a user edit.
function routeWaypointSetKey(route) {
  const ids = route.recommendedWaypointIds ||
    (route.editableWaypoints || route.pointsOfInterest || []).map(poi => poi.poiId);
  return ids.length && ids.every(id => typeof id === "string" && id.trim())
    ? waypointSetKey(ids) : null;
}

function isValidRoutePlanningSession(session) {
  return (
    session &&
    typeof session === "object" &&
    typeof session.registerVerifiedWaypoints === "function" &&
    typeof session.prefetchSegments === "function" &&
    typeof session.evaluateRouteOrder === "function" &&
    typeof session.getWaypointSearchData === "function" &&
    typeof session.getCachedSegmentCosts === "function" &&
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
    manualAlternativeAction: "",
    manualAlternativePending: false,
    replacementSelection: false,
    replacingRouteId: "",
    isLoadingMoreRoutes: false,
    routes: [],
    routeState: "loading"
  },

  onLoad(options = {}) {
    this._routePreferences = {};
    this._rawRoutes = [];
    this._routePlanningSession = null;
    this._waypointCandidateCache = null;
    this._routeLocation = null;
    this._historicalPreferenceProfile = null;

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
    this.resetManualAlternatives();
    // 页面关闭后，让仍在运行的旧请求失效。
    this._routeRequestId =
      (this._routeRequestId || 0) + 1;

    // Planning Session 只属于当前这一次规划流程。
    // 页面真正销毁后，不再保留其中的 Map / Promise / closure 状态。
    this._routePlanningSession = null;

    this._waypointCandidateCache = null;
    this._routeLocation = null;
    this._historicalPreferenceProfile = null;
  },

  async loadRoutes() {
    this.resetManualAlternatives();
    const requestId =
      (this._routeRequestId || 0) + 1;

    this._routeRequestId = requestId;

    // 新的 first-route 请求代表新的 Planning Session。
    // 旧 session 不能跨新规划请求继续复用。
    this._routePlanningSession = null;
    this._waypointCandidateCache = null;
    this._routeLocation = null;
    this._historicalPreferenceProfile = null;

    // 新请求开始后，
    // 清除上一批原始 Route。
    this._rawRoutes = [];

    this.setData({
      routes: [],
      manualAlternativeAction: "",
      manualAlternativePending: false,
      replacementSelection: false,
      replacingRouteId: "",
      isLoadingMoreRoutes: false,
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
        this._historicalPreferenceProfile = null;

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
      this._historicalPreferenceProfile = routeLoadResult.historicalPreferenceProfile || null;
      this._rawRoutes = this.rankCurrentRoutes(routes);
      this._rawRoutes.forEach(route => this.rememberSurfacedRoute(route));

      // Session 是运行时对象，里面包含函数、Map、Promise 和 closure。
      // 因此只保存在 Page 实例的私有字段里，不放进 data。
      this._routePlanningSession =
        routeLoadResult.routePlanningSession;
      
      this._waypointCandidateCache =
        routeLoadResult.waypointCandidateCache;

      this._routeLocation = routeLoadResult.location;

      const preparedRoutes =
        this.prepareRoutes(this._rawRoutes);

      this.setData({
        routes: preparedRoutes,
        routeState: "success"
      });
      // Do not await the remainder before making the first route usable.
      this._initialFillPromise = this.fillInitialRoutes(requestId);
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
      this._historicalPreferenceProfile = null;

      console.error(
        "[Routes] Failed to load routes:",
        { code: error && error.code || "ROUTE_LOAD_FAILED" }
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
      location: result.location,
      historicalPreferenceProfile: result.historicalPreferenceProfile || null
    }
  },

  async fillInitialRoutes(requestId) {
    const session = this._routePlanningSession;
    const candidateCache = this._waypointCandidateCache;
    const location = this._routeLocation;
    const requestedDurationMinutes = (this._routePreferences || {}).durationMinutes;
    const isCurrent = () => requestId === this._routeRequestId &&
      session === this._routePlanningSession && candidateCache === this._waypointCandidateCache;
    const candidates = this.getEligibleCandidates();
    this.setData({ isLoadingMoreRoutes: this._rawRoutes.length < 3 && candidates.length > 0 });
    try {
      for (const candidate of candidates) {
        if (!isCurrent() || this._rawRoutes.length >= 3) break;
        if (this._seenWaypointSetKeys.has(waypointSetKey(candidate.waypointIds))) {
          candidateCache.markFailed(candidate.candidateId);
          continue;
        }
        try {
          const result = await routeGenerationService.buildOptimizedCandidateRoute({
            session, candidateCache, candidate, location,
            candidateIndex: Number(candidate.candidateId.split("-").pop()) - 1,
            requestedDurationMinutes
          });
          if (!isCurrent()) return;
          if (!result.success || !this.isUnseenCandidateRoute(result.route, candidate)) continue;
          this._rawRoutes = this.rankCurrentRoutes([...this._rawRoutes, result.route]);
          this.rememberSurfacedRoute(result.route);
          this.setData({ routes: this.prepareRoutes(this._rawRoutes) });
        } catch (error) {
          if (!isCurrent()) return;
          candidateCache.markFailed(candidate.candidateId);
          console.warn("[Routes] Background candidate failed:", { candidateId: candidate.candidateId, code: error && error.code || "UNEXPECTED_CANDIDATE_ERROR" });
        }
      }
    } finally {
      routeGenerationService.logCandidateSummary(candidateCache);
      if (isCurrent()) {
        this._initialCandidateProcessingComplete = true;
        this.setData({ isLoadingMoreRoutes: false });
        this.updateManualAlternativeControls();
      }
    }
  },

  rankCurrentRoutes(routes) {
    return routeRankingService.rankRoutes(routes, {
      preferences: this._routePreferences || {},
      historicalPreferenceProfile: this._historicalPreferenceProfile
    });
  },

  prepareRoutes(routes) {
    return routes.map((route, index) => {
      const routeMap = buildRouteMap(route);
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
        isBestMatch: routes.length >= 2 && index === 0,
        displayPois: routeMap.displayPois,
        previewMarkers: routeMap.markers,
        previewPoints: routeMap.mapPoints,

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
    this.onUnload();
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

    const session = this._routePlanningSession;
    const generationId = this._routeRequestId;
    let channel;
    let latestRequestId;
    let preview;
    let closed = false;
    const isCurrent = () => !closed && session && session === this._routePlanningSession &&
      generationId === this._routeRequestId &&
      this._rawRoutes.includes(selectedRoute);
    const respond = (eventName, result) => {
      if (!closed && channel) channel.emit(eventName, result);
    };

    wx.navigateTo({
      url:
        `/pages/route-detail/route-detail?id=${routeId}&from=routes`,
      events: {
        previewRoute: async (request = {}) => {
          latestRequestId = request.requestId;
          preview = null;
          const reply = { routeId, requestId: request.requestId };
          try {
            if (!isCurrent() || request.routeId !== routeId ||
                !isValidEditableOrder(selectedRoute, request.orderedWaypointIds)) throw new Error('Invalid edit');
            const walkingRoute = await session.buildRouteForOrder({
              allowedWaypointIds: selectedRoute.editableWaypoints.map(poi => poi.poiId),
              orderedWaypointIds: [...request.orderedWaypointIds],
              source: 'user'
            });
            if (latestRequestId !== request.requestId || closed) return;
            if (!isCurrent()) throw new Error('Expired session');
            if (!walkingRoute || !walkingRoute.success) throw walkingRoute;
            // Explicit user edits may exceed the original recommendation duration.
            const validation = validateGeneratedWalkingRoute(walkingRoute, {
              allowedWaypointIds: request.orderedWaypointIds
            });
            if (!validation.valid) throw validation;
            preview = routeGenerationService.rebuildGeneratedRouteForOrder({ baseRoute: selectedRoute, walkingRoute });
            respond('routePreviewResult', { ...reply, route: preview });
          } catch (error) {
            if (latestRequestId === request.requestId) {
              respond('routePreviewResult', { ...reply, message: routeEditErrorMessage(error) });
            }
          }
        },
        confirmRoute: (request = {}) => {
          if (!isCurrent() || request.routeId !== routeId ||
              request.requestId !== latestRequestId || !preview) {
            respond('routeConfirmResult', { routeId, requestId: request.requestId,
              message: '路线已过期，请返回路线列表重试' });
            return;
          }
          // Only promote a route built here; never trust route facts from the UI.
          this._rawRoutes = this.rankCurrentRoutes(this._rawRoutes.map(route => route === selectedRoute ? preview : route));
          selectedRoute = preview;
          preview = null;
          this.rememberSurfacedRoute(selectedRoute);
          this.setData({ routes: this.prepareRoutes(this._rawRoutes) });
          this.updateManualAlternativeControls();
          respond('routeConfirmResult', { routeId, requestId: request.requestId, route: selectedRoute });
        },
        invalidateRoutePreview: () => { latestRequestId = null; preview = null; },
        closeRouteEditor: () => { closed = true; preview = null; channel = null; }
      },
      success: (res) => {
        channel = res.eventChannel;
        if (
          res.eventChannel &&
          typeof res.eventChannel.emit === "function"
        ) {
          res.eventChannel.emit("routePreferences", this._routePreferences);
          res.eventChannel.emit(
            "selectedRoute",
            selectedRoute
          );
        }
      }
    });
  },

  resetManualAlternatives() {
    this._manualAlternativeActionCount = 0;
    this._seenWaypointSetKeys = new Set();
    this._initialCandidateProcessingComplete = false;
    this._replacementSelection = false;
    this._manualAlternativePending = null;
  },

  rememberSurfacedRoute(route) {
    if (!this._seenWaypointSetKeys) this._seenWaypointSetKeys = new Set();
    const key = routeWaypointSetKey(route);
    if (key) this._seenWaypointSetKeys.add(key);
    // Confirmed edits can surface a subset too; keep both identities excluded.
    const activeIds = route.routeOrder && route.routeOrder.orderedWaypointIds;
    if (activeIds && activeIds.length) this._seenWaypointSetKeys.add(waypointSetKey(activeIds));
  },

  getEligibleCandidates() {
    if (!this._waypointCandidateCache) return [];
    return this._waypointCandidateCache.getUnusedCandidates().filter(candidate =>
      !this._seenWaypointSetKeys.has(waypointSetKey(candidate.waypointIds)));
  },

  isUnseenCandidateRoute(route, candidate) {
    if (!route) return false;
    const key = routeWaypointSetKey(route);
    return key && key === waypointSetKey(candidate.waypointIds) && !this._seenWaypointSetKeys.has(key);
  },

  getManualAlternativeAction() {
    const count = (this._rawRoutes || []).length;
    if (!this._initialCandidateProcessingComplete || this._manualAlternativePending ||
        !this._routePlanningSession || this._manualAlternativeActionCount >= 3 ||
        count < 1 || count > 3 || !this.getEligibleCandidates().length) return "";
    return count < 3 ? "add" : "replace";
  },

  updateManualAlternativeControls() {
    const action = this.getManualAlternativeAction();
    if (!action && !this._manualAlternativePending) this._replacementSelection = false;
    this.setData({
      manualAlternativeAction: action,
      manualAlternativePending: !!this._manualAlternativePending,
      replacementSelection: this._replacementSelection,
      replacingRouteId: this._manualAlternativePending && this._manualAlternativePending.routeId || ""
    });
  },

  showOtherRoutes() {
    const action = this.getManualAlternativeAction();
    if (action === "add") return this.buildManualAlternative();
    if (action === "replace") {
      this._replacementSelection = true;
      this.updateManualAlternativeControls();
    }
  },

  cancelReplacementSelection() {
    if (this._manualAlternativePending) return;
    this._replacementSelection = false;
    this.updateManualAlternativeControls();
  },

  selectRouteToReplace(event) {
    if (!this._replacementSelection || this.getManualAlternativeAction() !== "replace") return;
    const route = this._rawRoutes.find(item => item.routeId === event.currentTarget.dataset.id);
    if (route) return this.buildManualAlternative(route);
  },

  async buildManualAlternative(selectedRoute = null) {
    const action = this.getManualAlternativeAction();
    if ((!selectedRoute && action !== "add") ||
        (selectedRoute && (action !== "replace" || !this._replacementSelection ||
          !this._rawRoutes.includes(selectedRoute)))) return;
    const requestId = this._routeRequestId;
    const session = this._routePlanningSession;
    const candidateCache = this._waypointCandidateCache;
    const location = this._routeLocation;
    const unusedCandidates = this.getEligibleCandidates();
    const operation = { routeId: selectedRoute ? selectedRoute.routeId : "" };

    const isCurrent = () => requestId === this._routeRequestId &&
      session === this._routePlanningSession &&
      candidateCache === this._waypointCandidateCache && this._manualAlternativePending === operation;
    this._manualAlternativePending = operation;
    this._replacementSelection = false;
    this.updateManualAlternativeControls();
    try {
      for (const candidate of unusedCandidates) {
        if (!isCurrent() || (selectedRoute && !this._rawRoutes.includes(selectedRoute))) return;
        if (this._seenWaypointSetKeys.has(waypointSetKey(candidate.waypointIds))) continue;
        let result;
        try {
          result = await routeGenerationService.buildOptimizedCandidateRoute({
            session, candidateCache, candidate, location,
            candidateIndex: Number(candidate.candidateId.split("-").pop()) - 1,
            requestedDurationMinutes: (this._routePreferences || {}).durationMinutes
          });
        } catch (error) {
          if (!isCurrent()) return;
          // The shared builder normally settles exceptions itself.
          candidateCache.markFailed(candidate.candidateId);
          if (error && [error.code, error.error, error.causeCode].some(isProviderUnavailableCode)) {
            wx.showToast({ title: "路线服务暂时繁忙，请稍后重新规划", icon: "none" });
            return;
          }
          continue;
        }
        if (!isCurrent() || (selectedRoute && !this._rawRoutes.includes(selectedRoute))) return;
        if (!result.success) {
          if ([result.error, result.code, result.causeCode,
            result.failedSegment && result.failedSegment.causeCode,
            result.failedSegment && result.failedSegment.error].some(isProviderUnavailableCode)) {
            wx.showToast({ title: "路线服务暂时繁忙，请稍后重新规划", icon: "none" });
            return;
          }
          continue;
        }
        if (!this.isUnseenCandidateRoute(result.route, candidate)) continue;

        const newRawRoutes = selectedRoute
          ? this._rawRoutes.map(route => route === selectedRoute ? result.route : route)
          : [...this._rawRoutes, result.route];
        this._rawRoutes = this.rankCurrentRoutes(newRawRoutes);
        this.rememberSurfacedRoute(result.route);
        this._manualAlternativeActionCount++;
        this.setData({ routes: this.prepareRoutes(this._rawRoutes) });
        wx.showToast({ title: selectedRoute ? "已更换路线" : "已增加路线", icon: "none" });
        return;
      }
      if (isCurrent()) wx.showToast({ title: "暂无更多路线", icon: "none" });
    } catch (error) {
      if (isCurrent()) wx.showToast({ title: "路线加载失败，请稍后再试", icon: "none" });
    } finally {
      if (isCurrent()) {
        this._manualAlternativePending = null;
        this.updateManualAlternativeControls();
      }
      routeGenerationService.logCandidateSummary(candidateCache);
    }
  }
});
