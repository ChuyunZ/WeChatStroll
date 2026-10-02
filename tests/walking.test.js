const { mockRoutes } = require("../miniprogram/data/mock-routes");

const TEST_ROUTE = mockRoutes[0];

let pageDefinition;
let page;
let getCurrentLocation;
let startTracking;
let stopTracking;
let isTracking;
let trackerActive;
let storage;

function createEventChannel() {
  const handlers = {};

  return {
    handlers,
    on: jest.fn((eventName, handler) => {
      handlers[eventName] = handler;
    })
  };
}

function loadWalkingPage({ eventChannel = null } = {}) {
  jest.resetModules();

  pageDefinition = null;
  storage = {};
  getCurrentLocation = jest.fn().mockResolvedValue({
    latitude: 31.2304,
    longitude: 121.4737
  });

  trackerActive = false;

  startTracking = jest.fn().mockImplementation(async args => {
    trackerActive = true;

    return {
      session: {
        version: 1,
        status: "active",
        routeId: args.routeId,
        startTimeMs: args.startTimeMs
      },
      resumed: false
    };
  });

  stopTracking = jest.fn().mockImplementation(async () => {
    trackerActive = false;
    return null;
  });

  isTracking = jest.fn(() => trackerActive);

  jest.doMock("../miniprogram/services/location", () => ({
    getCurrentLocation
  }));

  jest.doMock(
    "../miniprogram/services/walking-tracker",
    () => ({
      startTracking,
      stopTracking,
      isTracking
    })
  );

  global.Page = jest.fn(definition => {
    pageDefinition = definition;
  });

  global.wx = {
    enableAlertBeforeUnload: jest.fn(),
    disableAlertBeforeUnload: jest.fn(),
    navigateBack: jest.fn(),
    navigateTo: jest.fn(),
    reLaunch: jest.fn(),
    showModal: jest.fn(),
    showToast: jest.fn(),
    getStorageSync: jest.fn(key => storage[key]),
    setStorageSync: jest.fn((key, value) => {
      storage[key] = value;
    }),
    removeStorageSync: jest.fn(key => {
      delete storage[key];
    }),
    getWindowInfo: jest.fn(() => ({
      statusBarHeight: 20
    })),
    getMenuButtonBoundingClientRect: jest.fn(() => ({
      top: 24,
      height: 32
    }))
  };

  require("../miniprogram/pages/walking/walking");

  const pageInstance = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data
    }
  };

  pageInstance.setData = jest.fn(updates => {
    pageInstance.data = {
      ...pageInstance.data,
      ...updates
    };
  });

  pageInstance.getOpenerEventChannel = jest.fn(() => eventChannel);

  return pageInstance;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));

  page = loadWalkingPage();
});

afterEach(() => {
  if (page && typeof page.stopTimer === "function") {
    page.stopTimer();
  }

  jest.useRealTimers();
  jest.restoreAllMocks();

  delete global.Page;
  delete global.wx;
});

