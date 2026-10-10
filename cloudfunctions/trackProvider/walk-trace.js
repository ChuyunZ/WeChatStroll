const crypto = require('crypto');
const { traceError, exactKeys, validWalkId, comparePoints, MAX_TRACE_POINTS } = require('./trace-schema');
function canonicalTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isSafeInteger(Date.parse(value)) && Date.parse(value) > 0 && new Date(value).toISOString() === value;
}
async function authorizeWalk(event, openid, store, nowMs, validateSearchRange) {
  if (!exactKeys(event, ['action', 'walkId']) || !validWalkId(event.walkId)) throw traceError('INVALID_WALK_TRACE_REQUEST');
  let walk;
  try { walk = await store.getWalk(event.walkId); } catch (_) { throw traceError('TRACK_WALK_READ_FAILED'); }
  const ownerKey = crypto.createHash('sha256').update(openid).digest('hex');
  if (!walk || walk.ownerKey !== ownerKey) throw traceError('WALK_NOT_FOUND');
  if (walk._id !== event.walkId || walk.walkId !== event.walkId || walk.schemaVersion !== 1 ||
      !['completed', 'ended_early'].includes(walk.status) || walk.completionStatus !== walk.status) {
    throw traceError('INVALID_WALK_TRACE_METADATA');
  }
  if (walk.trajectoryEnabled === false) throw traceError('TRACK_NOT_ENABLED');
  if (walk.trajectoryEnabled !== true || typeof walk.trajectoryPartial !== 'boolean' ||
      !canonicalTime(walk.startTime) || !canonicalTime(walk.endTime)) throw traceError('INVALID_WALK_TRACE_METADATA');
  const startTimeMs = Date.parse(walk.startTime), completionMs = Date.parse(walk.endTime);
  const endTimeMs = walk.trajectoryEndTimeMs;
  if (!Number.isSafeInteger(endTimeMs) || !Number.isSafeInteger(nowMs) || startTimeMs > completionMs ||
      endTimeMs < completionMs ||
      endTimeMs > nowMs || endTimeMs > 253402300799999 || endTimeMs <= startTimeMs) {
    throw traceError('INVALID_WALK_TRACE_METADATA');
  }
  // Completion retries retain the original endTime; cleanup may finish much later.
  // Validate the whole persisted interval, without inventing a separate tail limit.
  // Reject future persisted bounds above; never use the legacy validator's clamping as authorization.
  const range = validateSearchRange({ startTimeMs, endTimeMs }, nowMs);
  return { ...range, startTimeMs, endTimeMs, partial: walk.trajectoryPartial };
}
function normalizeWalkTrace(result, range, normalizePoint) {
  if (!result || !Array.isArray(result.points)) throw traceError('TRACK_INVALID_RESPONSE');
  if (result.points.length > MAX_TRACE_POINTS) throw traceError('TRACK_SEARCH_TOO_LARGE');
  let lost = false, invalid = 0;
  const candidates = [];
  for (const raw of result.points) {
    const point = normalizePoint(raw);
    if (!point) { invalid++; lost = true; continue; }
    // Upload floors milliseconds to seconds. Only keep a bucket entirely inside
    // the persisted range; otherwise an adjacent walk could share that second.
    if (point.timestampMs < range.startTimeMs || point.timestampMs + 999 > range.endTimeMs) {
      lost = true;
      continue;
    }
    candidates.push(point);
  }
  if (invalid && !candidates.length) throw traceError('TRACK_INVALID_RESPONSE');
  candidates.sort((a, b) => comparePoints(a, b) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const points = candidates.filter((point, i) => {
    if (i && comparePoints(candidates[i - 1], point) === 0) { lost = true; return false; }
    return true;
  });
  const metric = value => {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw traceError('TRACK_INVALID_RESPONSE');
    return value;
  };
  const mileageMeters = metric(result.mileageMeters), durationSeconds = metric(result.durationSeconds);
  return { points, mileageMeters: lost ? null : mileageMeters, durationSeconds: lost ? null : durationSeconds,
    available: points.length > 0, retryable: points.length === 0, partial: range.partial || lost };
}
module.exports = { authorizeWalk, normalizeWalkTrace };
