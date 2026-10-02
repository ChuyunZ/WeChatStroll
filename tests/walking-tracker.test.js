const TEST_ROUTE_ID = "route-test-001";
const TEST_START_TIME_MS = Date.parse("2026-10-01T11:30:00.000Z");

let storage;
let callCloudFunction;
let walkingTracker;

function createWxMock() {
  return {
    getStorageSync: jest.fn(key => storage[key]),

    setStorageSync: jest.fn((key, value) => {
      storage[key] = value;
    }),

    removeStorageSync: jest.fn(key => {
      delete storage[key];
    }),

    getSetting: jest.fn(({ success }) => {
      success({
        authSetting: {
          "scope.userLocationBackground": true
        }
      });
    }),

    authorize: jest.fn(({ success }) => {
      success();
    }),

    startLocationUpdateBackground: jest.fn(({ success }) => {
      success();
    }),

    stopLocationUpdate: jest.fn(({ success }) => {
      success();
    }),

    onLocationChange: jest.fn(),

    offLocationChange: jest.fn()
  };
}

function loadWalkingTracker() {
  jest.resetModules();

  storage = {};

  callCloudFunction = jest.fn().mockResolvedValue({
    success: true
  });

  jest.doMock(
    "../miniprogram/services/cloud-function-client",
    () => ({
      callCloudFunction
    })
  );

  global.wx = createWxMock();

  walkingTracker = require(
    "../miniprogram/services/walking-tracker"
  );

  return walkingTracker;
}

function validLocation(overrides = {}) {
  return {
    latitude: 31.2304,
    longitude: 121.4737,
    accuracy: 8,
    speed: 1.2,
    ...overrides
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(
    new Date("2026-10-01T12:00:00.000Z")
  );

  loadWalkingTracker();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();

  delete global.wx;
});

