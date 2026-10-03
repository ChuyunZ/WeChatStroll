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

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
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

  test("removes an invalid stored tracking session", async () => {
    storage.activeWalkTracking = {
      version: 99,
      status: "active"
    };

    expect(
      walkingTracker.getTrackingSession()
    ).toBeNull();

    await settle();
    expect(
      wx.removeStorageSync
    ).toHaveBeenCalledWith(
      "activeWalkTracking"
    );
  });

  test("removes a stored tracking session older than 12 hours", async () => {
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

    await settle();
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

    await settle();

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

    await settle();

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

    await settle();

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

    await settle();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:15.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2309
      })
    );

    await settle();

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

    await settle();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:15.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2305
      })
    );

    await settle();

    jest.setSystemTime(
      new Date("2026-10-01T12:00:30.000Z")
    );

    handler(
      validLocation({
        latitude: 31.2306
      })
    );

    await settle();

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

    await settle();

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

    await settle();

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

    await settle();

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

    await settle();

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

    await settle();
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

    await settle();

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

  test("searchTrace retries retryable empty results with backoff", async () => {
    const startTimeMs =
      TEST_START_TIME_MS;

    const endTimeMs =
      TEST_START_TIME_MS + 30 * 60 * 1000;

    const emptyResult = {
      success: true,
      trace: {
        points: [],
        mileageMeters: 0,
        durationSeconds: 0,
        available: false,
        retryable: true,
        partial: false
      }
    };

    const availableResult = {
      success: true,
      trace: {
        points: [
          {
            latitude: 31.2304,
            longitude: 121.4737,
            timestampMs: TEST_START_TIME_MS
          }
        ],
        mileageMeters: 0,
        durationSeconds: 1,
        available: true,
        retryable: false,
        partial: false
      }
    };

    callCloudFunction
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce(availableResult);

    const resultPromise =
      walkingTracker.searchTrace({
        startTimeMs,
        endTimeMs
      });

    await Promise.resolve();

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(500);

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual(
      availableResult
    );

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(3);
  });

  test("searchTrace stops after the retry budget when results stay empty", async () => {
    const startTimeMs =
      TEST_START_TIME_MS;

    const endTimeMs =
      TEST_START_TIME_MS + 30 * 60 * 1000;

    const emptyResult = {
      success: true,
      trace: {
        points: [],
        mileageMeters: 0,
        durationSeconds: 0,
        available: false,
        retryable: true,
        partial: false
      }
    };

    callCloudFunction.mockResolvedValue(
      emptyResult
    );

    const resultPromise =
      walkingTracker.searchTrace({
        startTimeMs,
        endTimeMs
      });

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual(
      emptyResult
    );

    expect(
      callCloudFunction
    ).toHaveBeenCalledTimes(3);
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
describe("tracking lifecycle regressions", () => {
  const start = () => walkingTracker.startTracking({
    routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS
  });
  const callback = () => wx.onLocationChange.mock.calls[0][0];

  test("expires at exactly 12 hours without needing a callback", async () => {
    await start();
    const handler = callback();
    await jest.advanceTimersByTimeAsync(TEST_START_TIME_MS + walkingTracker.MAX_TRACKING_SESSION_AGE_MS - Date.now());
    handler(validLocation());
    await settle();
    expect(callCloudFunction).not.toHaveBeenCalled();
    expect(wx.offLocationChange).toHaveBeenCalledTimes(1);
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkTracking).toBeUndefined();
    expect(walkingTracker.isTracking()).toBe(false);
    await walkingTracker.startTracking({ routeId: "next-walk", startTimeMs: Date.now() });
    expect(walkingTracker.isTracking()).toBe(true);
  });

  test("callback enforces expiry even if the timer has not run", async () => {
    await start();
    jest.setSystemTime(TEST_START_TIME_MS + walkingTracker.MAX_TRACKING_SESSION_AGE_MS);
    callback()(validLocation());
    callback()(validLocation());
    await settle();
    expect(callCloudFunction).not.toHaveBeenCalled();
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
  });

  test("stale active-walk removal stops the matching live tracker", async () => {
    await start();
    storage.activeWalkSession = {
      version: 1, status: "active", routeId: TEST_ROUTE_ID,
      route: { routeId: TEST_ROUTE_ID }, startTimeMs: TEST_START_TIME_MS
    };
    jest.setSystemTime(TEST_START_TIME_MS + walkingTracker.MAX_TRACKING_SESSION_AGE_MS);
    const service = require("../miniprogram/services/active-walk-session");
    expect(service.getActiveWalkSession()).toBeNull();
    callback()(validLocation());
    await settle();
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
    expect(callCloudFunction).not.toHaveBeenCalled();
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test("stop failure retains a recoverable marker and blocks uploads until retry", async () => {
    await start();
    const handler = callback();
    wx.stopLocationUpdate.mockImplementationOnce(({ fail }) => fail({ errMsg: "failed" }));
    await expect(walkingTracker.stopTracking()).rejects.toMatchObject({ code: "BACKGROUND_LOCATION_FAILED" });
    expect(storage.activeWalkTracking.status).toBe("stopPending");
    expect(walkingTracker.isTracking()).toBe(false);
    handler(validLocation());
    await settle();
    expect(callCloudFunction).not.toHaveBeenCalled();
    await walkingTracker.stopTracking();
    expect(storage.activeWalkTracking).toBeUndefined();
    expect(wx.offLocationChange).toHaveBeenCalledTimes(1);
    expect(wx.onLocationChange).toHaveBeenCalledTimes(1);
  });

  test("concurrent stops share one platform operation and retain state until success", async () => {
    await start();
    let finish;
    wx.stopLocationUpdate.mockImplementation(({ success }) => { finish = success; });
    const first = walkingTracker.stopTracking();
    const second = walkingTracker.stopTracking();
    expect(first).toBe(second);
    expect(storage.activeWalkTracking.status).toBe("stopPending");
    finish();
    await first;
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test("reloaded stopPending state is cleaned, never resumed as tracking", async () => {
    storage.activeWalkTracking = { version: 1, status: "stopPending", routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS };
    expect(await walkingTracker.resumeTracking()).toBeNull();
    await settle();
    expect(wx.startLocationUpdateBackground).not.toHaveBeenCalled();
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test.each([false, true])("retry loss=%s persists the correct quality", async lost => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    callCloudFunction.mockRejectedValueOnce(new Error("upload"));
    if (lost) callCloudFunction.mockRejectedValueOnce(new Error("retry"));
    await start();
    callback()(validLocation());
    await settle();
    expect(storage.activeWalkTracking.trajectoryPartial).not.toBe(true);
    jest.setSystemTime(Date.now() + 15000);
    callback()(validLocation());
    await settle();
    expect(Boolean(storage.activeWalkTracking.trajectoryPartial)).toBe(lost);
    wx.getLocation = jest.fn(({ success }) => success(validLocation()));
    expect(await walkingTracker.finalizeTracking()).toEqual({ trajectoryPartial: lost });
  });

  test("final sample bypasses throttle, preserves timestamp, and is idempotent", async () => {
    await start();
    callback()(validLocation());
    await settle();
    const timestampMs = Date.now() + 1000;
    jest.setSystemTime(timestampMs);
    wx.getLocation = jest.fn(({ success }) => success(validLocation({ timestampMs })));
    const first = walkingTracker.finalizeTracking();
    expect(walkingTracker.finalizeTracking()).toBe(first);
    expect(await first).toEqual({ trajectoryPartial: false });
    expect(wx.getLocation).toHaveBeenCalledTimes(1);
    expect(callCloudFunction).toHaveBeenCalledTimes(2);
    expect(callCloudFunction.mock.calls[1][1].point.timestampMs).toBe(timestampMs);
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
  });

  test("final flush retries buffered point before obtaining fresh sample", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await start();
    callCloudFunction.mockRejectedValueOnce(new Error("first"));
    callback()(validLocation({ latitude: 31.1 }));
    await settle();
    wx.getLocation = jest.fn(({ success }) => {
      expect(callCloudFunction).toHaveBeenCalledTimes(2);
      success(validLocation({ latitude: 31.2 }));
    });
    expect(await walkingTracker.finalizeTracking()).toEqual({ trajectoryPartial: false });
    expect(callCloudFunction.mock.calls.map(call => call[1].point.latitude)).toEqual([31.1, 31.1, 31.2]);
  });

  test("final sample upload failure is partial and still stops", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await start();
    wx.getLocation = jest.fn(({ success }) => success(validLocation()));
    callCloudFunction.mockRejectedValueOnce(new Error("final"));
    expect(await walkingTracker.finalizeTracking()).toEqual({ trajectoryPartial: true });
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test("hung final location has a bounded deadline and late callback cannot upload", async () => {
    await start();
    let late;
    wx.getLocation = jest.fn(({ success }) => { late = success; });
    const final = walkingTracker.finalizeTracking();
    await jest.advanceTimersByTimeAsync(5000);
    expect(await final).toEqual({ trajectoryPartial: true });
    late(validLocation());
    await settle();
    expect(callCloudFunction).not.toHaveBeenCalled();
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test("hung platform stop is bounded and leaves retry state", async () => {
    await start();
    wx.stopLocationUpdate.mockImplementation(() => {});
    const stop = walkingTracker.stopTracking();
    const assertion = expect(stop).rejects.toMatchObject({ code: "TRACK_OPERATION_TIMEOUT" });
    await jest.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(storage.activeWalkTracking.status).toBe("stopPending");
  });

  test("parallel same-session starts register exactly one listener", async () => {
    await Promise.all([start(), start()]);
    expect(wx.startLocationUpdateBackground).toHaveBeenCalledTimes(1);
    expect(wx.onLocationChange).toHaveBeenCalledTimes(1);
  });

  test("late initial sample and failed old upload cannot contaminate a new walk", async () => {
    let initial, rejectUpload;
    wx.getLocation = jest.fn(({ success }) => { initial = success; });
    await start();
    const oldInitial = initial;
    const oldHandler = callback();
    callCloudFunction.mockImplementationOnce(() => new Promise((_, reject) => { rejectUpload = reject; }));
    oldHandler(validLocation());
    await walkingTracker.stopTracking();
    await walkingTracker.startTracking({ routeId: "new-walk", startTimeMs: Date.now() });
    oldInitial(validLocation());
    oldHandler(validLocation());
    rejectUpload(new Error("late failure"));
    await settle();
    expect(callCloudFunction).toHaveBeenCalledTimes(1);
    expect(storage.activeWalkTracking.routeId).toBe("new-walk");
    expect(storage.activeWalkTracking.pendingPoint).toBeUndefined();
    expect(storage.activeWalkTracking.trajectoryPartial).toBeUndefined();
  });

  test("Finish during a pending platform start stops a late successful start", async () => {
    let started;
    wx.startLocationUpdateBackground.mockImplementation(({ success }) => { started = success; });
    const starting = start();
    await settle();
    const final = walkingTracker.finalizeTracking();
    await jest.advanceTimersByTimeAsync(3000);
    expect(await final).toEqual({ trajectoryPartial: true });
    started();
    await starting;
    expect(wx.onLocationChange).not.toHaveBeenCalled();
    expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(2);
    expect(storage.activeWalkTracking).toBeUndefined();
  });

  test("lost in-memory buffer after process restart remains partial without storing geometry", async () => {
    storage.activeWalkTracking = { version: 1, status: "active", routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS, pendingPoint: true };
    await walkingTracker.resumeTracking();
    expect(storage.activeWalkTracking.trajectoryPartial).toBe(true);
    expect(JSON.stringify(storage.activeWalkTracking)).not.toMatch(/latitude|longitude/);
  });

  test("search sends completed-walk quality independently of query retryability", async () => {
    await walkingTracker.searchTrace({ startTimeMs: TEST_START_TIME_MS, endTimeMs: Date.now(), trajectoryPartial: true });
    expect(callCloudFunction.mock.calls[0][1].trajectoryPartial).toBe(true);
  });
});

test("finalizing a different walk neither stops nor reuses quality from the current walk", async () => {
  await walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  expect(walkingTracker.isTracking({ routeId: "other", startTimeMs: TEST_START_TIME_MS })).toBe(false);
  expect(await walkingTracker.finalizeTracking({ routeId: "other", startTimeMs: TEST_START_TIME_MS })).toEqual({ trajectoryPartial: true });
  expect(wx.stopLocationUpdate).not.toHaveBeenCalled();
  expect(walkingTracker.isTracking()).toBe(true);
});

test("storage failure while stopping cannot prevent platform cleanup", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  await walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  wx.setStorageSync.mockImplementation(() => { throw new Error("storage full"); });
  await walkingTracker.stopTracking();
  expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
  expect(walkingTracker.isTracking()).toBe(false);
});

test("expiry retries a failed platform stop without accepting samples", async () => {
  await walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  wx.stopLocationUpdate.mockImplementationOnce(({ fail }) => fail({ errMsg: "temporary" }));
  await jest.advanceTimersByTimeAsync(TEST_START_TIME_MS + walkingTracker.MAX_TRACKING_SESSION_AGE_MS - Date.now());
  expect(storage.activeWalkTracking.status).toBe("stopPending");
  wx.onLocationChange.mock.calls[0][0](validLocation());
  expect(callCloudFunction).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(30000);
  expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(2);
  expect(storage.activeWalkTracking).toBeUndefined();
});

test("old finalization cannot stop a replacement session", async () => {
  await walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  wx.getLocation = jest.fn(() => {});
  const final = walkingTracker.finalizeTracking();
  await walkingTracker.stopTracking();
  await walkingTracker.startTracking({ routeId: "replacement", startTimeMs: Date.now() });
  await jest.advanceTimersByTimeAsync(5000);
  await final;
  expect(wx.stopLocationUpdate).toHaveBeenCalledTimes(1);
  expect(storage.activeWalkTracking.routeId).toBe("replacement");
  expect(walkingTracker.isTracking()).toBe(true);
});

test("permission granted after Finish cannot start background tracking", async () => {
  let granted;
  wx.getSetting.mockImplementation(({ success }) => success({ authSetting: {} }));
  wx.authorize.mockImplementation(({ success }) => { granted = success; });
  const start = walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  const rejected = expect(start).rejects.toMatchObject({ code: "INVALID_TRACKING_SESSION" });
  await settle();
  const final = walkingTracker.finalizeTracking();
  await jest.advanceTimersByTimeAsync(3000);
  await final;
  granted();
  await rejected;
  expect(wx.startLocationUpdateBackground).not.toHaveBeenCalled();
  expect(wx.onLocationChange).not.toHaveBeenCalled();
});

test("late initial location cannot hide an in-flight upload from final flush", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  let initial, failUpload;
  wx.getLocation = jest.fn(({ success }) => { initial = success; });
  await walkingTracker.startTracking({ routeId: TEST_ROUTE_ID, startTimeMs: TEST_START_TIME_MS });
  callCloudFunction.mockImplementationOnce(() => new Promise((_, reject) => { failUpload = reject; }));
  wx.onLocationChange.mock.calls[0][0](validLocation({ latitude: 31.1 }));
  initial(validLocation({ latitude: 31.2 }));
  wx.getLocation.mockImplementation(({ success }) => success(validLocation({ latitude: 31.3 })));
  const final = walkingTracker.finalizeTracking();
  await settle();
  expect(callCloudFunction).toHaveBeenCalledTimes(1);
  failUpload(new Error("first attempt"));
  expect(await final).toEqual({ trajectoryPartial: false });
  expect(callCloudFunction.mock.calls.map(call => call[1].point.latitude)).toEqual([31.1, 31.1, 31.3]);
});
