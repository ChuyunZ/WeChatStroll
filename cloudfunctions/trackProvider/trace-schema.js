// Mirrored in miniprogram/utils/history-trace-schema.js for independent deployment.
const MAX_TRACE_POINTS = 10000;
const MESSAGES = {
  INVALID_ACTION: 'Unsupported track provider operation.',
  UNAUTHENTICATED: 'Unable to identify the current user.',
  INVALID_TRACKING_SESSION: 'Invalid walking tracking session.',
  INVALID_TRACK_POINT: 'Invalid walking trajectory point.',
  INVALID_TRACK_RANGE: 'Invalid walking trajectory time range.',
  INVALID_WALK_TRACE_REQUEST: 'Invalid historical trajectory request.',
  WALK_NOT_FOUND: 'Walk not found.',
  TRACK_NOT_ENABLED: 'Trajectory recording was not enabled for this walk.',
  INVALID_WALK_TRACE_METADATA: 'Walk trajectory metadata is unavailable or invalid.',
  TRACK_WALK_REQUIRED: 'Trajectory queries require an authorized walk ID.',
  TRACK_WALK_READ_FAILED: 'Unable to read walking trajectory authorization.',
  TRACK_INVALID_RESPONSE: 'Invalid walking trajectory response.',
  TRACK_RANGE_TOO_LARGE: 'Walking trajectory queries cannot exceed 24 hours.',
  TRACK_ENTITY_FAILED: 'Unable to prepare walking trajectory storage.',
  TRACK_UPLOAD_FAILED: 'Unable to upload walking trajectory.',
  TRACK_UPLOAD_REJECTED: 'Walking trajectory point was rejected.',
  TRACK_SEARCH_FAILED: 'Unable to query walking trajectory.',
  TRACK_SEARCH_RATE_LIMITED: 'Walking trajectory query limit reached. Try again later.',
  TRACK_RATE_LIMIT_STORE_FAILED: 'Walking trajectory query quota is temporarily unavailable.',
  TRACK_SEARCH_TOO_LARGE: 'Walking trajectory is too large to query safely.',
  TRACK_SEARCH_PAGINATION_FAILED: 'Unable to complete walking trajectory query.',
  TRACK_PROVIDER_REJECTED: 'Tencent Track Cloud rejected the request.',
  TRACK_PROVIDER_UNAVAILABLE: 'Tencent Track Cloud is temporarily unavailable.',
  TRACK_PROVIDER_CONFIG_ERROR: 'Walking trajectory service is not configured.',
  TRACK_PROVIDER_FAILED: 'Walking trajectory service is temporarily unavailable.'
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function traceError(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
function safeCode(error) { return error && own(MESSAGES, error.code) ? error.code : 'TRACK_PROVIDER_FAILED'; }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}
function validWalkId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id); }
function validateRequest(input) {
  if (!exactKeys(input, ['walkId']) || !validWalkId(input.walkId)) throw traceError('INVALID_WALK_TRACE_REQUEST');
  return { walkId: input.walkId };
}
function validMetadata(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return false;
  if (key === 'accuracy' || key === 'speed') return value >= 0;
  if (key === 'direction') return value >= 0 && value <= 360;
  if (key === 'type') return Number.isSafeInteger(value) && value >= 0;
  return key === 'altitude';
}
const OPTIONAL_POINT_KEYS = ['accuracy', 'speed', 'direction', 'altitude', 'type'];
function validPoint(point) {
  return point && typeof point === 'object' && !Array.isArray(point) &&
    Object.keys(point).every(key => ['latitude', 'longitude', 'timestampMs', ...OPTIONAL_POINT_KEYS].includes(key)) &&
    typeof point.latitude === 'number' && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === 'number' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180 &&
    Number.isSafeInteger(point.timestampMs) && point.timestampMs > 0 && point.timestampMs <= 253402300799000 && point.timestampMs % 1000 === 0 &&
    OPTIONAL_POINT_KEYS.every(key => !own(point, key) || validMetadata(key, point[key]));
}
function comparePoints(a, b) {
  return a.timestampMs - b.timestampMs || a.latitude - b.latitude || a.longitude - b.longitude;
}
function validateTraceResponse(result) {
  const trace = result && result.trace;
  const metric = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  if (!exactKeys(result, ['success', 'trace']) || result.success !== true ||
      !exactKeys(trace, ['points', 'mileageMeters', 'durationSeconds', 'available', 'retryable', 'partial']) ||
      !Array.isArray(trace.points) || trace.points.length > MAX_TRACE_POINTS ||
      !metric(trace.mileageMeters) || !metric(trace.durationSeconds) || typeof trace.partial !== 'boolean' ||
      trace.available !== (trace.points.length > 0) || trace.retryable !== (trace.points.length === 0) ||
      !Array.from(trace.points).every((point, i) => validPoint(point) && (!i || comparePoints(trace.points[i - 1], point) < 0))) {
    throw traceError('TRACK_INVALID_RESPONSE');
  }
  return { ...trace, points: trace.points.map(point => ({ ...point })) };
}
module.exports = { MAX_TRACE_POINTS, MESSAGES, traceError, safeCode, exactKeys, validWalkId,
  validateRequest, validMetadata, OPTIONAL_POINT_KEYS, validPoint, comparePoints, validateTraceResponse };
