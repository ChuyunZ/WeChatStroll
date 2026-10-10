const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const { isValidEditableOrder } = require("../../services/route-editing");
const activeWalkSessionService = require("../../services/active-walk-session");
const {
  ROUTE_TYPES
} = require("../../constants/route-types");

const walkRecords = require("../../services/walk-records");
const routeCopy = require("../../services/route-copy");

const ACTIVE_WALK_REDIRECT_LOCK_MS = 3000;

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

Page({
  data: {
    route: null,

    loading: true,
    error: false,
    canEdit: false,
    editing: false,
    previewLoading: false,
    confirming: false,
    hasPreview: false,
    editMessage: "",
    draftWaypointIds: [],
    activeWaypoints: [],
    removedWaypoints: [],

    mapLatitude: 0,
    mapLongitude: 0,

    mapPoints: [],
    mapPolyline: [],
    markers: []
  },

  onLoad(options = {}) {
    this._unloaded = false;
    this._startPromptOpen = false;
    this._startingWalk = false;
    this._activeWalkRedirecting = false;
    this._activeWalkRedirectStartedAtMs = 0;
    this._routeDetailVisible = false;
    this._walkReconcileEpoch = 0;
    this._awaitingSelectedRoute = options.from === "routes";

    const routeId = options.id;
    this._routePreferences =
      options.from === "routes"
        ? null
        : walkRecords.preferencesSnapshot(
            DEV_DEFAULT_PREFERENCES
          );

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
        this._eventChannel = eventChannel;
        this._copyContextHandler = value => this.receiveCopyContext(value);
        eventChannel.on("routeCopyContext", this._copyContextHandler);
        this._preferencesHandler = value => {
          if (this._unloaded) return;
          this._routePreferences = walkRecords.preferencesSnapshot(value);
        };
        eventChannel.on("routePreferences", this._preferencesHandler);
        this._previewHandler = result => this.receiveRoutePreview(result);
        this._confirmHandler = result => this.receiveRouteConfirmation(result);
        eventChannel.on("routePreviewResult", this._previewHandler);
        eventChannel.on("routeConfirmResult", this._confirmHandler);
        this._selectedRouteHandler = route => {
          if (this._unloaded) return;
          if (
            routeId &&
            route &&
            route.routeId &&
            route.routeId !== routeId
          ) {
            this.showRouteError();
            return;
          }

          this._awaitingSelectedRoute = false;
          this.loadRoute(route);
          // onShow can run before the opener delivers the selected route.
          // Reconcile only once a usable route snapshot is available.
          if (this._routeDetailVisible && this._confirmedRoute) void this.onShow();
        };
        eventChannel.on("selectedRoute", this._selectedRouteHandler);

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

  async onShow() {
    if (this._unloaded) return;
    this._routeDetailVisible = true;
    const checkEpoch = (this._walkReconcileEpoch || 0) + 1;
    this._walkReconcileEpoch = checkEpoch;
    if (this._startingWalk ||
        (this._awaitingSelectedRoute && !this._confirmedRoute)) return;

    if (this._activeWalkRedirecting) {
      const redirectAgeMs =
        Date.now() - this._activeWalkRedirectStartedAtMs;

      if (
        Number.isFinite(redirectAgeMs) &&
        redirectAgeMs >= 0 &&
        redirectAgeMs < ACTIVE_WALK_REDIRECT_LOCK_MS
      ) {
        return;
      }

      this._activeWalkRedirecting = false;
      this._activeWalkRedirectStartedAtMs = 0;
    }

    let activeSession;

    try {
      activeSession = await activeWalkSessionService.reconcileActiveWalk(this._confirmedRoute);
    } catch (error) {
      if (this._unloaded || !this._routeDetailVisible ||
          checkEpoch !== this._walkReconcileEpoch) return;
      wx.showToast({
        title:
          error.code === "WALK_ROUTE_UNAVAILABLE" || error.code === "WALK_ABANDONED"
            ? error.message
            : "暂时无法恢复散步状态，请重试",
        icon: "none"
      });
      return;
    }

    if (this._unloaded || !this._routeDetailVisible ||
        checkEpoch !== this._walkReconcileEpoch || this._startingWalk) return;
    if (activeSession) {
      this.resumeActiveWalk(activeSession);
    } else {
      // Feedback is optional. Once the user chooses to view another route,
      // discard only the previous local feedback handoff, never the walk record.
      try {
        const pending = activeWalkSessionService.getPendingWalkResult();
        if (pending && pending.walkId) {
          activeWalkSessionService.clearPendingWalkResult(pending.walkId);
        }
      } catch (error) {
        // An optional local handoff must not break viewing the selected route.
        // Keep the durable walk record untouched; cleanup can be retried later.
        console.warn("[Route Detail] Could not clear pending feedback handoff.", error);
      }
    }
  },

  onHide() {
    this._routeDetailVisible = false;
    this._walkReconcileEpoch = (this._walkReconcileEpoch || 0) + 1;
  },

  resumeActiveWalk(activeSession) {
    if (!activeSession) {
      return;
    }

    const nowMs = Date.now();

    if (
      this._activeWalkRedirecting &&
      nowMs - this._activeWalkRedirectStartedAtMs <
        ACTIVE_WALK_REDIRECT_LOCK_MS
    ) {
      return;
    }

    // Treat an interrupted navigation lock as stale instead of leaving
    // Route Detail permanently unable to resume or start a walk.
    this._activeWalkRedirecting = true;
    this._activeWalkRedirectStartedAtMs = nowMs;

    wx.navigateTo({
      url: `/pages/walking/walking?routeId=${encodeURIComponent(activeSession.routeId)}`,

      fail: () => {
        wx.showToast({
          title: "暂时无法恢复正在进行的散步",
          icon: "none"
        });
      },

      complete: () => {
        this._activeWalkRedirecting = false;
        this._activeWalkRedirectStartedAtMs = 0;
      }
    });
  },

  loadRoute(route) {
    this._confirmedRoute = route;
    this.setData({ canEdit: Boolean(this._eventChannel &&
      typeof this._eventChannel.emit === "function" &&
      isValidEditableOrder(route, route && route.recommendedWaypointIds) &&
      route.editableWaypoints.length > 1) });
    this.displayRoute(route);
  },

  receiveCopyContext(value = {}) {
    if (this._unloaded) return;
    if (this._copyUnsubscribe) this._copyUnsubscribe();
    this._copySession = routeCopy.getSession(value.sessionId);
    this._copyUnsubscribe = this._copySession
      ? this._copySession.subscribe(() => this.refreshCopyPresentation()) : null;
    this.refreshCopyPresentation();
  },

  refreshCopyPresentation() {
    if (this._unloaded || !this._confirmedRoute || !this.data.route || this._previewRoute) return;
    const copy = routeCopy.presentation(this._confirmedRoute, this._copySession);
    const updates = {};
    Object.keys(copy).forEach(key => { updates[`route.${key}`] = copy[key]; });
    this.setData(updates);
  },

  displayRoute(route, fallbackOnly = false) {
    this.setData({
      loading: true,
      error: false
    });

    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    const preparedRoute =
      this.prepareRoute(route, fallbackOnly);

    const polyline =
      route.polyline;

    const routeMap = buildRouteMap(route);

    const middleIndex =
      Math.floor(
        polyline.length / 2
      );

    const middlePoint =
      polyline[middleIndex];

    this.setData({
      route: { ...preparedRoute, displayPois: routeMap.displayPois },

      loading: false,
      error: false,

      mapLatitude:
        middlePoint.latitude,

      mapLongitude:
        middlePoint.longitude,

      // 覆盖真实折线和所有地点，包括未落在道路折线上的 POI。
      mapPoints: routeMap.mapPoints,

      mapPolyline: [
        {
          points: polyline,
          color: "#20BFEA",
          width: 6
        }
      ],

      markers: routeMap.markers
    }, () => {
      if (fallbackOnly) this.refreshCopyPresentation();
    });
  },

  isValidPoint(point) {
    return isValidGeoPoint(point);
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

  showRouteError() {
    this.setData({
      route: null,
      loading: false,
      error: true,

      mapLatitude: 0,
      mapLongitude: 0,

      mapPoints: [],
      mapPolyline: [],
      markers: []
    });
  },

  prepareRoute(route, fallbackOnly = false) {
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

    const displayTags =
      Array.isArray(route.tags)
        ? route.tags.filter(
            (tag) =>
              tag !== "环形路线"
          )
        : [];

    return {
      ...route,
      ...routeCopy.presentation(route, this._copySession, fallbackOnly || route !== this._confirmedRoute),
      durationDifference: Number.isFinite(route.recommendedDurationMinutes)
        ? route.durationMinutes - route.recommendedDurationMinutes : null,
      durationDifferenceAbs: Number.isFinite(route.recommendedDurationMinutes)
        ? Math.abs(route.durationMinutes - route.recommendedDurationMinutes) : null,

      returnsToStart:
        typeof route.returnsToStart === "boolean"
          ? route.returnsToStart
          : route.routeType === ROUTE_TYPES.LOOP ||
            route.routeType === ROUTE_TYPES.OUT_AND_BACK,

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

  enterRouteEdit() {
    if (!this.data.canEdit || this.data.editing) return;
    this.setData({ editing: true });
    this.updateDraft(this._confirmedRoute.routeOrder.orderedWaypointIds);
  },

  updateDraft(ids) {
    if (!this.data.editing || this.data.confirming || !isValidEditableOrder(this._confirmedRoute, ids)) return;
    this._previewRequestId = (this._previewRequestId || 0) + 1;
    this._previewRoute = null;
    this._eventChannel.emit("invalidateRoutePreview");
    const pool = this._confirmedRoute.editableWaypoints;
    const categories = { park: "公园", water: "水边", shoppingStreet: "商街" };
    const describe = poi => ({ ...poi,
      categoryLabel: categories[poi.category] || poi.category || "",
      hasDistance: Number.isFinite(poi.distanceInMeters)
    });
    this.setData({
      draftWaypointIds: [...ids],
      activeWaypoints: ids.map((id, index) => ({
        ...describe(pool.find(poi => poi.poiId === id)),
        visitNumber: index + 1,
        isDestination: this._confirmedRoute.routeType === ROUTE_TYPES.POINT_TO_POINT && index === ids.length - 1
      })),
      removedWaypoints: pool.filter(poi => !ids.includes(poi.poiId)).map(describe),
      previewLoading: false, hasPreview: false, editMessage: ""
    });
    this.displayRoute(this._confirmedRoute);
  },

  moveWaypoint(event) {
    const { id, direction } = event.currentTarget.dataset;
    const ids = [...this.data.draftWaypointIds];
    const index = ids.indexOf(id);
    const offset = Number(direction);
    const next = index + offset;
    if (index < 0 || ![-1, 1].includes(offset) || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    this.updateDraft(ids);
  },

  removeWaypoint(event) {
    if (this.data.draftWaypointIds.length <= 1) return;
    this.updateDraft(this.data.draftWaypointIds.filter(id => id !== event.currentTarget.dataset.id));
  },

  addWaypoint(event) {
    this.updateDraft([...this.data.draftWaypointIds, event.currentTarget.dataset.id]);
  },

  restoreRecommendation() {
    if (this.data.previewLoading || this.data.confirming) return;
    this.updateDraft(this._confirmedRoute.recommendedWaypointIds);
    this.previewRoute();
  },

  previewRoute() {
    if (!this.data.editing || this.data.previewLoading || this.data.confirming ||
        !isValidEditableOrder(this._confirmedRoute, this.data.draftWaypointIds)) return;
    this._previewRoute = null;
    this._previewRequestId = (this._previewRequestId || 0) + 1;
    this.setData({ previewLoading: true, hasPreview: false, editMessage: "" });
    this._eventChannel.emit("previewRoute", {
      routeId: this._confirmedRoute.routeId,
      orderedWaypointIds: [...this.data.draftWaypointIds],
      requestId: this._previewRequestId
    });
  },

  receiveRoutePreview(result = {}) {
    if (this._unloaded || !this.data.editing || !this.data.previewLoading ||
        result.requestId !== this._previewRequestId || result.routeId !== this._confirmedRoute.routeId) return;
    const route = result.route;
    if (!this.isValidRoute(route)) {
      this._previewRoute = null;
      this.displayRoute(this._confirmedRoute);
      this.setData({ previewLoading: false, hasPreview: false,
        editMessage: result.message || "路线预览失败，请调整地点或顺序后重试" });
      return;
    }
    this._previewRoute = route;
    this.displayRoute(route);
    this.setData({ previewLoading: false, hasPreview: true, editMessage: "预览已更新，确认后生效" });
  },

  cancelRouteEdit(fallbackOnly = false) {
    if (this.data.confirming) return;
    this._previewRequestId = (this._previewRequestId || 0) + 1;
    this._previewRoute = null;
    this._eventChannel.emit("invalidateRoutePreview");
    this.setData({ editing: false, previewLoading: false, hasPreview: false,
      draftWaypointIds: [], activeWaypoints: [], removedWaypoints: [], editMessage: "" });
    this.displayRoute(this._confirmedRoute, fallbackOnly === true);
  },

  confirmRouteEdit() {
    if (!this.data.editing || !this._previewRoute || this.data.previewLoading || this.data.confirming) return;
    this.setData({ confirming: true });
    this._eventChannel.emit("confirmRoute", {
      routeId: this._confirmedRoute.routeId, requestId: this._previewRequestId
    });
  },

  receiveRouteConfirmation(result = {}) {
    if (this._unloaded || !this.data.confirming || result.requestId !== this._previewRequestId ||
        result.routeId !== this._confirmedRoute.routeId) return;
    this.setData({ confirming: false });
    if (!result.route) {
      this.displayRoute(this._confirmedRoute);
      this.setData({ editMessage: result.message, hasPreview: false });
      this._previewRoute = null;
      return;
    }
    this._confirmedRoute = result.route;
    this.cancelRouteEdit(true);
  },

  onUnload() {
    this._unloaded = true;
    this._routeDetailVisible = false;
    this._walkReconcileEpoch = (this._walkReconcileEpoch || 0) + 1;
    if (this._copyUnsubscribe) this._copyUnsubscribe();
    this._copyUnsubscribe = this._copySession = null;
    this._startPromptOpen = false;
    this._startingWalk = false;
    this._activeWalkRedirecting = false;
    this._activeWalkRedirectStartedAtMs = 0;
    if (this._eventChannel && typeof this._eventChannel.emit === "function") {
      this._eventChannel.emit("closeRouteEditor");
    }
    if (this._eventChannel && typeof this._eventChannel.off === "function") {
      this._eventChannel.off("routePreviewResult", this._previewHandler);
      this._eventChannel.off("routeConfirmResult", this._confirmHandler);
      this._eventChannel.off("routeCopyContext", this._copyContextHandler);
      this._eventChannel.off("routePreferences", this._preferencesHandler);
      this._eventChannel.off("selectedRoute", this._selectedRouteHandler);
    }
    this._eventChannel = null;
    this._previewRoute = null;
  },

  replaceRoute() {
    wx.navigateBack();
  },

  startWalk() {
    if (
      this.data.editing ||
      this._startPromptOpen ||
      this._startingWalk ||
      !this.isValidRoute(this._confirmedRoute)
    ) {
      return;
    }

    let activeSession;

    try {
      activeSession =
        activeWalkSessionService.getActiveWalkSession();
    } catch (error) {
      wx.showToast({
        title: "暂时无法读取散步状态",
        icon: "none"
      });
      return;
    }

    if (activeSession) {
      this.resumeActiveWalk(activeSession);
      return;
    }

    const route = this._confirmedRoute;
    const distanceKm = (
      route.distanceMeters / 1000
    ).toFixed(1);

    this._startPromptOpen = true;

    wx.showModal({
      title: "确认开始这次散步？",
      content:
        `开始后将锁定当前路线，结束本次散步前无法更换路线。\n预计 ${route.durationMinutes} 分钟 · ${distanceKm} 公里`,
      confirmText: "开始散步",
      cancelText: "再看看",

      success: res => {
        if (!res.confirm) {
          this._startPromptOpen = false;
          return;
        }

        this.requestTrajectoryConsent(route);
      },

      fail: () => {
        this._startPromptOpen = false;
        wx.showToast({
          title: "暂时无法打开开始确认",
          icon: "none"
        });
      }
    });
  },

  requestTrajectoryConsent(route) {
    if (this._unloaded) return;
    wx.showModal({
      title: "记录实际步行轨迹？",
      content:
        "开启后，本次散步期间会使用后台定位记录你实际走过的轨迹，并保存到腾讯轨迹服务，用于之后展示历史路线和实际里程。暂不记录也可以正常散步。",
      confirmText: "记录轨迹",
      cancelText: "暂不记录",

      success: res => {
        this._startPromptOpen = false;
        this.beginWalk(route, res.confirm === true);
      },

      fail: () => {
        this._startPromptOpen = false;
        this.beginWalk(route, false);
      }
    });
  },

  async beginWalk(route, trackingEnabled) {
    if (this._unloaded) return;
    if (
      this._startingWalk ||
      !this.isValidRoute(route)
    ) {
      return;
    }

    this._startingWalk = true;

    let sessionResult;

    try {
      let existing = null;
      try {
        existing = await activeWalkSessionService.reconcileActiveWalk(route);
      } catch (error) {
        if (error.code !== "WALK_ABANDONED") throw error;
        wx.showToast({ title: error.message, icon: "none" });
      }
      if (existing) sessionResult = { session: existing, created: false };
      else {
        const walk = await walkRecords.startWalk({ routeId: route.routeId,
          preferences: this._routePreferences, trajectoryEnabled: trackingEnabled });
        sessionResult = { session: activeWalkSessionService.restoreCloudWalk(walk, route), created: true };
      }
    } catch (error) {
      this._startingWalk = false;
      wx.showToast({
        title: error.code === "WALK_ROUTE_UNAVAILABLE" ? error.message : "暂时无法开始散步，请重试",
        icon: "none"
      });
      return;
    }

    if (this._unloaded) { this._startingWalk = false; return; }
    const { session, created } = sessionResult;

    if (
      !created &&
      session.routeId !== route.routeId
    ) {
      this._startingWalk = false;
      this.resumeActiveWalk(session);
      return;
    }

    wx.navigateTo({
      url:
        `/pages/walking/walking?routeId=${encodeURIComponent(
          session.routeId
        )}`,

      success(navigateResult) {
        if (
          navigateResult.eventChannel &&
          typeof navigateResult.eventChannel.emit ===
            "function"
        ) {
          navigateResult.eventChannel.emit(
            "walkingRoute",
            session.route
          );
        }
      },

      fail: () => {
        wx.showToast({
          title: "暂时无法打开散步页面",
          icon: "none"
        });
      },

      complete: () => {
        this._startingWalk = false;
      }
    });
  }
});
