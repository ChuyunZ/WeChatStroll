const { loadConfig } = require("./config");

describe("trackProvider configuration", () => {
  const validEnv = {
    TENCENT_LBS_KEY: "test-key",
    TENCENT_LBS_SK: "test-secret",
    TENCENT_TRACK_SERVICE_ID: "test-service",
    TENCENT_TRACK_ENTITY_SECRET: "test-entity-secret"
  };

  test("loads required Tencent Track Cloud configuration", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      apiKey: "test-key",
      secretKey: "test-secret",
      serviceId: "test-service",
      entitySecret: "test-entity-secret",
      baseUrl: "https://apis.map.qq.com"
    });
  });

  test.each([
    "TENCENT_LBS_KEY",
    "TENCENT_LBS_SK",
    "TENCENT_TRACK_SERVICE_ID",
    "TENCENT_TRACK_ENTITY_SECRET"
  ])("rejects missing %s", missingName => {
    const env = {
      ...validEnv
    };

    delete env[missingName];

    expect(() => loadConfig(env)).toThrow(
      `Missing required track provider configuration: ${missingName}`
    );
  });

  test("trims configuration values", () => {
    const config = loadConfig({
      TENCENT_LBS_KEY: "  test-key  ",
      TENCENT_LBS_SK: "  test-secret  ",
      TENCENT_TRACK_SERVICE_ID: "  test-service  ",
      TENCENT_TRACK_ENTITY_SECRET: "  test-entity-secret  "
    });

    expect(config.apiKey).toBe("test-key");
    expect(config.secretKey).toBe("test-secret");
    expect(config.serviceId).toBe("test-service");
    expect(config.entitySecret).toBe("test-entity-secret");
  });
});