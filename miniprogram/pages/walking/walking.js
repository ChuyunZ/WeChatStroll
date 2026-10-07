const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const locationService = require("../../services/location");
const activeWalkSessionService = require("../../services/active-walk-session");
const walkingTracker = require("../../services/walking-tracker");

const walkRecords = require("../../services/walk-records");

const TIMER_INTERVAL_MS = 1000;

function formatElapsedTime(totalSeconds) {
  const safeSeconds =
    Number.isFinite(totalSeconds) && totalSeconds >= 0
      ? Math.floor(totalSeconds)
      : 0;

  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}

function formatClockTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const date = new Date(timestamp);

  return [date.getHours(), date.getMinutes()]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}

Page({
  data: {
    loading: true,
    error: false,

    route: null,

    elapsedSeconds: 0,
    elapsedText: "00:00:00",
    startTimeText: "",

    finishing: false,
    ended: false,

    showUserLocation: false,
    locationMessage: "",

    mapLatitude: 0,
    mapLongitude: 0,

    mapPoints: [],
    mapPolyline: [],
    markers: [],

    displayPois: [],

    statusBarHeight: 20,
    navigationBarHeight: 44
  },

  async onLoad(options = {}) {
    this._unloaded = false;
    this._pageVisible = true;
    this._active = false;
    this._finishing = false;
    this._timer = null;
    this._route = null;
    this._startTimeMs = null;
    this._trackingEnabled = false;
    this._trackingUnavailable = false;
    this._trackingFinalizing = false;
    this._trackingStartPromise = null;
    this._trackingStopPromise = null;

    this.initializeNavigationBar();

    const routeId = options.routeId;

    let activeSession;
    let pendingResult;

    try {
      activeSession = await activeWalkSessionService.reconcileActiveWalk();
      if (!activeSession) pendingResult = activeWalkSessionService.getPendingWalkResult();
    } catch (error) {
      if (error && error.code === "WALK_ABANDONED") {
        this._active = false;
        this.setData({
          loading: false,
          error: false,
          finishing: false,
          ended: true
        });
        wx.showToast({
          title: "本次散步因长时间未结束，已自动关闭",
          icon: "none"
        });
        wx.navigateBack();
        return;
      }
      this.showRouteError();
      wx.showToast({
        title: error.code === "WALK_ROUTE_UNAVAILABLE" ? error.message : "暂时无法恢复散步状态，请重试",
        icon: "none"
      });
      // A matching EventChannel/local mock route may still restore the cloud lock.
      if (error.code !== "WALK_ROUTE_UNAVAILABLE") return;
    }

    if (this._unloaded) return;
    if (activeSession) {
      this._walkId = activeSession.walkId;
      this._completionRequest = activeSession.completionRequest;
      if (!this.isValidRoute(activeSession.route)) {
        try {
          activeWalkSessionService.clearActiveWalkSession(activeSession.routeId);
        } catch (error) {
          console.warn("[Walking] Unable to clear invalid active session.");
        }

        this.showRouteError();
        return;
      }

      this.loadWalkingRoute(
        activeSession.route,
        activeSession.startTimeMs,
        activeSession.trackingEnabled === true
      );
      return;
    }

    if (pendingResult && (!routeId || pendingResult.routeId === routeId)) {
      // Recovery during a final flush must follow the durable completion,
      // including when the active lock was already removed before the crash.
      walkingTracker.stopTrackingForSession({
        routeId: pendingResult.routeId,
        startTimeMs: Date.parse(pendingResult.startTime)
      });
      this._finishing = true;
      this.setData({ ended: true, finishing: true });
      wx.reLaunch({
        url: `/pages/feedback/feedback?walkId=${encodeURIComponent(pendingResult.walkId)}`
      });
      return;
    }

    if (typeof this.getOpenerEventChannel === "function") {
      const eventChannel = this.getOpenerEventChannel();

      if (eventChannel && typeof eventChannel.on === "function") {
        this._eventChannel = eventChannel;

        eventChannel.on("walkingRoute", route => {
          if (
            routeId &&
            route &&
            route.routeId &&
            route.routeId !== routeId
          ) {
            this.showRouteError();
            return;
          }

          return this.startWalkingRoute(route);
        });

        return;
      }
    }

    // 兼容开发阶段直接打开 Walking 页面。
    const mockRoute = mockRoutes.find(route => route.routeId === routeId);
    return this.startWalkingRoute(mockRoute);
  },

  onShow() {
    this._pageVisible = true;

    if (this._finishing) return;

    if (this.data.ended) {
      wx.navigateBack();
      return;
    }

    if (this._active) {
      this.updateElapsedTime();
      this.startTimer();
      this.initializeTrajectoryTracking();
    }
  },

  onHide() {
    this._pageVisible = false;
    this.stopTimer();
  },

  initializeNavigationBar() {
    let statusBarHeight = 20;
    let navigationBarHeight = 44;

    try {
      const windowInfo =
        typeof wx.getWindowInfo === "function"
          ? wx.getWindowInfo()
          : typeof wx.getSystemInfoSync === "function"
            ? wx.getSystemInfoSync()
            : {};

      if (Number.isFinite(windowInfo.statusBarHeight)) {
        statusBarHeight = windowInfo.statusBarHeight;
      }

      if (typeof wx.getMenuButtonBoundingClientRect === "function") {
        const menuButton = wx.getMenuButtonBoundingClientRect();

        if (
          menuButton &&
          Number.isFinite(menuButton.top) &&
          Number.isFinite(menuButton.height)
        ) {
          const verticalGap = Math.max(0, menuButton.top - statusBarHeight);
          navigationBarHeight = menuButton.height + verticalGap * 2;
        }
      }
    } catch (error) {
      // Keep safe defaults when navigation metrics are unavailable.
    }

    this.setData({
      statusBarHeight,
      navigationBarHeight
    });
  },

  onUnload() {
    this._unloaded = true;
    this._pageVisible = false;
    this.stopTimer();
    this.disableLeaveProtection();

    this._active = false;
    if (!this._finishing) this._route = null;
    this._eventChannel = null;
  },

  isValidRoute(route) {
    return (
      route &&
      typeof route === "object" &&
      !Array.isArray(route) &&
      typeof route.routeId === "string" &&
      route.routeId.trim() !== "" &&
      Number.isFinite(route.durationMinutes) &&
      route.durationMinutes >= 0 &&
      Number.isFinite(route.distanceMeters) &&
      route.distanceMeters >= 0 &&
      Array.isArray(route.polyline) &&
      route.polyline.length >= 2 &&
      route.polyline.every(isValidGeoPoint)
    );
  },

  async startWalkingRoute(route) {
    try {
      const session = await activeWalkSessionService.reconcileActiveWalk(route);
      if (this._unloaded) return;
      if (!session) { this.showRouteError(); return; }
      this._walkId = session.walkId;
      this._completionRequest = session.completionRequest;
      this.loadWalkingRoute(session.route, session.startTimeMs, session.trackingEnabled);
    } catch (error) {
      this.showRouteError();
      wx.showToast({ title: "请返回路线详情开始散步，或重试恢复", icon: "none" });
    }
  },

  loadWalkingRoute(
    route,
    startTimeMs = Date.now(),
    trackingEnabled = false
  ) {
    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    this._route = route;
    this._startTimeMs = startTimeMs;
    this._active = true;
    this._finishing = false;
    this._trackingEnabled = trackingEnabled === true;
    this._trackingUnavailable = false;
    this._trackingFinalizing = false;

    const routeMap = buildRouteMap(route);
    const middleIndex = Math.floor(route.polyline.length / 2);
    const middlePoint = route.polyline[middleIndex];

    this.setData({
      loading: false,
      error: false,

      route: {
        ...route,
        distanceKm: (route.distanceMeters / 1000).toFixed(1)
      },

      elapsedSeconds: 0,
      elapsedText: "00:00:00",
      startTimeText: formatClockTime(this._startTimeMs),

      finishing: false,
      ended: false,

      mapLatitude: middlePoint.latitude,
      mapLongitude: middlePoint.longitude,

      mapPoints: routeMap.mapPoints,

      mapPolyline: [
        {
          points: route.polyline,
          color: "#20BFEA",
          width: 6
        }
      ],

      markers: routeMap.markers,
      displayPois: routeMap.displayPois
    });

    this.enableLeaveProtection();
    this.initializeUserLocation();
    this.initializeTrajectoryTracking();
    this.updateElapsedTime();

    if (this._pageVisible) {
      this.startTimer();
    }
  },

  showRouteError() {
    this._active = false;
    this._route = null;
    this._trackingEnabled = false;
    this._trackingUnavailable = false;
    this._trackingFinalizing = false;

    this.stopTimer();
    this.disableLeaveProtection();

    this.setData({
      loading: false,
      error: true,

      route: null,

      elapsedSeconds: 0,
      elapsedText: "00:00:00",
      startTimeText: "",

      finishing: false,
      ended: false,

      showUserLocation: false,
      locationMessage: "",

      mapLatitude: 0,
      mapLongitude: 0,

      mapPoints: [],
      mapPolyline: [],
      markers: [],

      displayPois: []
    });
  },

  async initializeUserLocation() {
    this.setData({
      locationMessage: "正在获取当前位置..."
    });

    try {
      await locationService.getCurrentLocation({
        timeout: 5000
      });

      if (!this._active || this.data.ended) {
        return;
      }

      this.setData({
        showUserLocation: true,
        locationMessage: ""
      });
    } catch (error) {
      if (!this._active || this.data.ended) {
        return;
      }

      console.warn("[Walking] Unable to show current location:", {
        code: error && error.code ? error.code : "LOCATION_FAILED"
      });

      this.setData({
        showUserLocation: false,
        locationMessage: "暂时无法显示当前位置"
      });
    }
  },

  initializeTrajectoryTracking() {
    if (
      !this._active ||
      !this._trackingEnabled ||
      this._trackingUnavailable ||
      this._trackingFinalizing ||
      this.data.ended ||
      this._trackingStartPromise ||
      walkingTracker.isTracking({ routeId: this._route.routeId, startTimeMs: this._startTimeMs })
    ) {
      return this._trackingStartPromise;
    }

    let startResult;

    try {
      startResult = walkingTracker.startTracking({
        ...(this._trajectoryPartial ? { trajectoryPartial: true } : {}),
        routeId: this._route.routeId,
        startTimeMs: this._startTimeMs
      });
    } catch (error) {
      startResult = Promise.reject(error);
    }

    const startPromise = Promise.resolve(startResult)
      .catch(error => {
        if (!this._trackingFinalizing) {
          this._trackingUnavailable = true;

          console.warn(
            "[Walking] Trajectory tracking unavailable.",
            {
              code:
                error && error.code
                  ? error.code
                  : "TRACKING_UNAVAILABLE",
              errMsg:
                error &&
                error.originalError &&
                typeof error.originalError.errMsg === "string"
                  ? error.originalError.errMsg
                  : null,
              errCode:
                error &&
                error.originalError &&
                Number.isFinite(error.originalError.errCode)
                  ? error.originalError.errCode
                  : null
            }
          );

          if (
            error &&
            error.code ===
              "BACKGROUND_LOCATION_PERMISSION_DENIED"
          ) {
            this.promptBackgroundLocationPermission();
          } else {
            wx.showToast({
              title: "轨迹记录未开启，散步仍可继续",
              icon: "none"
            });
          }
        }

        return null;
      })
      .finally(() => {
        if (this._trackingStartPromise === startPromise) {
          this._trackingStartPromise = null;
        }
      });

    this._trackingStartPromise = startPromise;
    return startPromise;
  },

  promptBackgroundLocationPermission() {
    if (this._backgroundPermissionPromptOpen) {
      return;
    }

    this._backgroundPermissionPromptOpen = true;

    wx.showModal({
      title: "需要后台定位权限",
      content:
        "记录实际步行轨迹需要允许小程序在使用期间和离开后获取位置。你可以前往设置开启；不授权也可以继续散步。",
      confirmText: "去设置",
      cancelText: "暂不记录",

      success: res => {
        if (
          !res.confirm ||
          typeof wx.openSetting !== "function"
        ) {
          return;
        }

        wx.openSetting({
          success: settings => {
            const granted =
              settings &&
              settings.authSetting &&
              settings.authSetting[
                "scope.userLocationBackground"
              ] === true;

            if (!granted) {
              return;
            }

            const pendingStart =
              this._trackingStartPromise;

            const retry = () => {
              if (
                !this._active ||
                this.data.ended ||
                this._trackingFinalizing
              ) {
                return;
              }

              this._trackingUnavailable = false;
              this.initializeTrajectoryTracking();
            };

            if (pendingStart) {
              pendingStart.finally(retry);
            } else {
              retry();
            }
          }
        });
      },

      complete: () => {
        this._backgroundPermissionPromptOpen = false;
      }
    });
  },

  finalizeTrajectoryTracking() {
    this._trackingFinalizing = true;

    if (!this._trackingEnabled) {
      return null;
    }

    if (this._trackingStopPromise) return this._trackingStopPromise;
    const stopPromise = walkingTracker.finalizeTracking({
      routeId: this._route.routeId, startTimeMs: this._startTimeMs
    })
      .catch(error => {
        console.warn(
          "[Walking] Unable to stop trajectory tracking.",
          {
            code:
              error && error.code
                ? error.code
                : "TRACK_STOP_FAILED"
          }
        );

        return null;
      });

    this._trackingStopPromise = stopPromise;

    stopPromise.finally(() => {
      if (this._trackingStopPromise === stopPromise) {
        this._trackingStopPromise = null;
      }
    });

    return stopPromise;
  },

  updateElapsedTime() {
    if (!this._active || !Number.isFinite(this._startTimeMs)) {
      return;
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this._startTimeMs) / 1000)
    );

    this.setData({
      elapsedSeconds,
      elapsedText: formatElapsedTime(elapsedSeconds)
    });
  },

  startTimer() {
    if (!this._active || this.data.ended || this._timer) {
      return;
    }

    this._timer = setInterval(() => {
      this.updateElapsedTime();
    }, TIMER_INTERVAL_MS);
  },

  stopTimer() {
    if (!this._timer) {
      return;
    }

    clearInterval(this._timer);
    this._timer = null;
  },

  enableLeaveProtection() {
    if (typeof wx.enableAlertBeforeUnload !== "function") {
      return;
    }

    wx.enableAlertBeforeUnload({
      message: "散步路线已锁定。如需更换路线，请先点击“提前结束”。"
    });
  },

  disableLeaveProtection() {
    if (typeof wx.disableAlertBeforeUnload !== "function") {
      return;
    }

    wx.disableAlertBeforeUnload();
  },

  handleNavigationBack() {
    if (!this._active || this.data.ended) {
      wx.navigateBack();
      return;
    }

    if (this._finishing) {
      return;
    }

    wx.showModal({
      title: "散步正在进行",
      content: "当前路线已锁定。如需更换路线，请先提前结束本次散步。",
      confirmText: "提前结束",
      cancelText: "继续散步",

      success: res => {
        if (res.confirm) {
          this.completeWalk("ended_early");
        }
      }
    });
  },

  finishWalk() {
    return this.completeWalk("completed");
  },

  endWalkEarly() {
    if (!this._active || this.data.ended || this._finishing) {
      return;
    }

    wx.showModal({
      title: "提前结束散步？",
      content: "本次散步会记录为提前结束。",
      confirmText: "结束散步",
      cancelText: "继续散步",

      success: res => {
        if (res.confirm) {
          this.completeWalk("ended_early");
        }
      }
    });
  },

  async completeWalk(completionStatus) {
    if (
      !this._active ||
      this.data.ended ||
      this._finishing ||
      !this._route ||
      !Number.isFinite(this._startTimeMs)
    ) {
      return;
    }

    this._finishing = true;

    // The user's confirmation, not trajectory cleanup, defines the walk range.
    const endTimeMs = Date.now();
    const knownPartial = this._trajectoryPartial === true;
    const actualDurationSeconds = Math.max(
      0,
      Math.floor((endTimeMs - this._startTimeMs) / 1000)
    );

    const walkResult = {
      walkId: this._walkId,
      routeId: this._route.routeId,
      route: this._route,
      startTime: new Date(this._startTimeMs).toISOString(),
      endTime: new Date(endTimeMs).toISOString(),
      actualDurationSeconds,
      completionStatus,
      trajectoryEnabled: this._trackingEnabled,
      // Provider queries may need to include the bounded final sample even
      // though the user's walk duration ends at endTime.
      trajectoryEndTimeMs: endTimeMs,
      // Until cleanup finishes, a crash must not leave a falsely complete trace.
      trajectoryPartial: knownPartial || this._trackingEnabled
    };

    // Retain the original confirmation on retry, including response-loss retries.
    const request = this._completionRequest || { walkId: this._walkId, completionStatus,
      endTimeMs, trajectoryPartial: walkResult.trajectoryPartial };
    this._completionRequest = request;
    let terminal;
    try {
      const session = activeWalkSessionService.getActiveWalkSession();
      if (session && session.walkId === this._walkId) {
        wx.setStorageSync(activeWalkSessionService.ACTIVE_WALK_STORAGE_KEY, { ...session, completionRequest: request });
      }
      terminal = await walkRecords.completeWalk(request);
    } catch (error) {
      this._finishing = false;
      if (error && error.code === "WALK_ABANDONED") {
        const session = activeWalkSessionService.getActiveWalkSession();
        if (session && session.walkId === this._walkId) {
          walkingTracker.stopTrackingForSession(session);
          activeWalkSessionService.clearActiveWalkSession(session.routeId, session.walkId);
        }
        this._active = false;
        this.stopTimer();
        this.disableLeaveProtection();
        this.setData({ finishing: false, ended: true });
        wx.showToast({ title: "本次散步因长时间未结束，已自动关闭", icon: "none" });
        wx.navigateBack();
        return;
      }
      wx.showToast({ title: "暂时无法结束散步，请重试", icon: "none" });
      return;
    }
    Object.assign(walkResult, { endTime: terminal.endTime, completionStatus: terminal.status,
      actualDurationSeconds: terminal.actualDurationSeconds, trajectoryEndTimeMs: terminal.trajectoryEndTimeMs });
    try {
      activeWalkSessionService.savePendingWalkResult(walkResult);
      activeWalkSessionService.clearActiveWalkSession(walkResult.routeId, walkResult.walkId);
    } catch (error) {
      // Cloud is terminal even when device storage is unavailable. Next load reconciles by walkId.
      wx.showToast({ title: "散步已保存，本地恢复信息暂时无法更新", icon: "none" });
    }

    this._active = false;

    this.stopTimer();
    this.disableLeaveProtection();

    this.setData({
      elapsedSeconds: walkResult.actualDurationSeconds,
      elapsedText: formatElapsedTime(walkResult.actualDurationSeconds),
      finishing: true,
      ended: true
    });

    if (this._trackingEnabled) {
      let quality;
      try { quality = await this.finalizeTrajectoryTracking(); } catch (_) { quality = null; }
      const completedResult = {
        ...walkResult,
        trajectoryPartial: Boolean(knownPartial || !quality || quality.trajectoryPartial),
        // Finalization has already captured its last sample by this point.
        // Keep endTime fixed at the user's confirmation time while extending
        // only the provider query boundary far enough to include that sample.
        trajectoryEndTimeMs: Math.max(
          walkResult.trajectoryEndTimeMs,
          Date.now()
        )
      };
      this._trajectoryPartial = completedResult.trajectoryPartial;
      try {
        const pending = activeWalkSessionService.getPendingWalkResult();
        if (pending && pending.routeId === walkResult.routeId &&
            pending.startTime === walkResult.startTime && pending.endTime === walkResult.endTime) {
          activeWalkSessionService.savePendingWalkResult(completedResult);
        }
      } catch (error) {
        // Completion is already durable. Cloud metadata is updated independently below.
        console.warn("[Walking] Unable to update completed trajectory quality.");
      }
      try {
        await walkRecords.updateTrajectoryMetadata({
          walkId: completedResult.walkId,
          trajectoryPartial: completedResult.trajectoryPartial,
          trajectoryEndTimeMs: completedResult.trajectoryEndTimeMs
        });
      } catch (error) {
        // Never reactivate a terminal walk because a post-finalization metadata write failed.
        console.warn("[Walking] Unable to persist finalized trajectory metadata.");
      }
    }

    wx.reLaunch({
      url: `/pages/feedback/feedback?walkId=${encodeURIComponent(
        walkResult.walkId
      )}`,

      fail: () => {
        wx.showToast({
          title: "散步已保存，暂时无法打开评价页面",
          icon: "none"
        });
      }
    });
  },

  returnToRoute() {
    wx.navigateBack();
  }
});
