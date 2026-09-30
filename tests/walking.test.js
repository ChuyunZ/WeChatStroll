const { mockRoutes } = require("../miniprogram/data/mock-routes");

const TEST_ROUTE = mockRoutes[0];

let pageDefinition;
let page;
let getCurrentLocation;
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

  jest.doMock("../miniprogram/services/location", () => ({
    getCurrentLocation
  }));

  global.Page = jest.fn(definition => {
    pageDefinition = definition;
  });

  global.wx = {
    enableAlertBeforeUnload: jest.fn(),
    disableAlertBeforeUnload: jest.fn(),
    navigateBack: jest.fn(),
    navigateTo: jest.fn(),
    showModal: jest.fn(),
    showToast: jest.fn(),
    getStorageSync: jest.fn(key => storage[key]),
    setStorageSync: jest.fn((key, value) => {
      storage[key] = value;
    }),
    removeStorageSync: jest.fn(key => {
      delete storage[key];
    })
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

  test("finishing a walk sends the walk result to Feedback", () => {
    const feedbackEventChannel = {
      emit: jest.fn()
    };

    wx.navigateTo.mockImplementation(options => {
      options.success({
        eventChannel: feedbackEventChannel
      });
    });

    page.loadWalkingRoute(TEST_ROUTE);

    jest.setSystemTime(new Date("2026-10-01T12:12:30.000Z"));

    page.finishWalk();

    expect(wx.navigateTo).toHaveBeenCalledTimes(1);

    const navigateOptions = wx.navigateTo.mock.calls[0][0];

    expect(navigateOptions.url).toBe(
      `/pages/feedback/feedback?routeId=${encodeURIComponent(TEST_ROUTE.routeId)}`
    );

    expect(feedbackEventChannel.emit).toHaveBeenCalledWith(
      "walkResult",
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

  test("finishing clears the local active-walk lock", () => {
    const feedbackEventChannel = {
      emit: jest.fn()
    };

    wx.navigateTo.mockImplementation(options => {
      options.success({
        eventChannel: feedbackEventChannel
      });
    });

    page.onLoad({
      routeId: TEST_ROUTE.routeId
    });

    expect(wx.getStorageSync("activeWalkSession")).toBeTruthy();

    page.finishWalk();

    expect(wx.getStorageSync("activeWalkSession")).toBeUndefined();
  });

  test("confirming early end records ended_early", () => {
    const feedbackEventChannel = {
      emit: jest.fn()
    };

    wx.showModal.mockImplementation(options => {
      options.success({
        confirm: true,
        cancel: false
      });
    });

    wx.navigateTo.mockImplementation(options => {
      options.success({
        eventChannel: feedbackEventChannel
      });
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

    expect(feedbackEventChannel.emit).toHaveBeenCalledWith(
      "walkResult",
      expect.objectContaining({
        completionStatus: "ended_early"
      })
    );
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

    expect(wx.navigateTo).not.toHaveBeenCalled();
    expect(page._active).toBe(true);
    expect(page.data.ended).toBe(false);
  });

  test("duplicate finish actions do not open multiple Feedback pages", () => {
    page.loadWalkingRoute(TEST_ROUTE);

    page.finishWalk();
    page.finishWalk();

    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  });

  test("restores the active walk when opening Feedback fails", () => {
  wx.navigateTo.mockImplementation(options => {
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
  expect(jest.getTimerCount()).toBe(1);
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