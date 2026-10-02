const { createEntityId } = require("./entity-id");

const MAX_TRACE_QUERY_MS = 24 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isValidLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeUploadPoint(point) {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    throw codedError(
      "INVALID_TRACK_POINT",
      "Invalid walking trajectory point."
    );
  }

  if (
    !isValidLatitude(point.latitude) ||
    !isValidLongitude(point.longitude)
  ) {
    throw codedError(
      "INVALID_TRACK_POINT",
      "Invalid walking trajectory coordinates."
    );
  }

  if (
    !Number.isFinite(point.timestampMs) ||
    point.timestampMs <= 0
  ) {
    throw codedError(
      "INVALID_TRACK_POINT",
      "Invalid walking trajectory timestamp."
    );
  }

  const speed =
    Number.isFinite(point.speed) && point.speed >= 0
      ? point.speed
      : 0;

  const direction =
    Number.isFinite(point.direction) &&
    point.direction >= 0 &&
    point.direction <= 360
      ? point.direction
      : 0;

  // Tencent Track Cloud requires altitude > 0. Coordinates remain the
  // device's real GCJ-02 sample; 1m is only a metadata fallback.
  const altitude =
    Number.isFinite(point.altitude) && point.altitude > 0
      ? point.altitude
      : 1;

  const accuracy =
    Number.isFinite(point.accuracy) && point.accuracy >= 0
      ? point.accuracy
      : 0;

  return {
    lat: point.latitude,
    lng: point.longitude,
    loctime: Math.floor(point.timestampMs / 1000),
    speed,
    direction,
    altitude,
    accuracy
  };
}

function normalizeSearchPoint(point) {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    return null;
  }

  const latitude = Number(point.lat);
  const longitude = Number(point.lng);
  const loctime = Number(point.loctime);

  if (
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude) ||
    !Number.isFinite(loctime) ||
    loctime <= 0
  ) {
    return null;
  }

  const normalized = {
    latitude,
    longitude,
    timestampMs: Math.floor(loctime * 1000)
  };

  ["accuracy", "speed", "direction", "altitude", "type"].forEach(
    key => {
      const value = Number(point[key]);

      if (Number.isFinite(value)) {
        normalized[key] = value;
      }
    }
  );

  return normalized;
}

function validateWalkContext(event) {
  if (!isNonEmptyString(event && event.routeId)) {
    throw codedError(
      "INVALID_TRACKING_SESSION",
      "Missing walking route ID."
    );
  }

  if (
    !Number.isFinite(event.walkStartTimeMs) ||
    event.walkStartTimeMs <= 0
  ) {
    throw codedError(
      "INVALID_TRACKING_SESSION",
      "Invalid walking start time."
    );
  }
}

function validateSearchRange(event) {
  const startTimeMs = event && event.startTimeMs;
  const endTimeMs = event && event.endTimeMs;

  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(endTimeMs) ||
    startTimeMs <= 0 ||
    endTimeMs <= startTimeMs
  ) {
    throw codedError(
      "INVALID_TRACK_RANGE",
      "Invalid walking trajectory time range."
    );
  }

  if (endTimeMs - startTimeMs > MAX_TRACE_QUERY_MS) {
    throw codedError(
      "TRACK_RANGE_TOO_LARGE",
      "Walking trajectory queries cannot exceed 24 hours."
    );
  }

  return {
    startTimeSeconds: Math.floor(startTimeMs / 1000),
    endTimeSeconds: Math.ceil(endTimeMs / 1000)
  };
}

