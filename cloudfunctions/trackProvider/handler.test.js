const {
  MAX_TRACE_QUERY_MS,
  normalizeUploadPoint,
  createTrackHandler: makeTrackHandler
} = require("./handler");
const { createEntityId } = require("./entity-id");
const { testWalk } = require('./test-walk');
const createTrackHandler = options => makeTrackHandler({
  historyLimiter: { reserve: jest.fn().mockResolvedValue() },
  walkStore: { getWalk: jest.fn().mockResolvedValue(testWalk({}, options.getOpenId())) }, ...options
});

const config = {
  entitySecret: "test-entity-secret"
};

function createClient() {
  return {
    ensureEntity: jest.fn().mockResolvedValue({
      created: true
    }),
    uploadTrace: jest.fn().mockResolvedValue({
      uploadedCount: 1
    }),
    searchTrace: jest.fn().mockResolvedValue({
      points: [],
      mileageMeters: 0,
      durationSeconds: 0
    })
  };
}

describe("trackProvider handler", () => {
  test("ensures an entity from authenticated OpenID without exposing OpenID", async () => {
    const client = createClient();
    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-sensitive"
    });

    await expect(
      handler({ action: "ensureEntity" })
    ).resolves.toEqual({
      success: true,
      tracking: {
        ready: true
      }
    });

    const entityId = createEntityId(
      "openid-sensitive",
      config.entitySecret
    );

    expect(client.ensureEntity).toHaveBeenCalledWith(entityId);
    expect(
      JSON.stringify(client.ensureEntity.mock.calls)
    ).not.toContain("openid-sensitive");
  });

  test("uses one server-owned entity per user across actions", async () => {
    const client = createClient();
    const ensuredEntityIds = new Set();
    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one",
      ensuredEntityIds
    });

    await handler({ action: "ensureEntity" });
    await handler({
      action: "uploadTrace",
      routeId: "route-1",
      walkStartTimeMs: 1760000000000,
      point: {
        latitude: 31.2304,
        longitude: 121.4737,
        timestampMs: 1760000000000,
        accuracy: 8,
        speed: 1.2,
        direction: 90,
        altitude: 5
      }
    });

    expect(client.ensureEntity).toHaveBeenCalledTimes(1);
    expect(client.uploadTrace).toHaveBeenCalledWith(
      expect.stringMatching(/^usr_[a-f0-9]{32}$/),
      [
        {
          lat: 31.2304,
          lng: 121.4737,
          loctime: 1760000000,
          speed: 1.2,
          direction: 90,
          altitude: 5,
          accuracy: 8
        }
      ]
    );
  });

  test("normalizes missing device metadata without changing coordinates", () => {
    expect(
      normalizeUploadPoint({
        latitude: 31.2304,
        longitude: 121.4737,
        timestampMs: 1760000000000
      })
    ).toEqual({
      lat: 31.2304,
      lng: 121.4737,
      loctime: 1760000000,
      speed: 0,
      direction: 0,
      altitude: 1,
      accuracy: 0
    });
  });

  test("rejects invalid coordinates before provider upload", async () => {
    const client = createClient();
    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one"
    });

    const result = await handler({
      action: "uploadTrace",
      routeId: "route-1",
      walkStartTimeMs: 1760000000000,
      point: {
        latitude: 999,
        longitude: 121.4,
        timestampMs: 1760000000000
      }
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: "INVALID_TRACK_POINT",
        message: "Invalid walking trajectory point."
      }
    });
    expect(client.uploadTrace).not.toHaveBeenCalled();
  });

  test("queries only the authenticated user's entity and normalizes output", async () => {
    const client = createClient();
    client.searchTrace.mockResolvedValueOnce({
      points: [
        {
          lat: 31.2304,
          lng: 121.4737,
          loctime: 1760000000,
          accuracy: 8,
          speed: 1.1,
          direction: 90,
          altitude: 5,
          type: 0,
          provider_only_field: "do not expose"
        }
      ],
      mileageMeters: 123.5,
      durationSeconds: 90
    });

    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one"
    });

    const result = await handler({
      action: "searchWalkTrace",
      walkId: 'walk-1'
    });

    expect(result).toEqual({
      success: true,
      trace: {
        points: [
          {
            latitude: 31.2304,
            longitude: 121.4737,
            timestampMs: 1760000000000,
            accuracy: 8,
            speed: 1.1,
            direction: 90,
            altitude: 5,
            type: 0
          }
        ],
        mileageMeters: 123.5,
        durationSeconds: 90,
        available: true,
        retryable: false,
        partial: false
      }
    });

    expect(client.searchTrace.mock.calls[0][0]).toMatch(
      /^usr_[a-f0-9]{32}$/
    );
    expect(client.searchTrace.mock.calls[0][0]).not.toBe(
      "attacker-controlled-id"
    );
  });

  test("rejects a future persisted search end instead of clamping authorization", async () => {
    const client = createClient();
    const nowMs = 1760001200000;

    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one",
      getNowMs: () => nowMs
    });

    const result = await handler({ action: 'searchWalkTrace', walkId: 'walk-1' });
    expect(result.error.code).toBe('INVALID_WALK_TRACE_METADATA');
    expect(client.searchTrace).not.toHaveBeenCalled();
    expect(client.ensureEntity).not.toHaveBeenCalled();
  });

  test("marks an empty successful search as retryable", async () => {
    const client = createClient();
    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one"
    });

    const result = await handler({
      action: "searchWalkTrace",
      walkId: 'walk-1'
    });

    expect(result).toEqual({
      success: true,
      trace: {
        points: [],
        mileageMeters: 0,
        durationSeconds: 0,
        available: false,
        retryable: true,
        partial: false
      }
    });
  });

  test("rejects search windows longer than 24 hours", async () => {
    const client = createClient();
    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one",
      walkStore: { getWalk: jest.fn().mockResolvedValue(testWalk({
        endTime: new Date(1760000000000 + MAX_TRACE_QUERY_MS + 1).toISOString(),
        trajectoryEndTimeMs: 1760000000000 + MAX_TRACE_QUERY_MS + 1 })) }
    });

    const result = await handler({
      action: "searchWalkTrace",
      walkId: 'walk-1'
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: "TRACK_RANGE_TOO_LARGE",
        message:
          "Walking trajectory queries cannot exceed 24 hours."
      }
    });
    expect(client.searchTrace).not.toHaveBeenCalled();
  });

  test("does not log raw coordinates or secrets on provider failure", async () => {
    const client = createClient();
    const log = jest.fn();
    client.uploadTrace.mockRejectedValueOnce(
      Object.assign(new Error("provider failed"), {
        code: "TRACK_UPLOAD_FAILED",
        providerStatus: 120,
        requestId: "req-123"
      })
    );

    const handler = createTrackHandler({
      config,
      client,
      getOpenId: () => "openid-one",
      log
    });

    const result = await handler({
      action: "uploadTrace",
      routeId: "route-1",
      walkStartTimeMs: 1760000000000,
      point: {
        latitude: 31.2304,
        longitude: 121.4737,
        timestampMs: 1760000000000
      }
    });

    expect(result.success).toBe(false);
    expect(log).toHaveBeenCalledWith({
      event: "request_failed",
      action: "uploadTrace",
      code: "TRACK_UPLOAD_FAILED",
      providerStatus: 120,
      requestId: "req-123"
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "31.2304"
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "openid-one"
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "test-entity-secret"
    );
  });
});