describe("Walking page", () => {
  test("receives the confirmed route through EventChannel", () => {
    const eventChannel = createEventChannel();

    page = loadWalkingPage({
      eventChannel
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(eventChannel.on).toHaveBeenCalledWith(
      "walkingRoute",
      expect.any(Function)
    );

    expect(page.data.loading).toBe(true);

    eventChannel.handlers.walkingRoute(TEST_ROUTE);

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(false);
    expect(page.data.route.routeId).toBe(TEST_ROUTE.routeId);
    expect(page.data.route.distanceKm).toBe("2.6");
    expect(page.data.mapPolyline).toEqual([
      {
        points: TEST_ROUTE.polyline,
        color: "#20BFEA",
        width: 6
      }
    ]);
  });

  test("rejects a route whose ID does not match the URL", () => {
    const eventChannel = createEventChannel();

    page = loadWalkingPage({
      eventChannel
    });

    page.onLoad({
      routeId: "different-route"
    });

    eventChannel.handlers.walkingRoute(TEST_ROUTE);

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(true);
    expect(page.data.route).toBeNull();
  });

  test("falls back to a mock route when opened directly during development", () => {
    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(false);
    expect(page.data.route.routeId).toBe(TEST_ROUTE.routeId);
  });

  test("restores an existing active walk with its original start time", () => {
    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: new Date("2026-10-01T11:30:00.000Z").getTime()
    });

    page.onLoad({
      routeId: "different-route"
    });

    page.updateElapsedTime();

    expect(page.data.route.routeId).toBe(TEST_ROUTE.routeId);
    expect(page.data.elapsedSeconds).toBe(1800);
    expect(page.data.elapsedText).toBe("00:30:00");
  });

  test("starts trajectory tracking for an opted-in active walk", async () => {
    const startTimeMs =
      new Date("2026-10-01T11:30:00.000Z").getTime();

    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs,
      trackingEnabled: true
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(startTracking).toHaveBeenCalledTimes(1);
    expect(startTracking).toHaveBeenCalledWith({
      routeId: TEST_ROUTE.routeId,
      startTimeMs
    });

    page.onShow();

    expect(startTracking).toHaveBeenCalledTimes(1);
  });

  test("does not start trajectory tracking when the user opted out", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: false
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(startTracking).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
  });

  test("tracking startup failure does not stop the walk", async () => {
    const warnSpy =
      jest.spyOn(console, "warn")
        .mockImplementation(() => {});

    startTracking.mockRejectedValueOnce(
      Object.assign(
        new Error("permission denied"),
        {
          code: "BACKGROUND_LOCATION_FAILED"
        }
      )
    );

    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);

    expect(wx.showToast).toHaveBeenCalledWith({
      title: "轨迹记录未开启，散步仍可继续",
      icon: "none"
    });

    warnSpy.mockRestore();
  });

  test("hiding the Walking page does not stop background trajectory tracking", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.onHide();

    expect(stopTracking).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
  });

  test("shows an error for an invalid route", () => {
    page.loadWalkingRoute({
      ...TEST_ROUTE,
      polyline: []
    });

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(true);
    expect(page.data.route).toBeNull();
    expect(page.data.mapPoints).toEqual([]);
    expect(page.data.mapPolyline).toEqual([]);
    expect(page.data.markers).toEqual([]);
  });

  test("enables the map current-location indicator when location is available", async () => {
    page.loadWalkingRoute(TEST_ROUTE);

    await Promise.resolve();
    await Promise.resolve();

    expect(getCurrentLocation).toHaveBeenCalledWith({
      timeout: 5000
    });

    expect(page.data.showUserLocation).toBe(true);
    expect(page.data.locationMessage).toBe("");
  });

  test("keeps walking active when current location cannot be displayed", async () => {
    getCurrentLocation.mockRejectedValueOnce(
      Object.assign(new Error("Location failed"), {
        code: "LOCATION_FAILED"
      })
    );

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    page.loadWalkingRoute(TEST_ROUTE);

    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.error).toBe(false);
    expect(page.data.showUserLocation).toBe(false);
    expect(page.data.locationMessage).toBe("暂时无法显示当前位置");
    expect(page._active).toBe(true);

    warnSpy.mockRestore();
  });

  test("calculates elapsed time from the original start timestamp", () => {
    page.loadWalkingRoute(TEST_ROUTE);

    jest.setSystemTime(new Date("2026-10-01T12:01:05.000Z"));
    page.updateElapsedTime();

    expect(page.data.elapsedSeconds).toBe(65);
    expect(page.data.elapsedText).toBe("00:01:05");
  });

  test("backgrounding and resuming does not reset elapsed walking time", () => {
  page.onLoad({
    routeId: TEST_ROUTE.routeId
  });

  expect(jest.getTimerCount()).toBe(1);

  page.onHide();

  expect(jest.getTimerCount()).toBe(0);

  jest.setSystemTime(new Date("2026-10-01T12:10:00.000Z"));

  page.onShow();

  expect(page.data.elapsedSeconds).toBe(600);
  expect(page.data.elapsedText).toBe("00:10:00");
  expect(jest.getTimerCount()).toBe(1);

  page.onShow();

  expect(jest.getTimerCount()).toBe(1);
});

  test("finishing a walk stores the result and resets navigation to Feedback", () => {
    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    page.loadWalkingRoute(TEST_ROUTE);

    jest.setSystemTime(new Date("2026-10-01T12:12:30.000Z"));

    page.finishWalk();

    expect(wx.reLaunch).toHaveBeenCalledTimes(1);

    const navigationOptions = wx.reLaunch.mock.calls[0][0];

    expect(navigationOptions.url).toBe(
      `/pages/feedback/feedback?routeId=${encodeURIComponent(TEST_ROUTE.routeId)}`
    );

    expect(wx.getStorageSync("pendingWalkResult")).toEqual(
      expect.objectContaining({
        routeId: TEST_ROUTE.routeId,
        route: TEST_ROUTE,
        startTime: "2026-10-01T12:00:00.000Z",
        endTime: "2026-10-01T12:12:30.000Z",
        actualDurationSeconds: 750,
        completionStatus: "completed"
      })
    );

    expect(page.data.ended).toBe(true);
    expect(page.data.finishing).toBe(true);
    expect(page.data.elapsedSeconds).toBe(750);
    expect(page.data.elapsedText).toBe("00:12:30");
    expect(page._active).toBe(false);
  });

  test("finishing an opted-in walk stops trajectory tracking", async () => {
    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.finishWalk();

    const trackingStopPromise = page._trackingStopPromise;

    if (trackingStopPromise) {
      await trackingStopPromise;
    }

    expect(stopTracking).toHaveBeenCalledTimes(1);

    expect(
      wx.getStorageSync("pendingWalkResult")
    ).toEqual(
      expect.objectContaining({
        trajectoryEnabled: true,
        completionStatus: "completed"
      })
    );
  });

  test("ending an opted-in walk early also stops trajectory tracking", async () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: true,
        cancel: false
      });
    });

    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.endWalkEarly();

    const trackingStopPromise = page._trackingStopPromise;

    if (trackingStopPromise) {
      await trackingStopPromise;
    }

    expect(stopTracking).toHaveBeenCalledTimes(1);
    expect(
      wx.getStorageSync("pendingWalkResult")
    ).toEqual(
      expect.objectContaining({
        trajectoryEnabled: true,
        completionStatus: "ended_early"
      })
    );
  });

  test("finishing clears the local active-walk lock", () => {
    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(wx.getStorageSync("activeWalkSession")).toBeTruthy();

    page.finishWalk();

    expect(wx.getStorageSync("activeWalkSession")).toBeUndefined();
  });

  test("confirming early end records ended_early", () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: true,
        cancel: false
      });
    });

    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    page.loadWalkingRoute(TEST_ROUTE);
    page.endWalkEarly();

    expect(wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "提前结束散步？",
        confirmText: "结束散步",
        cancelText: "继续散步"
      })
    );

    expect(wx.getStorageSync("pendingWalkResult")).toEqual(
      expect.objectContaining({
        completionStatus: "ended_early"
      })
    );

    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("canceling early end keeps the walk active", () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: false,
        cancel: true
      });
    });

    page.loadWalkingRoute(TEST_ROUTE);
    page.endWalkEarly();

    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
  });

  test("duplicate finish actions do not open multiple Feedback pages", () => {
    page.loadWalkingRoute(TEST_ROUTE);

    page.finishWalk();
    page.finishWalk();

    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("restores the active walk when opening Feedback fails", () => {
  wx.reLaunch.mockImplementation(options => {
    options.fail();
  });

  page.onLoad({
    routeId: TEST_ROUTE.routeId
  });

  page.finishWalk();

  expect(page._active).toBe(true);
  expect(page.data.ended).toBe(false);
  expect(page.data.finishing).toBe(false);

  expect(wx.showToast).toHaveBeenCalledWith({
    title: "暂时无法打开评价页面",
    icon: "none"
  });

  expect(wx.enableAlertBeforeUnload).toHaveBeenCalled();
  expect(wx.getStorageSync("activeWalkSession")).toEqual(
    expect.objectContaining({
      routeId: TEST_ROUTE.routeId,
      startTimeMs: new Date("2026-10-01T12:00:00.000Z").getTime()
    })
  );
  expect(wx.getStorageSync("pendingWalkResult")).toBeUndefined();
  expect(jest.getTimerCount()).toBe(1);
});

  test("restarts trajectory tracking when Feedback navigation fails", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    wx.reLaunch.mockImplementation(options => {
      options.fail();
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(startTracking).toHaveBeenCalledTimes(1);

    page.finishWalk();

    const trackingStopPromise = page._trackingStopPromise;

    if (trackingStopPromise) {
      await trackingStopPromise;
    }

    await Promise.resolve();

    expect(stopTracking).toHaveBeenCalledTimes(1);
    expect(startTracking).toHaveBeenCalledTimes(2);

    expect(
      wx.getStorageSync("activeWalkSession")
    ).toEqual(
      expect.objectContaining({
        routeId: TEST_ROUTE.routeId,
        trackingEnabled: true
      })
    );

    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
  });

  test("restores the active route lock even when pending-result cleanup fails", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    wx.removeStorageSync.mockImplementation(key => {
      if (key === "pendingWalkResult") {
        throw new Error("Pending cleanup failed");
      }

      delete storage[key];
    });

    wx.reLaunch.mockImplementation(options => {
      options.fail();
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    page.finishWalk();

    expect(wx.getStorageSync("activeWalkSession")).toEqual(
      expect.objectContaining({
        routeId: TEST_ROUTE.routeId,
        startTimeMs: new Date("2026-10-01T12:00:00.000Z").getTime()
      })
    );
    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
    expect(page.data.finishing).toBe(false);
    expect(jest.getTimerCount()).toBe(1);

    warnSpy.mockRestore();
  });

  test("cleans the pending result when completion fails after it was saved", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    wx.removeStorageSync.mockImplementation(key => {
      if (key === "activeWalkSession") {
        throw new Error("Active session cleanup failed");
      }

      delete storage[key];
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    page.finishWalk();

    expect(wx.getStorageSync("pendingWalkResult")).toBeUndefined();
    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
    expect(page.data.finishing).toBe(false);

    warnSpy.mockRestore();
  });

  test("custom back keeps the active route locked unless the user ends early", () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: false,
        cancel: true
      });
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    page.handleNavigationBack();

    expect(wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "散步正在进行",
        confirmText: "提前结束",
        cancelText: "继续散步"
      })
    );

    expect(wx.navigateBack).not.toHaveBeenCalled();
    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
  });

  test("protects an active walk from accidental page exit", () => {
    page.loadWalkingRoute(TEST_ROUTE);

    expect(wx.enableAlertBeforeUnload).toHaveBeenCalledWith({
      message: "散步路线已锁定。如需更换路线，请先点击“提前结束”。"
    });

    page.onUnload();

    expect(wx.disableAlertBeforeUnload).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("returnToRoute navigates back", () => {
    page.returnToRoute();

    expect(wx.navigateBack).toHaveBeenCalledTimes(1);
  });
});