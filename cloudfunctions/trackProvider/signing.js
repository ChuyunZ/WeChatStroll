const crypto = require("crypto");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function shortestJsonValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function canonicalizeParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Tencent signing params must be an object.");
  }

  return Object.keys(params)
    .filter(key => params[key] !== undefined)
    .sort()
    .map(key => `${key}=${shortestJsonValue(params[key])}`)
    .join("&");
}

function createSignature(path, params, secretKey) {
  if (!isNonEmptyString(path) || !path.startsWith("/")) {
    throw new Error("Tencent signing path must start with '/'.");
  }

  if (!isNonEmptyString(secretKey)) {
    throw new Error("Tencent signing secret must be a non-empty string.");
  }

  const canonical = canonicalizeParams(params);
  const payload = `${path}?${canonical}${secretKey}`;

  return crypto
    .createHash("md5")
    .update(payload, "utf8")
    .digest("hex");
}

function encodeQuery(params) {
  return Object.keys(params)
    .filter(key => params[key] !== undefined)
    .sort()
    .map(
      key =>
        `${encodeURIComponent(key)}=${encodeURIComponent(
          String(params[key])
        )}`
    )
    .join("&");
}

function buildSignedGetUrl({ baseUrl, path, params, secretKey }) {
  if (!isNonEmptyString(baseUrl)) {
    throw new Error("Tencent base URL must be a non-empty string.");
  }

  const sig = createSignature(path, params, secretKey);
  const query = encodeQuery(params);

  return `${baseUrl}${path}?${query}&sig=${sig}`;
}

function buildSignedPostUrl({ baseUrl, path, body, secretKey }) {
  if (!isNonEmptyString(baseUrl)) {
    throw new Error("Tencent base URL must be a non-empty string.");
  }

  const sig = createSignature(path, body, secretKey);
  return `${baseUrl}${path}?sig=${sig}`;
}

module.exports = {
  canonicalizeParams,
  createSignature,
  buildSignedGetUrl,
  buildSignedPostUrl
};