function publicFailure(error) {
  const code = isNonEmptyString(error && error.code)
    ? error.code
    : "TRACK_PROVIDER_FAILED";

  const publicMessages = {
    INVALID_ACTION: "Unsupported track provider operation.",
    UNAUTHENTICATED: "Unable to identify the current user.",
    INVALID_TRACKING_SESSION: "Invalid walking tracking session.",
    INVALID_TRACK_POINT: "Invalid walking trajectory point.",
    INVALID_TRACK_RANGE: "Invalid walking trajectory time range.",
    TRACK_RANGE_TOO_LARGE:
      "Walking trajectory queries cannot exceed 24 hours.",
    TRACK_ENTITY_FAILED:
      "Unable to prepare walking trajectory storage.",
    TRACK_UPLOAD_FAILED: "Unable to upload walking trajectory.",
    TRACK_UPLOAD_REJECTED: "Walking trajectory point was rejected.",
    TRACK_SEARCH_FAILED: "Unable to query walking trajectory.",
    TRACK_SEARCH_TOO_LARGE:
      "Walking trajectory is too large to query safely.",
    TRACK_SEARCH_PAGINATION_FAILED:
      "Unable to complete walking trajectory query.",
    TRACK_PROVIDER_REJECTED:
      "Tencent Track Cloud rejected the request.",
    TRACK_PROVIDER_UNAVAILABLE:
      "Tencent Track Cloud is temporarily unavailable."
  };

  return {
    success: false,
    error: {
      code,
      message:
        publicMessages[code] ||
        "Walking trajectory service is temporarily unavailable."
    }
  };
}

function createTrackHandler({
  config,
  client,
  getOpenId,
  ensuredEntityIds = new Set(),
  log = () => {}
}) {
  if (!config || !client || typeof getOpenId !== "function") {
    throw new Error("Track handler dependencies are required.");
  }

  async function resolveEntity() {
    const openid = getOpenId();

    if (!isNonEmptyString(openid)) {
      throw codedError(
        "UNAUTHENTICATED",
        "Missing authenticated OpenID."
      );
    }

    const entityId = createEntityId(
      openid,
      config.entitySecret
    );

    if (!ensuredEntityIds.has(entityId)) {
      await client.ensureEntity(entityId);
      ensuredEntityIds.add(entityId);
    }

    return entityId;
  }

  return async function handle(event = {}) {
    const action = event && event.action;

    try {
      if (
        !["ensureEntity", "uploadTrace", "searchTrace"].includes(
          action
        )
      ) {
        throw codedError(
          "INVALID_ACTION",
          "Unsupported track provider operation."
        );
      }

      const entityId = await resolveEntity();

      if (action === "ensureEntity") {
        return {
          success: true,
          tracking: {
            ready: true
          }
        };
      }

      if (action === "uploadTrace") {
        validateWalkContext(event);
        const providerPoint = normalizeUploadPoint(event.point);
        const result = await client.uploadTrace(
          entityId,
          [providerPoint]
        );

        return {
          success: true,
          uploadedCount: result.uploadedCount
        };
      }

      const range = validateSearchRange(event);
      const result = await client.searchTrace(
        entityId,
        range.startTimeSeconds,
        range.endTimeSeconds
      );

      const points = Array.isArray(result.points)
        ? result.points
            .map(normalizeSearchPoint)
            .filter(Boolean)
        : [];

      return {
        success: true,
        trace: {
          points,
          mileageMeters:
            Number.isFinite(result.mileageMeters) &&
            result.mileageMeters >= 0
              ? result.mileageMeters
              : 0,
          durationSeconds:
            Number.isFinite(result.durationSeconds) &&
            result.durationSeconds >= 0
              ? result.durationSeconds
              : 0,
          available: points.length > 0,
          // An empty result is not treated as permanently unavailable.
          // Track Cloud may accept an upload before that point becomes
          // immediately visible to a subsequent search.
          retryable: points.length === 0,
          partial: false
        }
      };
    } catch (error) {
      log({
        event: "request_failed",
        action: isNonEmptyString(action) ? action : "unknown",
        code: isNonEmptyString(error && error.code)
          ? error.code
          : "TRACK_PROVIDER_FAILED",
        providerStatus:
          Number.isFinite(error && error.providerStatus)
            ? error.providerStatus
            : null,
        requestId:
          isNonEmptyString(error && error.requestId)
            ? error.requestId
            : null
      });

      return publicFailure(error);
    }
  };
}

module.exports = {
  MAX_TRACE_QUERY_MS,
  normalizeUploadPoint,
  normalizeSearchPoint,
  createTrackHandler,
  publicFailure
};
