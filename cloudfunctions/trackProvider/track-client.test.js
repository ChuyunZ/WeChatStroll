const {
  createTrackClient,
  PATHS
} = require("./track-client");

const config = {
  apiKey: "test-key",
  secretKey: "test-secret",
  serviceId: "test-service",
  baseUrl: "https://apis.map.qq.com"
};

function createHttp() {
  return {
    get: jest.fn(),
    post: jest.fn()
  };
}

describe("Tencent Track Cloud client", () => {
  test("creates an opaque entity through the signed create endpoint", async () => {
    const http = createHttp();
    http.post.mockResolvedValue({
      data: {
        status: 0,
        message: "OK",
        request_id: "req-create",
        result: {
          entity_id: "usr_abc"
        }
      }
    });

    const client = createTrackClient({ config, http });
    const result = await client.ensureEntity("usr_abc");

    expect(result).toEqual({
      created: true,
      entityId: "usr_abc"
    });

    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = http.post.mock.calls[0];

    expect(url).toContain(PATHS.entityCreate);
    expect(url).toContain("?sig=");
    expect(url).not.toContain("test-secret");
    expect(body).toEqual({
      key: "test-key",
      service_id: "test-service",
      entity_id: "usr_abc",
      entity_name: "usr_abc"
    });
    expect(options.headers["Content-Type"]).toBe(
      "application/json"
    );
  });

  test("treats an already-existing entity as idempotent", async () => {
    const http = createHttp();
    http.post.mockResolvedValue({
      data: {
        status: 1,
        message: "entity_id 已存在",
        request_id: "req-existing"
      }
    });

    const client = createTrackClient({ config, http });

    await expect(
      client.ensureEntity("usr_abc")
    ).resolves.toEqual({
      created: false,
      entityId: "usr_abc"
    });
  });

  test("uploads GCJ-02 points in Tencent Track Cloud format", async () => {
    const http = createHttp();
    http.post.mockResolvedValue({
      data: {
        status: 0,
        message: "OK",
        result: {
          count: 1,
          failure: []
        }
      }
    });

    const client = createTrackClient({ config, http });
    const point = {
      lat: 31.2304,
      lng: 121.4737,
      loctime: 1760000000,
      speed: 1.2,
      direction: 90,
      altitude: 5,
      accuracy: 8
    };

    await expect(
      client.uploadTrace("usr_abc", [point])
    ).resolves.toEqual({ uploadedCount: 1 });

    const [url, body] = http.post.mock.calls[0];
    expect(url).toContain(PATHS.traceUpload);
    expect(body).toEqual({
      key: "test-key",
      service_id: "test-service",
      entity_id: "usr_abc",
      coord_type: 5,
      data: [point]
    });
  });

  test("rejects provider-level per-point upload failures", async () => {
    const http = createHttp();
    http.post.mockResolvedValue({
      data: {
        status: 0,
        message: "OK",
        request_id: "req-upload",
        result: {
          count: 0,
          failure: [
            {
              idx: 0,
              message: "invalid point"
            }
          ]
        }
      }
    });

    const client = createTrackClient({ config, http });

    await expect(
      client.uploadTrace("usr_abc", [
        {
          lat: 31.2,
          lng: 121.4,
          loctime: 1760000000,
          speed: 0,
          direction: 0,
          altitude: 1,
          accuracy: 10
        }
      ])
    ).rejects.toMatchObject({
      code: "TRACK_UPLOAD_REJECTED",
      requestId: "req-upload"
    });
  });

  test("queries raw walking trajectory and follows bounded pagination", async () => {
    const http = createHttp();

    http.get
      .mockResolvedValueOnce({
        data: {
          status: 0,
          result: {
            distance: 120,
            duration: 90,
            page_next: "next-token",
            track: [
              {
                lat: 31.2304,
                lng: 121.4737,
                loctime: 1760000000
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          status: 0,
          result: {
            distance: 240,
            duration: 180,
            page_next: "",
            track: [
              {
                lat: 31.2305,
                lng: 121.4738,
                loctime: 1760000015
              }
            ]
          }
        }
      });

    const client = createTrackClient({ config, http });
    const result = await client.searchTrace(
      "usr_abc",
      1760000000,
      1760001800
    );

    expect(result).toEqual({
      points: [
        {
          lat: 31.2304,
          lng: 121.4737,
          loctime: 1760000000
        },
        {
          lat: 31.2305,
          lng: 121.4738,
          loctime: 1760000015
        }
      ],
      mileageMeters: 240,
      durationSeconds: 180
    });

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.get.mock.calls[0][0]).toContain("optimize=0");
    expect(http.get.mock.calls[0][0]).not.toContain(
      "test-secret"
    );
    expect(http.get.mock.calls[1][0]).toContain(
      "page_next=next-token"
    );
  });

  test("sanitizes transport failures", async () => {
    const http = createHttp();
    http.get.mockRejectedValue(
      new Error("socket exploded with request URL")
    );

    const client = createTrackClient({ config, http });

    await expect(
      client.searchTrace("usr_abc", 100, 200)
    ).rejects.toMatchObject({
      code: "TRACK_PROVIDER_UNAVAILABLE",
      message:
        "Tencent Track Cloud is temporarily unavailable."
    });
  });
});
