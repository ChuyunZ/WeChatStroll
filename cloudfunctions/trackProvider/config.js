function requiredString(env, name) {
  const value = env[name];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required track provider configuration: ${name}`
    );
  }

  return value.trim();
}

function loadConfig(env = process.env) {
  return {
    apiKey: requiredString(env, "TENCENT_LBS_KEY"),
    secretKey: requiredString(env, "TENCENT_LBS_SK"),
    serviceId: requiredString(env, "TENCENT_TRACK_SERVICE_ID"),
    entitySecret: requiredString(
      env,
      "TENCENT_TRACK_ENTITY_SECRET"
    ),
    baseUrl: "https://apis.map.qq.com"
  };
}

module.exports = {
  loadConfig
};