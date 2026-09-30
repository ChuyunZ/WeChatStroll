const { mockRoutes } = require("../../data/mock-routes");
const { isValidGeoPoint } = require("../../utils/geo");
const { buildRouteMap } = require("../../utils/route-map");
const locationService = require("../../services/location");

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

    displayPois: []
  },

  onLoad(options = {}) {
    this._pageVisible = true;
    this._active = false;
    this._finishing = false;
    this._timer = null;
    this._route = null;
    this._startTimeMs = null;

    const routeId = options.routeId;

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

          this.loadWalkingRoute(route);
        });

        return;
      }
    }

    // 兼容开发阶段直接打开 Walking 页面。
    const mockRoute = mockRoutes.find(route => route.routeId === routeId);

    this.loadWalkingRoute(mockRoute);
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
    }
    },

  onHide() {
    this._pageVisible = false;
    this.stopTimer();
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

  loadWalkingRoute(route) {
    if (!this.isValidRoute(route)) {
      this.showRouteError();
      return;
    }

    this._route = route;
    this._startTimeMs = Date.now();
    this._active = true;
    this._finishing = false;

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
    this.updateElapsedTime();

    if (this._pageVisible) {
      this.startTimer();
    }
  },

  showRouteError() {
    this._active = false;
    this._route = null;

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
      message: "散步正在进行，确定要离开吗？"
    });
  },

  disableLeaveProtection() {
    if (typeof wx.disableAlertBeforeUnload !== "function") {
      return;
    }

    wx.disableAlertBeforeUnload();
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
      completionStatus
    };

    this._active = false;

    this.stopTimer();
    this.disableLeaveProtection();

    this.setData({
      elapsedSeconds: actualDurationSeconds,
      elapsedText: formatElapsedTime(actualDurationSeconds),
      finishing: true,
      ended: true
    });

    wx.navigateTo({
      url: `/pages/feedback/feedback?routeId=${encodeURIComponent(
        this._route.routeId
      )}`,

      success(res) {
        res.eventChannel.emit("walkResult", walkResult);
      },

      fail: () => {
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