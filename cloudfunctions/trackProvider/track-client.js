const {
  buildSignedGetUrl,
  buildSignedPostUrl
} = require("./signing");

const PATHS = {
  entityCreate: "/tracks/entity/create",
  traceUpload: "/tracks/trace/upload",
  traceSearch: "/tracks/trace/search"
};

const REQUEST_TIMEOUT_MS = 8000;
const MAX_SEARCH_PAGES = 20;

class TrackProviderError extends Error {
  constructor(
    code,
    message,
    {
      providerStatus = null,
      requestId = null,
      originalError = null
    } = {}
  ) {
    super(message);
    this.code = code;
    this.providerStatus = providerStatus;
    this.requestId = requestId;

    if (originalError) {
      this.originalError = originalError;
    }
  }
}

function providerStatus(data) {
  if (!data || data.status === null || data.status === undefined || data.status === "") return null;
  const value = Number(data.status);
  return Number.isFinite(value) ? value : null;
}

function isProviderSuccess(data) {
  return providerStatus(data) === 0;
}

function providerRequestId(data) {
  return data && typeof data.request_id === "string"
    ? data.request_id
    : null;
}

function providerMessage(data) {
  return data && typeof data.message === "string"
    ? data.message
    : "";
}

function looksLikeDuplicateEntity(data) {
  const message = providerMessage(data).toLowerCase();

  return (
    /already\s*exist/.test(message) ||
    /duplicate/.test(message) ||
    /已存在/.test(message) ||
    /重复/.test(message)
  );
}

function providerFailure(
  data,
  fallbackCode = "TRACK_PROVIDER_REJECTED"
) {
  return new TrackProviderError(
    fallbackCode,
    "Tencent Track Cloud rejected the request.",
    {
      providerStatus: providerStatus(data),
      requestId: providerRequestId(data)
    }
  );
}

function transportFailure(error) {
  const data = error && error.response && error.response.data;

  if (data && typeof data === "object") {
    return new TrackProviderError(
      "TRACK_PROVIDER_REJECTED",
      "Tencent Track Cloud rejected the request.",
      {
        providerStatus: providerStatus(data),
        requestId: providerRequestId(data)
      }
    );
  }

  return new TrackProviderError(
    "TRACK_PROVIDER_UNAVAILABLE",
    "Tencent Track Cloud is temporarily unavailable.",
    { originalError: error }
  );
}

function createTrackClient({
  config,
  http,
  timeoutMs = REQUEST_TIMEOUT_MS
}) {
  if (!config || typeof config !== "object") {
    throw new Error("Track provider config is required.");
  }

  if (
    !http ||
    typeof http.get !== "function" ||
    typeof http.post !== "function"
  ) {
    throw new Error("Track provider HTTP client is required.");
  }

  async function post(path, body) {
    const url = buildSignedPostUrl({
      baseUrl: config.baseUrl,
      path,
      body,
      secretKey: config.secretKey
    });

    try {
      const response = await http.post(url, body, {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: timeoutMs
      });

      return response && response.data;
    } catch (error) {
      throw transportFailure(error);
    }
  }

  async function get(path, params) {
    const url = buildSignedGetUrl({
      baseUrl: config.baseUrl,
      path,
      params,
      secretKey: config.secretKey
    });

    try {
      const response = await http.get(url, {
        timeout: timeoutMs
      });

      return response && response.data;
    } catch (error) {
      throw transportFailure(error);
    }
  }

  async function ensureEntity(entityId) {
    const body = {
      key: config.apiKey,
      service_id: config.serviceId,
      entity_id: entityId,
      entity_name: entityId
    };

    const data = await post(PATHS.entityCreate, body);

    if (isProviderSuccess(data)) {
      return {
        created: true,
        entityId
      };
    }

    if (looksLikeDuplicateEntity(data)) {
      return {
        created: false,
        entityId
      };
    }

    throw providerFailure(data, "TRACK_ENTITY_FAILED");
  }

  async function uploadTrace(entityId, points) {
    const body = {
      key: config.apiKey,
      service_id: config.serviceId,
      entity_id: entityId,
      coord_type: 5,
      data: points
    };

    const data = await post(PATHS.traceUpload, body);

    if (!isProviderSuccess(data)) {
      throw providerFailure(data, "TRACK_UPLOAD_FAILED");
    }

    const result =
      data && data.result && typeof data.result === "object"
        ? data.result
        : {};

    const uploadedCount = Number(result.count);
    const failures = Array.isArray(result.failure)
      ? result.failure
      : [];

    if (
      !Number.isFinite(uploadedCount) ||
      uploadedCount < points.length ||
      failures.length > 0
    ) {
      throw new TrackProviderError(
        "TRACK_UPLOAD_REJECTED",
        "Tencent Track Cloud rejected one or more trajectory points.",
        {
          providerStatus: providerStatus(data),
          requestId: providerRequestId(data)
        }
      );
    }

    return {
      uploadedCount
    };
  }

  async function searchTrace(
    entityId,
    startTimeSeconds,
    endTimeSeconds
  ) {
    const points = [];
    let mileageMeters = 0;
    let durationSeconds = 0;
    let pageNext = null;
    let pageCount = 0;
    const seenPageTokens = new Set();

    do {
      if (pageCount >= MAX_SEARCH_PAGES) {
        throw new TrackProviderError(
          "TRACK_SEARCH_TOO_LARGE",
          "Tencent Track Cloud returned too many trajectory pages."
        );
      }

      const params = {
        key: config.apiKey,
        service_id: config.serviceId,
        entity_id: entityId,
        start_time: startTimeSeconds,
        end_time: endTimeSeconds,
        get_fields: 1,

        // Tencent currently documents driving as the only optimized mode.
        // Keep walking History faithful to the user's raw GPS samples.
        optimize: 0
      };

      if (pageNext !== null && pageNext !== "") {
        params.page_next = pageNext;
      }

      const data = await get(PATHS.traceSearch, params);

      if (!isProviderSuccess(data)) {
        throw providerFailure(data, "TRACK_SEARCH_FAILED");
      }

      const result =
        data && data.result && typeof data.result === "object"
          ? data.result
          : {};

      if (Array.isArray(result.track)) {
        points.push(...result.track);
      }

      const distance = Number(result.distance);
      const duration = Number(result.duration);

      if (Number.isFinite(distance) && distance >= 0) {
        mileageMeters = Math.max(mileageMeters, distance);
      }

      if (Number.isFinite(duration) && duration >= 0) {
        durationSeconds = Math.max(durationSeconds, duration);
      }

      pageNext = result.page_next;
      pageCount += 1;

      if (
        pageNext !== null &&
        pageNext !== undefined &&
        pageNext !== ""
      ) {
        const token = String(pageNext);

        if (seenPageTokens.has(token)) {
          throw new TrackProviderError(
            "TRACK_SEARCH_PAGINATION_FAILED",
            "Tencent Track Cloud returned a repeated pagination token."
          );
        }

        seenPageTokens.add(token);
      }
    } while (
      pageNext !== null &&
      pageNext !== undefined &&
      pageNext !== ""
    );

    return {
      points,
      mileageMeters,
      durationSeconds
    };
  }

  return {
    ensureEntity,
    uploadTrace,
    searchTrace
  };
}

module.exports = {
  PATHS,
  REQUEST_TIMEOUT_MS,
  MAX_SEARCH_PAGES,
  TrackProviderError,
  createTrackClient
};
