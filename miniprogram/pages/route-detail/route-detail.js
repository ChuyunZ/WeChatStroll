const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const { isValidEditableOrder } = require("../../services/route-editing");
const activeWalkSessionService = require("../../services/active-walk-session");
const {
  ROUTE_TYPES
} = require("../../constants/route-types");

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
    const routeId = options.id;

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
        this._previewHandler = result => this.receiveRoutePreview(result);
        this._confirmHandler = result => this.receiveRouteConfirmation(result);
        eventChannel.on("routePreviewResult", this._previewHandler);
        eventChannel.on("routeConfirmResult", this._confirmHandler);
        eventChannel.on(
          "selectedRoute",
          (route) => {
            if (
              routeId &&
              route &&
              route.routeId &&
              route.routeId !== routeId
            ) {
              this.showRouteError();
              return;
            }

            this.loadRoute(route);
          }
        );

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

  onShow() {
    if (this._unloaded || this._startingWalk || this._activeWalkRedirecting) {
      return;
    }

    let activeSession;

    try {
      activeSession = activeWalkSessionService.getActiveWalkSession();
    } catch (error) {
      console.warn("[Route Detail] Unable to read active walk session.");
      return;
    }

    if (activeSession) {
      this.resumeActiveWalk(activeSession);
    }
  },

  resumeActiveWalk(activeSession) {
    if (!activeSession || this._activeWalkRedirecting) {
      return;
    }

    this._activeWalkRedirecting = true;

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

  displayRoute(route) {
    this.setData({
      loading: true,
      error: false
    });

    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    const preparedRoute =
      this.prepareRoute(route);

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

  prepareRoute(route) {
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

  cancelRouteEdit() {
    if (this.data.confirming) return;
    this._previewRequestId = (this._previewRequestId || 0) + 1;
    this._previewRoute = null;
    this._eventChannel.emit("invalidateRoutePreview");
    this.setData({ editing: false, previewLoading: false, hasPreview: false,
      draftWaypointIds: [], activeWaypoints: [], removedWaypoints: [], editMessage: "" });
    this.displayRoute(this._confirmedRoute);
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
    this.cancelRouteEdit();
  },

  onUnload() {
    this._unloaded = true;
    if (this._eventChannel && typeof this._eventChannel.emit === "function") {
      this._eventChannel.emit("closeRouteEditor");
    }
    if (this._eventChannel && typeof this._eventChannel.off === "function") {
      this._eventChannel.off("routePreviewResult", this._previewHandler);
      this._eventChannel.off("routeConfirmResult", this._confirmHandler);
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
      this._startingWalk ||
      !this.isValidRoute(this._confirmedRoute)
    ) {
      return;
    }

    let activeSession;

    try {
      activeSession = activeWalkSessionService.getActiveWalkSession();
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
    const distanceKm = (route.distanceMeters / 1000).toFixed(1);

    wx.showModal({
      title: "确认开始这次散步？",
      content:
        `开始后将锁定当前路线，结束本次散步前无法更换路线。\n预计 ${route.durationMinutes} 分钟 · ${distanceKm} 公里`,
      confirmText: "开始散步",
      cancelText: "再看看",

      success: res => {
        if (!res.confirm) {
          return;
        }

        this._startingWalk = true;

        let sessionResult;

        try {
          sessionResult = activeWalkSessionService.createActiveWalkSession(route);
        } catch (error) {
          this._startingWalk = false;
          wx.showToast({
            title: "暂时无法开始散步",
            icon: "none"
          });
          return;
        }

        const { session, created } = sessionResult;

        if (!created && session.routeId !== route.routeId) {
          this._startingWalk = false;
          this.resumeActiveWalk(session);
          return;
        }

        wx.navigateTo({
          url: `/pages/walking/walking?routeId=${encodeURIComponent(session.routeId)}`,

          success(navigateResult) {
            if (
              navigateResult.eventChannel &&
              typeof navigateResult.eventChannel.emit === "function"
            ) {
              navigateResult.eventChannel.emit("walkingRoute", session.route);
            }
          },

          fail: () => {
            if (created) {
              try {
                activeWalkSessionService.clearActiveWalkSession(session.routeId);
              } catch (error) {
                console.warn("[Route Detail] Unable to clear failed walk session.");
              }
            }

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
  }
});