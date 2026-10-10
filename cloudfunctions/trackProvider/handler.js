const { createEntityId } = require("./entity-id");
const { MESSAGES, safeCode, traceError, validPoint, validMetadata, OPTIONAL_POINT_KEYS } = require('./trace-schema');
const { authorizeWalk, normalizeWalkTrace } = require('./walk-trace');

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

  const number = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  const latitude = number(point.lat);
  const longitude = number(point.lng);
  const loctime = number(point.loctime);

  if (
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude) ||
    !Number.isSafeInteger(loctime) ||
    loctime <= 0
  ) {
    return null;
  }

  const normalized = {
    latitude,
    longitude,
    timestampMs: Math.floor(loctime * 1000)
  };

  OPTIONAL_POINT_KEYS.forEach(
    key => {
      if (!Object.prototype.hasOwnProperty.call(point, key)) return;
      const value = number(point[key]);

      if (validMetadata(key, value)) {
        normalized[key] = value;
      } else {
        normalized[key] = NaN; // Invalid optional metadata invalidates this sample too.
      }
    }
  );

  return validPoint(normalized) ? normalized : null;
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

function validateSearchRange(
  event,
  nowMs = Date.now()
) {
  const startTimeMs = event && event.startTimeMs;
  const requestedEndTimeMs = event && event.endTimeMs;

  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(requestedEndTimeMs) ||
    !Number.isFinite(nowMs) ||
    startTimeMs <= 0
  ) {
    throw codedError(
      "INVALID_TRACK_RANGE",
      "Invalid walking trajectory time range."
    );
  }

  // Tencent Track Cloud behaved inconsistently when queried with a
  // future end_time during real-device POC. Never send a future range
  // boundary to the provider.
  const endTimeMs = Math.min(
    requestedEndTimeMs,
    nowMs
  );

  if (endTimeMs <= startTimeMs) {
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
    endTimeSeconds: Math.floor(endTimeMs / 1000)
  };
}

function publicFailure(error) {
  const code = safeCode(error);

  return {
    success: false,
    error: {
      code,
      message: MESSAGES[code]
    }
  };
}

function createTrackHandler({
  config,
  client,
  getOpenId,
  walkStore,
  ensuredEntityIds = new Set(),
  log = () => {},
  getNowMs = () => Date.now()
}) {
  if (!config || !client || typeof getOpenId !== "function") {
    throw new Error("Track handler dependencies are required.");
  }

  async function resolveEntity(openid) {
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
        !["ensureEntity", "uploadTrace", "searchTrace", "searchWalkTrace"].includes(
          action
        )
      ) {
        throw codedError(
          "INVALID_ACTION",
          "Unsupported track provider operation."
        );
      }

      const openid = getOpenId();
      if (!isNonEmptyString(openid)) throw traceError('UNAUTHENTICATED');
      // No application page calls the old arbitrary-range query. Retire the bypass.
      if (action === 'searchTrace') throw traceError('TRACK_WALK_REQUIRED');
      if (action === 'searchWalkTrace') {
        const range = await authorizeWalk(event, openid, walkStore, getNowMs(), validateSearchRange);
        // A same-second interval cannot form a positive provider query. Never extend it.
        if (range.startTimeSeconds === range.endTimeSeconds) {
          return { success: true, trace: normalizeWalkTrace({ points: [] }, { ...range, partial: true }, normalizeSearchPoint) };
        }
        const entityId = await resolveEntity(openid);
        const result = await client.searchTrace(entityId, range.startTimeSeconds, range.endTimeSeconds);
        return { success: true, trace: normalizeWalkTrace(result, range, normalizeSearchPoint) };
      }

      const entityId = await resolveEntity(openid);

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

    } catch (error) {
      if (action === 'searchWalkTrace' || action === 'searchTrace') {
        log({ event: 'request_failed', action, code: safeCode(error) });
        return publicFailure(error);
      }
      log({
        event: "request_failed",
        action: ['ensureEntity', 'uploadTrace'].includes(action) ? action : "unknown",
        code: safeCode(error),
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