describe("walking-tracker", () => {
  test("starts background location and stores the tracking session", async () => {
    const result = await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    expect(
      wx.startLocationUpdateBackground
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "gcj02"
      })
    );

    expect(
      wx.onLocationChange
    ).toHaveBeenCalledTimes(1);

    expect(
      storage.activeWalkTracking
    ).toEqual({
      version: 1,
      status: "active",
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    expect(result).toEqual({
      session: storage.activeWalkTracking,
      resumed: false
    });

    expect(
      walkingTracker.isTracking()
    ).toBe(true);
  });

  test("starting the same tracking session twice is idempotent", async () => {
    const first =
      await walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      });

    const second =
      await walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      });

    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);

    expect(
      wx.startLocationUpdateBackground
    ).toHaveBeenCalledTimes(1);

    expect(
      wx.onLocationChange
    ).toHaveBeenCalledTimes(1);
  });

  test("rejects a different tracking session while one is active", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    await expect(
      walkingTracker.startTracking({
        routeId: "different-route",
        startTimeMs: TEST_START_TIME_MS + 1000
      })
    ).rejects.toMatchObject({
      code: "TRACKING_SESSION_CONFLICT"
    });

    expect(
      wx.startLocationUpdateBackground
    ).toHaveBeenCalledTimes(1);
  });

  test("restores a stored tracking session", async () => {
    storage.activeWalkTracking = {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    };

    const result =
      await walkingTracker.resumeTracking();

    expect(result).toEqual({
      session: storage.activeWalkTracking,
      resumed: true
    });

    expect(
      wx.startLocationUpdateBackground
    ).toHaveBeenCalledTimes(1);

    expect(
      wx.onLocationChange
    ).toHaveBeenCalledTimes(1);

    expect(
      walkingTracker.isTracking()
    ).toBe(true);
  });

  test("resumeTracking returns null when no stored session exists", async () => {
    await expect(
      walkingTracker.resumeTracking()
    ).resolves.toBeNull();

    expect(
      wx.startLocationUpdateBackground
    ).not.toHaveBeenCalled();
  });

  test("removes an invalid stored tracking session", () => {
    storage.activeWalkTracking = {
      version: 99,
      status: "active"
    };

    expect(
      walkingTracker.getTrackingSession()
    ).toBeNull();

    expect(
      wx.removeStorageSync
    ).toHaveBeenCalledWith(
      "activeWalkTracking"
    );
  });

  test("removes a stored tracking session older than 12 hours", () => {
    storage.activeWalkTracking = {
      version: 1,
      status: "active",
      routeId: TEST_ROUTE_ID,
      startTimeMs:
        Date.now() - 13 * 60 * 60 * 1000
    };

    expect(
      walkingTracker.getTrackingSession()
    ).toBeNull();

    expect(
      wx.removeStorageSync
    ).toHaveBeenCalledWith(
      "activeWalkTracking"
    );
  });

  test("rejects invalid start arguments", async () => {
    await expect(
      walkingTracker.startTracking({
        routeId: "",
        startTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "INVALID_TRACKING_SESSION"
    });

    await expect(
      walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: 0
      })
    ).rejects.toMatchObject({
      code: "INVALID_TRACKING_SESSION"
    });

    expect(
      wx.startLocationUpdateBackground
    ).not.toHaveBeenCalled();
  });

  test("fails safely when background location is unavailable", async () => {
    delete wx.startLocationUpdateBackground;

    await expect(
      walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "BACKGROUND_LOCATION_UNAVAILABLE"
    });

    expect(
      storage.activeWalkTracking
    ).toBeUndefined();

    expect(
      walkingTracker.isTracking()
    ).toBe(false);
  });

  test("requests background permission before starting when it is not granted yet", async () => {
    wx.getSetting.mockImplementation(({ success }) => {
      success({
        authSetting: {}
      });
    });

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    expect(wx.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "scope.userLocationBackground"
      })
    );

    expect(
      wx.startLocationUpdateBackground
    ).toHaveBeenCalledTimes(1);
  });

  test("reports background permission denial separately", async () => {
    const authError = {
      errMsg: "authorize:fail auth deny"
    };

    wx.getSetting.mockImplementation(({ success }) => {
      success({
        authSetting: {
          "scope.userLocationBackground": false
        }
      });
    });

    wx.authorize.mockImplementation(({ fail }) => {
      fail(authError);
    });

    await expect(
      walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "BACKGROUND_LOCATION_PERMISSION_DENIED",
      originalError: authError
    });

    expect(
      wx.startLocationUpdateBackground
    ).not.toHaveBeenCalled();
  });

  test("maps startLocationUpdateBackground auth deny to permission denial", async () => {
    const authError = {
      errMsg:
        "startLocationUpdateBackground:fail auth deny"
    };

    wx.startLocationUpdateBackground.mockImplementation(
      ({ fail }) => {
        fail(authError);
      }
    );

    await expect(
      walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "BACKGROUND_LOCATION_PERMISSION_DENIED",
      originalError: authError
    });
  });

  test("fails safely when starting background location fails", async () => {
    const providerError =
      new Error("permission denied");

    wx.startLocationUpdateBackground.mockImplementation(
      ({ fail }) => {
        fail(providerError);
      }
    );

    await expect(
      walkingTracker.startTracking({
        routeId: TEST_ROUTE_ID,
        startTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "BACKGROUND_LOCATION_FAILED",
      originalError: providerError
    });

    expect(
      storage.activeWalkTracking
    ).toBeUndefined();

    expect(
      walkingTracker.isTracking()
    ).toBe(false);
  });

  test("uploads a current-location seed when tracking starts", async () => {
    global.wx.getLocation = jest.fn(options => {
      options.success({
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 9,
        speed: 0,
        direction: 0,
        altitude: 5
      });
    });

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(global.wx.getLocation).toHaveBeenCalled();
    expect(callCloudFunction).toHaveBeenCalledTimes(1);
    expect(callCloudFunction.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        action: "uploadTrace",
        routeId: TEST_ROUTE_ID,
        walkStartTimeMs: TEST_START_TIME_MS
      })
    );
  });

  test("uploads the first valid location callback", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    const nowMs = Date.now();

    handler(validLocation());

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledWith(
      "trackProvider",
      {
        action: "uploadTrace",
        routeId: TEST_ROUTE_ID,
        walkStartTimeMs: TEST_START_TIME_MS,
        point: {
          latitude: 31.2304,
          longitude: 121.4737,
          timestampMs: nowMs,
          accuracy: 8,
          speed: 1.2,
          direction: null,
          altitude: null
        }
      },
      {
        fallbackCode: "TRACK_UPLOAD_FAILED",
        fallbackMessage:
          "Unable to upload walking location."
      }
    );
  });

  test("preserves source timestamp and optional GPS metadata", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    const sourceTimestampMs =
      Date.now() - 4321;

    handler(
      validLocation({
        accuracy: undefined,
        horizontalAccuracy: 6,
        timestampMs: sourceTimestampMs,
        direction: 135,
        altitude: 12
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledWith(
      "trackProvider",
      {
        action: "uploadTrace",
        routeId: TEST_ROUTE_ID,
        walkStartTimeMs: TEST_START_TIME_MS,
        point: {
          latitude: 31.2304,
          longitude: 121.4737,
          timestampMs: sourceTimestampMs,
          accuracy: 6,
          speed: 1.2,
          direction: 135,
          altitude: 12
        }
      },
      expect.any(Object)
    );
  });

  test("retries one failed point on the next eligible callback", async () => {
    const warnSpy =
      jest.spyOn(console, "warn")
        .mockImplementation(() => {});

    callCloudFunction
      .mockRejectedValueOnce(
        Object.assign(
          new Error("temporary failure"),
          {
            code: "TRACK_UPLOAD_FAILED"
          }
        )
      )
      .mockResolvedValueOnce({
        success: true
      });

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler(
      validLocation({
        latitude: 31.2304
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:15.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2309
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(2);

    expect(
      callCloudFunction.mock.calls[1][1].point.latitude
    ).toBe(31.2304);

    warnSpy.mockRestore();
  });

  test("drops a point after its single buffered retry fails", async () => {
    const warnSpy =
      jest.spyOn(console, "warn")
        .mockImplementation(() => {});

    callCloudFunction
      .mockRejectedValueOnce(
        Object.assign(
          new Error("first failure"),
          {
            code: "TRACK_UPLOAD_FAILED"
          }
        )
      )
      .mockRejectedValueOnce(
        Object.assign(
          new Error("retry failure"),
          {
            code: "TRACK_UPLOAD_FAILED"
          }
        )
      )
      .mockResolvedValueOnce({
        success: true
      });

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler(
      validLocation({
        latitude: 31.2304
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:15.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2305
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:30.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2306
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(3);

    expect(
      callCloudFunction.mock.calls[1][1].point.latitude
    ).toBe(31.2304);

    expect(
      callCloudFunction.mock.calls[2][1].point.latitude
    ).toBe(31.2306);

    warnSpy.mockRestore();
  });

  test("does not upload invalid location samples", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler({
      latitude: 999,
      longitude: 121.4737
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).not.toHaveBeenCalled();
  });

  test("throttles location uploads within the minimum interval", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler(validLocation());

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(1);

    jest.setSystemTime(
      new Date("2026-10-01T12:00:05.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2305
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(1);

    jest.setSystemTime(
      new Date("2026-10-01T12:00:15.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2306
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(2);
  });

  test("does not start another upload while one is still in flight", async () => {
    let resolveUpload;

    callCloudFunction.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveUpload = resolve;
        })
    );

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler(validLocation());

    await Promise.resolve();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:20.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2306
      })
    );

    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(1);

    resolveUpload({
      success: true
    });

    await Promise.resolve();
    await Promise.resolve();
  });

  test("upload failure does not stop the tracking session", async () => {
    const warnSpy =
      jest.spyOn(console, "warn")
        .mockImplementation(() => {});

    callCloudFunction.mockRejectedValueOnce(
      Object.assign(
        new Error("upload failed"),
        {
          code: "TRACK_UPLOAD_FAILED"
        }
      )
    );

    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    handler(validLocation());

    await Promise.resolve();
    await Promise.resolve();

    expect(
      walkingTracker.isTracking()
    ).toBe(true);

    expect(
      storage.activeWalkTracking
    ).toBeTruthy();

    expect(
      console.warn
    ).toHaveBeenCalledWith(
      "[Walking Tracker] Location upload failed.",
      {
        code: "TRACK_UPLOAD_FAILED"
      }
    );

    warnSpy.mockRestore();
  });

  test("stops location updates, removes the listener, and clears storage", async () => {
    await walkingTracker.startTracking({
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    const handler =
      wx.onLocationChange.mock.calls[0][0];

    const stoppedSession =
      await walkingTracker.stopTracking();

    expect(
      wx.offLocationChange
    ).toHaveBeenCalledWith(handler);

    expect(
      wx.stopLocationUpdate
    ).toHaveBeenCalledTimes(1);

    expect(
      storage.activeWalkTracking
    ).toBeUndefined();

    expect(stoppedSession).toEqual({
      version: 1,
      status: "active",
      routeId: TEST_ROUTE_ID,
      startTimeMs: TEST_START_TIME_MS
    });

    expect(
      walkingTracker.isTracking()
    ).toBe(false);
  });

  test("stopTracking is safe when no session exists", async () => {
    await expect(
      walkingTracker.stopTracking()
    ).resolves.toBeNull();

    expect(
      wx.stopLocationUpdate
    ).toHaveBeenCalledTimes(1);

    expect(
      wx.offLocationChange
    ).not.toHaveBeenCalled();
  });

  test("searchTrace calls the track provider with a valid time range", async () => {
    const startTimeMs =
      TEST_START_TIME_MS;

    const endTimeMs =
      TEST_START_TIME_MS + 30 * 60 * 1000;

    callCloudFunction.mockResolvedValueOnce({
      success: true,
      trace: {
        points: [],
        mileageMeters: 0
      }
    });

    const result =
      await walkingTracker.searchTrace({
        startTimeMs,
        endTimeMs
      });

    expect(
      callCloudFunction
    ).toHaveBeenCalledWith(
      "trackProvider",
      {
        action: "searchTrace",
        startTimeMs,
        endTimeMs
      },
      {
        fallbackCode: "TRACK_SEARCH_FAILED",
        fallbackMessage:
          "Unable to query walking trajectory."
      }
    );

    expect(result).toEqual({
      success: true,
      trace: {
        points: [],
        mileageMeters: 0
      }
    });
  });

  test("searchTrace rejects an invalid time range", async () => {
    await expect(
      walkingTracker.searchTrace({
        startTimeMs: TEST_START_TIME_MS,
        endTimeMs: TEST_START_TIME_MS
      })
    ).rejects.toMatchObject({
      code: "INVALID_TRACKING_SESSION"
    });

    expect(
      callCloudFunction
    ).not.toHaveBeenCalled();
  });
});