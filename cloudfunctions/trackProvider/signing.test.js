const {
  canonicalizeParams,
  createSignature,
  buildSignedGetUrl,
  buildSignedPostUrl
} = require("./signing");

describe("Tencent WebService signing", () => {
  test("sorts top-level params and uses shortest JSON for nested values", () => {
    expect(
      canonicalizeParams({
        service_id: "svc",
        data: [{ lng: 121.4, lat: 31.2 }],
        key: "test-key"
      })
    ).toBe(
      'data=[{"lng":121.4,"lat":31.2}]&key=test-key&service_id=svc'
    );
  });

  test("creates the expected lowercase md5 signature", () => {
    expect(
      createSignature(
        "/tracks/trace/search",
        {
          key: "test-key",
          service_id: "svc-1",
          entity_id: "usr_abc",
          start_time: 100,
          end_time: 200,
          get_fields: 1,
          optimize: 0
        },
        "secret"
      )
    ).toBe("eedb8dd60800def5cdb1d46192f6a99b");
  });

  test("builds a signed GET URL without exposing the secret", () => {
    const url = buildSignedGetUrl({
      baseUrl: "https://apis.map.qq.com",
      path: "/tracks/trace/search",
      params: {
        key: "test-key",
        entity_id: "usr_abc",
        service_id: "svc-1",
        start_time: 100,
        end_time: 200
      },
      secretKey: "super-secret"
    });

    expect(url).toContain(
      "https://apis.map.qq.com/tracks/trace/search?"
    );
    expect(url).toContain("entity_id=usr_abc");
    expect(url).toContain("sig=");
    expect(url).not.toContain("super-secret");
  });

  test("POST signature is placed in the query while body remains unchanged", () => {
    const body = {
      key: "test-key",
      service_id: "svc-1",
      entity_id: "usr_abc",
      entity_name: "usr_abc"
    };

    const url = buildSignedPostUrl({
      baseUrl: "https://apis.map.qq.com",
      path: "/tracks/entity/create",
      body,
      secretKey: "super-secret"
    });

    expect(url).toMatch(
      /^https:\/\/apis\.map\.qq\.com\/tracks\/entity\/create\?sig=[a-f0-9]{32}$/
    );
    expect(body).toEqual({
      key: "test-key",
      service_id: "svc-1",
      entity_id: "usr_abc",
      entity_name: "usr_abc"
    });
  });
});
