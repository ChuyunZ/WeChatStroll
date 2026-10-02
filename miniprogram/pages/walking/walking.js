const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const locationService = require("../../services/location");
const activeWalkSessionService = require("../../services/active-walk-session");
const walkingTracker = require("../../services/walking-tracker");

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

  onLoad(options = {}) {
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

    try {
      activeSession = activeWalkSessionService.getActiveWalkSession();
    } catch (error) {
      this.showRouteError();
      wx.showToast({
        title: "暂时无法恢复散步状态",
        icon: "none"
      });
      return;
    }

    if (activeSession) {
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

          this.startWalkingRoute(route);
        });

        return;
      }
    }

    // 兼容开发阶段直接打开 Walking 页面。
    const mockRoute = mockRoutes.find(route => route.routeId === routeId);
    this.startWalkingRoute(mockRoute);
  },

  onShow() {
    this._pageVisible = true;

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
    this._pageVisible = false;
    this.stopTimer();
    this.disableLeaveProtection();

    this._active = false;
    this._route = null;
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

  startWalkingRoute(route) {
    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    let sessionResult;

    try {
      sessionResult = activeWalkSessionService.createActiveWalkSession(route);
    } catch (error) {
      this.showRouteError();
      wx.showToast({
        title: "暂时无法保存散步状态",
        icon: "none"
      });
      return;
    }

    this.loadWalkingRoute(
      sessionResult.session.route,
      sessionResult.session.startTimeMs,
      sessionResult.session.trackingEnabled === true
    );
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
      walkingTracker.isTracking()
    ) {
      return this._trackingStartPromise;
    }

    let startResult;

    try {
      startResult = walkingTracker.startTracking({
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

            this._trackingUnavailable = false;
            this.initializeTrajectoryTracking();
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

    const startPromise = this._trackingStartPromise;

    const stopPromise = Promise.resolve(startPromise)
      .catch(() => null)
      .then(() => {
        if (!walkingTracker.isTracking()) {
          return null;
        }

        return walkingTracker.stopTracking();
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

  restartTrajectoryTrackingAfterRollback() {
    const restart = () => {
      if (!this._active || this.data.ended) {
        return;
      }

      this._trackingFinalizing = false;
      this._trackingUnavailable = false;
      this.initializeTrajectoryTracking();
    };

    if (this._trackingStopPromise) {
      this._trackingStopPromise.finally(restart);
      return;
    }

    restart();
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
    this.completeWalk("completed");
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

  completeWalk(completionStatus) {
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

    const endTimeMs = Date.now();
    const actualDurationSeconds = Math.max(
      0,
      Math.floor((endTimeMs - this._startTimeMs) / 1000)
    );

    const walkResult = {
      routeId: this._route.routeId,
      route: this._route,
      startTime: new Date(this._startTimeMs).toISOString(),
      endTime: new Date(endTimeMs).toISOString(),
      actualDurationSeconds,
      completionStatus,
      trajectoryEnabled: this._trackingEnabled
    };

    try {
      activeWalkSessionService.savePendingWalkResult(walkResult);

      const cleared = activeWalkSessionService.clearActiveWalkSession(
        this._route.routeId
      );

      if (!cleared) {
        activeWalkSessionService.clearPendingWalkResult();
        throw new Error("Active walk session changed.");
      }
    } catch (error) {
      try {
        activeWalkSessionService.clearPendingWalkResult();
      } catch (cleanupError) {
        console.warn("[Walking] Unable to clear pending walk result after completion failure.");
      }

      this._finishing = false;
      wx.showToast({
        title: "暂时无法结束散步，请重试",
        icon: "none"
      });
      return;
    }

    this._active = false;
    this.finalizeTrajectoryTracking();

    this.stopTimer();
    this.disableLeaveProtection();

    this.setData({
      elapsedSeconds: actualDurationSeconds,
      elapsedText: formatElapsedTime(actualDurationSeconds),
      finishing: true,
      ended: true
    });

    wx.reLaunch({
      url: `/pages/feedback/feedback?routeId=${encodeURIComponent(
        this._route.routeId
      )}`,

      fail: () => {
        try {
          activeWalkSessionService.createActiveWalkSession(
            this._route,
            this._startTimeMs,
            {
              trackingEnabled: this._trackingEnabled
            }
          );
        } catch (error) {
          console.warn("[Walking] Unable to restore active session after navigation failure.");
        }

        try {
          activeWalkSessionService.clearPendingWalkResult();
        } catch (error) {
          console.warn("[Walking] Unable to clear pending walk result after navigation failure.");
        }

        this._active = true;
        this._finishing = false;

        this.setData({
          finishing: false,
          ended: false
        });

        this.enableLeaveProtection();

        if (this._pageVisible) {
          this.startTimer();
        }

        this.restartTrajectoryTrackingAfterRollback();

        wx.showToast({
          title: "暂时无法打开评价页面",
          icon: "none"
        });
      }
    });
  },

  returnToRoute() {
    wx.navigateBack();
  }
});