test.each([false, true])("search preserves known partial=%s independently of availability", async partial => {
  const client = createClient();
  client.searchTrace.mockResolvedValue({ points: [{ lat: 31, lng: 121, loctime: 100 }] });
  const handler = createTrackHandler({ config, client, getOpenId: () => "user", getNowMs: () => 200000,
    walkStore: { getWalk: jest.fn().mockResolvedValue(testWalk({ startTime: new Date(90000).toISOString(),
      endTime: new Date(110000).toISOString(), trajectoryEndTimeMs: 110000, trajectoryPartial: partial }, 'user')) } });
  const result = await handler({ action: "searchWalkTrace", walkId: 'walk-1' });
  expect(result.trace).toMatchObject({ available: true, retryable: false, partial });
});

test("discarded invalid provider points mark a trajectory partial", async () => {
  const client = createClient();
  client.searchTrace.mockResolvedValue({ points: [{ lat: 31, lng: 121, loctime: 100 }, { lat: 999, lng: 121, loctime: 101 }] });
  const handler = createTrackHandler({ config, client, getOpenId: () => "user", getNowMs: () => 200000,
    walkStore: { getWalk: jest.fn().mockResolvedValue(testWalk({ startTime: new Date(90000).toISOString(),
      endTime: new Date(110000).toISOString(), trajectoryEndTimeMs: 110000 }, 'user')) } });
  const result = await handler({ action: "searchWalkTrace", walkId: 'walk-1' });
  expect(result.trace).toMatchObject({ available: true, retryable: false, partial: true });
  expect(result.trace.points).toHaveLength(1);
});
