const { mockWalkRecords } = require("./helpers/walk-records");
let walkRecords;
async function flushCloud() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const { mockRoutes } = require("../miniprogram/data/mock-routes");

const TEST_ROUTE = mockRoutes[0];

let pageDefinition;
let page;
let getCurrentLocation;
let startTracking;
let stopTracking;
let finalizeTracking;
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
  storage = { activeWalkSession: { version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] }, status: "active", routeId: TEST_ROUTE.routeId, route: TEST_ROUTE, startTimeMs: Date.now(), trackingEnabled: false } };
  walkRecords = mockWalkRecords(() => storage);
  jest.doMock("../miniprogram/services/walk-records", () => walkRecords);
  getCurrentLocation = jest.fn().mockResolvedValue({
    latitude: 31.2304,
    longitude: 121.4737
  });

  trackerActive = false;

  startTracking = jest.fn().mockImplementation(async args => {
    trackerActive = true;

    return {
      session: {
        version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
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

  finalizeTracking = jest.fn(() => stopTracking().then(() => ({ trajectoryPartial: false })));
  isTracking = jest.fn(() => trackerActive);

  jest.doMock("../miniprogram/services/location", () => ({
    getCurrentLocation
  }));

  jest.doMock(
    "../miniprogram/services/walking-tracker",
    () => ({
      startTracking,
      stopTracking,
      finalizeTracking,
      stopTrackingForSession: jest.fn(),
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
    openSetting: jest.fn(),
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

test("cloud completion failure keeps the same walk retryable with its original confirmation", async () => {
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  const confirmedAt = Date.now();
  walkRecords.completeWalk.mockRejectedValueOnce(new Error("database unavailable"));
  await page.finishWalk();
  expect(page._active).toBe(true);
  expect(storage.activeWalkSession.walkId).toBe("walk-test");
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(finalizeTracking).not.toHaveBeenCalled();
  expect(wx.reLaunch).not.toHaveBeenCalled();
  jest.setSystemTime(confirmedAt + 3000);
  await page.finishWalk();
  expect(walkRecords.completeWalk).toHaveBeenLastCalledWith(expect.objectContaining({ walkId: "walk-test", endTimeMs: confirmedAt }));
  expect(storage.pendingWalkResult.endTime).toBe(new Date(confirmedAt).toISOString());
});

test("reloading Walking after server abandonment exits cleanly instead of showing a recovery error", async () => {
  const local = storage.activeWalkSession;
  walkRecords.getWalk.mockResolvedValueOnce({
    walkId: local.walkId,
    routeId: local.routeId,
    status: "abandoned",
    completionStatus: "abandoned"
  });

  await page.onLoad({ routeId: TEST_ROUTE.routeId });

  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(page._active).toBe(false);
  expect(page.data.error).toBe(false);
  expect(page.data.ended).toBe(true);
  expect(startTracking).not.toHaveBeenCalled();
  expect(wx.reLaunch).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith({
    title: "本次散步因长时间未结束，已自动关闭",
    icon: "none"
  });
  expect(wx.navigateBack).toHaveBeenCalledTimes(1);
});

test("a completion rejected as abandoned closes the stale walk without opening Feedback", async () => {
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  walkRecords.completeWalk.mockRejectedValueOnce(
    Object.assign(new Error("stale walk"), { code: "WALK_ABANDONED" })
  );

  await page.finishWalk();

  expect(storage.activeWalkSession).toBeUndefined();
  expect(storage.pendingWalkResult).toBeUndefined();
  expect(page._active).toBe(false);
  expect(page.data.ended).toBe(true);
  expect(finalizeTracking).not.toHaveBeenCalled();
  expect(wx.reLaunch).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith({
    title: "本次散步因长时间未结束，已自动关闭",
    icon: "none"
  });
  expect(wx.navigateBack).toHaveBeenCalledTimes(1);
});

test("a page reload retries a saved completion request with the same state and time", async () => {
  const confirmedAt = Date.now();
  storage.activeWalkSession.completionRequest = { walkId: "walk-test", completionStatus: "ended_early", endTimeMs: confirmedAt, trajectoryPartial: false };
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  jest.setSystemTime(confirmedAt + 1000);
  await page.finishWalk();
  expect(storage.pendingWalkResult).toMatchObject({ walkId: "walk-test", completionStatus: "ended_early", endTime: new Date(confirmedAt).toISOString() });
});

test("opening Walking without a durable session cannot create a local-only walk", async () => {
  delete storage.activeWalkSession;
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  expect(page._active).toBe(false);
  expect(page.data.error).toBe(true);
  expect(storage.activeWalkSession).toBeUndefined();
  expect(walkRecords.startWalk).not.toHaveBeenCalled();
});

describe("Walking page", () => {
  test("receives the confirmed route through EventChannel", async () => {
    const eventChannel = createEventChannel();

    page = loadWalkingPage({
      eventChannel
    });

    const local = storage.activeWalkSession;
    delete storage.activeWalkSession;
    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(eventChannel.on).toHaveBeenCalledWith(
      "walkingRoute",
      expect.any(Function)
    );

    expect(page.data.loading).toBe(true);

    storage.activeWalkSession = local;
    await eventChannel.handlers.walkingRoute(TEST_ROUTE);
    await flushCloud();

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

  test("rejects a route whose ID does not match the URL", async () => {
    const eventChannel = createEventChannel();

    page = loadWalkingPage({
      eventChannel
    });

    delete storage.activeWalkSession;
    await page.onLoad({
      routeId: "different-route"
    });

    await eventChannel.handlers.walkingRoute(TEST_ROUTE);

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(true);
    expect(page.data.route).toBeNull();
  });

  test("restores the durable local route when opened directly", async () => {
    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe(false);
    expect(page.data.route.routeId).toBe(TEST_ROUTE.routeId);
  });

  test("restores an existing active walk with its original start time", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: new Date("2026-10-01T11:30:00.000Z").getTime()
    });

    await page.onLoad({
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
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs,
      trackingEnabled: true
    });

    await page.onLoad({
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
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: false
    });

    await page.onLoad({
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
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    await page.onLoad({
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

  test("guides the user to settings after background permission denial", async () => {
    const warnSpy =
      jest.spyOn(console, "warn")
        .mockImplementation(() => {});

    startTracking
      .mockRejectedValueOnce(
        Object.assign(
          new Error("permission denied"),
          {
            code:
              "BACKGROUND_LOCATION_PERMISSION_DENIED",
            originalError: {
              errMsg:
                "startLocationUpdateBackground:fail auth deny"
            }
          }
        )
      )
      .mockImplementationOnce(async args => {
        trackerActive = true;

        return {
          session: {
            version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
            status: "active",
            routeId: args.routeId,
            startTimeMs: args.startTimeMs
          },
          resumed: false
        };
      });

    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: true,
        cancel: false
      });

      if (options.complete) {
        options.complete();
      }
    });

    wx.openSetting.mockImplementation(options => {
      options.success({
        authSetting: {
          "scope.userLocationBackground": true
        }
      });
    });

    wx.setStorageSync("activeWalkSession", {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    const initialStartPromise =
      page._trackingStartPromise;

    if (initialStartPromise) {
      await initialStartPromise;
    }

    await Promise.resolve();

    const retryStartPromise =
      page._trackingStartPromise;

    if (retryStartPromise) {
      await retryStartPromise;
    }

    expect(wx.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "需要后台定位权限",
        confirmText: "去设置",
        cancelText: "暂不记录"
      })
    );

    expect(wx.openSetting).toHaveBeenCalledTimes(1);
    expect(startTracking).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  test("hiding the Walking page does not stop background trajectory tracking", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.onHide();

    expect(stopTracking).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
  });

  test("shows an error for an invalid route", async () => {
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

  test("calculates elapsed time from the original start timestamp", async () => {
    page.loadWalkingRoute(TEST_ROUTE);

    jest.setSystemTime(new Date("2026-10-01T12:01:05.000Z"));
    page.updateElapsedTime();

    expect(page.data.elapsedSeconds).toBe(65);
    expect(page.data.elapsedText).toBe("00:01:05");
  });

  test("backgrounding and resuming does not reset elapsed walking time", async () => {
  await page.onLoad({
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

  test("finishing a walk stores the result and resets navigation to Feedback", async () => {
    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    await page.onLoad({ routeId: TEST_ROUTE.routeId });

    jest.setSystemTime(new Date("2026-10-01T12:12:30.000Z"));

    page.finishWalk();
    await flushCloud();

    expect(wx.reLaunch).toHaveBeenCalledTimes(1);

    const navigationOptions = wx.reLaunch.mock.calls[0][0];

    expect(navigationOptions.url).toBe(
      `/pages/feedback/feedback?walkId=${encodeURIComponent("walk-test")}`
    );

    expect(wx.getStorageSync("pendingWalkResult")).toEqual(
      expect.objectContaining({
        routeId: TEST_ROUTE.routeId,
        startTime: "2026-10-01T12:00:00.000Z",
        endTime: "2026-10-01T12:12:30.000Z",
        actualDurationSeconds: 750,
        completionStatus: "completed",
        trajectoryEndTimeMs: new Date(
          "2026-10-01T12:12:30.000Z"
        ).getTime()
      })
    );

    expect(wx.getStorageSync("pendingWalkResult")).not.toHaveProperty("route");
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
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.finishWalk();
    await flushCloud();

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
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    page.endWalkEarly();
    await flushCloud();

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

  test("finishing clears the local active-walk lock", async () => {
    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(wx.getStorageSync("activeWalkSession")).toBeTruthy();

    page.finishWalk();
    await flushCloud();

    expect(wx.getStorageSync("activeWalkSession")).toBeUndefined();
  });

  test("confirming early end records ended_early", async () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: true,
        cancel: false
      });
    });

    wx.reLaunch.mockImplementation(options => {
      if (options.success) options.success();
    });

    await page.onLoad({ routeId: TEST_ROUTE.routeId });
    page.endWalkEarly();
    await flushCloud();

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

  test("canceling early end keeps the walk active", async () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: false,
        cancel: true
      });
    });

    page.loadWalkingRoute(TEST_ROUTE);
    page.endWalkEarly();
    await flushCloud();

    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
  });

  test("duplicate finish actions do not open multiple Feedback pages", async () => {
    await page.onLoad({ routeId: TEST_ROUTE.routeId });

    page.finishWalk();
    await flushCloud();
    page.finishWalk();
    await flushCloud();

    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("keeps the cloud walk terminal when opening Feedback fails", async () => {
  wx.reLaunch.mockImplementation(options => {
    options.fail();
  });

  await page.onLoad({
    routeId: TEST_ROUTE.routeId
  });

  page.finishWalk();
  await flushCloud();

  expect(page._active).toBe(false);
  expect(page.data.ended).toBe(true);
  expect(page.data.finishing).toBe(true);

  expect(wx.showToast).toHaveBeenCalledWith({
    title: "散步已保存，暂时无法打开评价页面",
    icon: "none"
  });

  expect(wx.enableAlertBeforeUnload).toHaveBeenCalled();
  expect(wx.getStorageSync("activeWalkSession")).toBeUndefined();
  expect(wx.getStorageSync("pendingWalkResult").walkId).toBe("walk-test");
  expect(jest.getTimerCount()).toBe(0);
});

  test("does not restart trajectory tracking when Feedback navigation fails", async () => {
    wx.setStorageSync("activeWalkSession", {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
      status: "active",
      routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE,
      startTimeMs: Date.now(),
      trackingEnabled: true
    });

    wx.reLaunch.mockImplementation(options => {
      options.fail();
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(startTracking).toHaveBeenCalledTimes(1);

    page.finishWalk();
    await flushCloud();

    const trackingStopPromise = page._trackingStopPromise;

    if (trackingStopPromise) {
      await trackingStopPromise;
    }

    await Promise.resolve();

    expect(stopTracking).toHaveBeenCalledTimes(1);
    expect(startTracking).toHaveBeenCalledTimes(1);

    expect(storage.activeWalkSession).toBeUndefined();
    expect(storage.pendingWalkResult.walkId).toBe("walk-test");

    expect(page._active).toBe(false);
    expect(page.data.ended).toBe(true);
  });

  test("keeps completion authoritative when navigation rollback cannot clear the result", async () => {
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

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    page.finishWalk();
    await flushCloud();

    expect(storage.activeWalkSession).toBeUndefined();
    expect(storage.pendingWalkResult).toBeTruthy();
    expect(page._active).toBe(false);
    expect(page.data.ended).toBe(true);
    expect(page.data.finishing).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    warnSpy.mockRestore();
  });

  test.each(["completed", "ended_early"])("terminal %s still clears route when optional Feedback write fails", async completionStatus => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const originalWrite = wx.setStorageSync.getMockImplementation();
    wx.setStorageSync.mockImplementation((key, value) => {
      if (key === "pendingWalkResult") throw new Error("feedback storage unavailable");
      return originalWrite(key, value);
    });
    await page.onLoad({ routeId: TEST_ROUTE.routeId });
    if (completionStatus === "completed") await page.finishWalk();
    else await page.completeWalk("ended_early");
    expect(storage.activeWalkSession).toBeUndefined();
    expect(storage.pendingWalkResult).toBeUndefined();
    expect(wx.removeStorageSync).toHaveBeenCalledWith("activeWalkSession");
    expect(page._active).toBe(false);
    expect(page.data.ended).toBe(true);
    expect(wx.reLaunch).toHaveBeenCalledWith(expect.objectContaining({
      url: `/pages/feedback/feedback?walkId=${encodeURIComponent("walk-test")}`
    }));
    warn.mockRestore();
  });

  test("retains terminal result when local active-lock cleanup fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    wx.removeStorageSync.mockImplementation(key => {
      if (key === "activeWalkSession") {
        throw new Error("Active session cleanup failed");
      }

      delete storage[key];
    });

    await page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    page.finishWalk();
    await flushCloud();

    expect(wx.getStorageSync("pendingWalkResult")).toBeTruthy();
    expect(wx.reLaunch).toHaveBeenCalled();
    expect(page._active).toBe(false);
    expect(page.data.ended).toBe(true);
    expect(page.data.finishing).toBe(true);

    warnSpy.mockRestore();
  });

  test("custom back keeps the active route locked unless the user ends early", async () => {
    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: false,
        cancel: true
      });
    });

    await page.onLoad({
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

  test("protects an active walk from accidental page exit", async () => {
    page.loadWalkingRoute(TEST_ROUTE);

    expect(wx.enableAlertBeforeUnload).toHaveBeenCalledWith({
      message: "散步路线已锁定。如需更换路线，请先点击“提前结束”。"
    });

    page.onUnload();

    expect(wx.disableAlertBeforeUnload).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("returnToRoute navigates back", async () => {
    page.returnToRoute();

    expect(wx.navigateBack).toHaveBeenCalledTimes(1);
  });
});
describe("completion trajectory quality", () => {
  async function optedIn() {
    storage.activeWalkSession = {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] }, status: "active", routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE, startTimeMs: Date.now(), trackingEnabled: true
    };
    await page.onLoad({ routeId: TEST_ROUTE.routeId });
    await Promise.resolve();
    await Promise.resolve();
  }

  test.each(["completed", "ended_early"])("%s waits for one final flush and persists partial metadata", async status => {
    await optedIn();
    let flushed;
    finalizeTracking.mockImplementation(() => new Promise(resolve => { flushed = resolve; }));
    const done = page.completeWalk(status);
    await flushCloud();
    page.finishWalk();
    await flushCloud();
    expect(finalizeTracking).toHaveBeenCalledTimes(1);
    expect(wx.reLaunch).not.toHaveBeenCalled();
    flushed({ trajectoryPartial: true });
    await done;
    expect(storage.pendingWalkResult).toMatchObject({ trajectoryPartial: true, completionStatus: status });
    expect(storage.activeWalkSession).toBeUndefined();
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("healthy finalization records a nonpartial completed walk and writes durable metadata", async () => {
    await optedIn();
    await page.finishWalk();
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(false);
    expect(walkRecords.updateTrajectoryMetadata).toHaveBeenCalledWith({
      walkId: "walk-test",
      trajectoryPartial: false,
      trajectoryEndTimeMs: expect.any(Number)
    });
  });

  test("trajectory failure still completes without restarting tracking", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await optedIn();
    finalizeTracking.mockRejectedValue(new Error("failed"));
    await page.finishWalk();
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(true);
    expect(walkRecords.updateTrajectoryMetadata).toHaveBeenCalledWith({
      walkId: "walk-test",
      trajectoryPartial: true,
      trajectoryEndTimeMs: expect.any(Number)
    });
    expect(page._active).toBe(false);
    expect(startTracking).toHaveBeenCalledTimes(1);
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("navigation failure retains partial quality on the terminal result", async () => {
    await optedIn();
    finalizeTracking.mockImplementation(async () => {
      await stopTracking();
      return { trajectoryPartial: true };
    });
    wx.reLaunch.mockImplementation(({ fail }) => fail());
    await page.finishWalk();
    expect(page._active).toBe(false);
    expect(startTracking).toHaveBeenCalledTimes(1);
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(true);
  });
});

test("failed navigation cannot restart tracking when the active lock cannot be restored", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  storage.activeWalkSession = {
    version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] }, status: "active", routeId: TEST_ROUTE.routeId,
    route: TEST_ROUTE, startTimeMs: Date.now(), trackingEnabled: true
  };
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  await Promise.resolve();
  await Promise.resolve();
  wx.reLaunch.mockImplementation(({ fail }) => {
    wx.setStorageSync.mockImplementation(() => { throw new Error("storage unavailable"); });
    fail();
  });
  await page.finishWalk();
  expect(page._active).toBe(false);
  expect(storage.pendingWalkResult).toBeTruthy();
  expect(startTracking).toHaveBeenCalledTimes(1);
});

describe("durable completion before trajectory cleanup", () => {
  let flushed;
  async function begin() {
    storage.activeWalkSession = {
      version: 2, walkId: "walk-test", preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] }, status: "active", routeId: TEST_ROUTE.routeId,
      route: TEST_ROUTE, startTimeMs: Date.now() - 60000, trackingEnabled: true
    };
    await page.onLoad({ routeId: TEST_ROUTE.routeId });
    await page._trackingStartPromise;
    finalizeTracking.mockImplementation(() => new Promise(resolve => { flushed = resolve; }));
  }

  test.each(["completed", "ended_early"])("%s persists the confirmation time before a five-second flush", async status => {
    await begin();
    const confirmedAt = Date.now();
    wx.showModal.mockImplementation(({ success }) => success({ confirm: true }));
    if (status === "completed") page.finishWalk();
    else page.endWalkEarly();
    await flushCloud();
    const stop = page._trackingStopPromise;
    expect(storage.pendingWalkResult).toMatchObject({
      endTime: new Date(confirmedAt).toISOString(),
      actualDurationSeconds: 60,
      completionStatus: status,
      trajectoryEndTimeMs: confirmedAt,
      trajectoryPartial: true
    });
    expect(storage.activeWalkSession).toBeUndefined();
    expect(page._active).toBe(false);
    expect(wx.reLaunch).not.toHaveBeenCalled();
    page.onShow();
    expect(wx.navigateBack).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    flushed({ trajectoryPartial: false });
    await stop;
    await flushCloud();
    expect(storage.pendingWalkResult).toMatchObject({
      endTime: new Date(confirmedAt).toISOString(),
      actualDurationSeconds: 60,
      trajectoryEndTimeMs: confirmedAt + 5000,
      trajectoryPartial: false
    });
    expect(walkRecords.updateTrajectoryMetadata).toHaveBeenCalledWith({
      walkId: "walk-test",
      trajectoryPartial: false,
      trajectoryEndTimeMs: confirmedAt + 5000
    });
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("reload during finalization never resumes the ended walk (remaining lock=%s)", async remainingLock => {
    await begin();
    const oldLock = JSON.parse(JSON.stringify(storage.activeWalkSession));
    page.finishWalk();
    await flushCloud();
    const durable = JSON.parse(JSON.stringify(storage));
    if (remainingLock) durable.activeWalkSession = oldLock;
    page = loadWalkingPage();
    storage = durable;
    if (remainingLock) {
      // The page mock is recreated on reload; model the *durable server*
      // completion explicitly rather than treating local pending as proof.
      walkRecords.getWalk.mockResolvedValueOnce({
        ...durable.pendingWalkResult,
        status: durable.pendingWalkResult.completionStatus
      });
    }
    await page.onLoad({ routeId: TEST_ROUTE.routeId });
    const service = require("../miniprogram/services/active-walk-session");
    expect(service.getActiveWalkSession()).toBeNull();
    expect(page._active).toBe(false);
    expect(startTracking).not.toHaveBeenCalled();
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(true);
    expect(wx.reLaunch).toHaveBeenCalledWith(expect.objectContaining({
      url: `/pages/feedback/feedback?walkId=${encodeURIComponent("walk-test")}`
    }));
    const tracker = require("../miniprogram/services/walking-tracker");
    expect(tracker.stopTrackingForSession).toHaveBeenCalledWith(expect.objectContaining({
      routeId: oldLock.routeId, startTimeMs: oldLock.startTimeMs
    }));
  });

  test("duplicate confirmation makes one durable completion and one final flush", async () => {
    await begin();
    const done = page.finishWalk();
    await flushCloud();
    const writes = () => wx.setStorageSync.mock.calls.filter(([key]) => key === "pendingWalkResult");
    expect(writes()).toHaveLength(1);
    page.finishWalk();
    await flushCloud();
    page.completeWalk("ended_early");
    expect(writes()).toHaveLength(1);
    expect(finalizeTracking).toHaveBeenCalledTimes(1);
    flushed({ trajectoryPartial: true });
    await done;
    expect(writes()).toHaveLength(2); // Initial completion plus its quality update.
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(true);
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("quality storage failure cannot undo durable completion", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await begin();
    const done = page.finishWalk();
    await flushCloud();
    wx.setStorageSync.mockImplementation(() => { throw new Error("storage unavailable"); });
    flushed({ trajectoryPartial: false });
    await done;
    expect(storage.pendingWalkResult.trajectoryPartial).toBe(true);
    expect(storage.activeWalkSession).toBeUndefined();
    expect(page._active).toBe(false);
    expect(startTracking).toHaveBeenCalledTimes(1);
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  test("navigation failure cannot change the saved confirmation timestamp", async () => {
    await begin();
    const firstTime = Date.now();
    const first = page.finishWalk();
    await flushCloud();
    wx.reLaunch.mockImplementationOnce(({ fail }) => fail());
    await jest.advanceTimersByTimeAsync(5000);
    flushed({ trajectoryPartial: false });
    trackerActive = false;
    await first;
    expect(page._active).toBe(false);
    expect(storage.activeWalkSession).toBeUndefined();
    await jest.advanceTimersByTimeAsync(5000);
    await page.finishWalk();
    expect(storage.pendingWalkResult.endTime).toBe(new Date(firstTime).toISOString());
    expect(walkRecords.completeWalk).toHaveBeenCalledTimes(1);
    expect(startTracking).toHaveBeenCalledTimes(1);
  });

  test("incomplete navigation rollback cannot restart opted-in tracking", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await begin();
    const done = page.finishWalk();
    await flushCloud();
    wx.reLaunch.mockImplementation(({ fail }) => {
      wx.removeStorageSync.mockImplementation(key => {
        if (key === "pendingWalkResult") throw new Error("cannot clear completion");
        delete storage[key];
      });
      fail();
    });
    flushed({ trajectoryPartial: false });
    await done;
    expect(page._active).toBe(false);
    expect(startTracking).toHaveBeenCalledTimes(1);
    expect(require("../miniprogram/services/active-walk-session").getActiveWalkSession()).toBeNull();
  });
});

test("trajectory metadata write-back failure cannot undo durable completion", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  storage.activeWalkSession = {
    version: 2,
    walkId: "walk-test",
    preferences: { durationMinutes: 30, routeType: "loop", crowdPreference: "medium", environmentPreferences: [] },
    status: "active",
    routeId: TEST_ROUTE.routeId,
    route: TEST_ROUTE,
    startTimeMs: Date.now() - 60000,
    trackingEnabled: true
  };
  await page.onLoad({ routeId: TEST_ROUTE.routeId });
  await page._trackingStartPromise;
  walkRecords.updateTrajectoryMetadata.mockRejectedValueOnce(new Error("metadata unavailable"));
  await page.finishWalk();
  expect(storage.pendingWalkResult).toMatchObject({
    walkId: "walk-test",
    completionStatus: "completed",
    trajectoryPartial: false
  });
  expect(storage.activeWalkSession).toBeUndefined();
  expect(page._active).toBe(false);
  expect(wx.reLaunch).toHaveBeenCalledTimes(1);
});
