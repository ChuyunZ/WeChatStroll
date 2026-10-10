// Kept identical in miniprogram/utils: cloud functions deploy independently.
const MAX_HISTORY_LIMIT = 20;
const ITEM_KEYS = ['walkId', 'status', 'startTime', 'endTime', 'actualDurationSeconds',
  'routeType', 'requestedDurationMinutes', 'trajectoryEnabled', 'trajectoryPartial',
  'trajectoryEndTimeMs', 'rating'];
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
}
function validTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
}
function validCursor(cursor) {
  return exactKeys(cursor, ['version', 'endTime', 'walkId']) && cursor.version === 1 &&
    validTime(cursor.endTime) && validId(cursor.walkId);
}
function historyRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid history request.');
  const limit = input.limit === undefined ? 10 : input.limit;
  const cursor = input.cursor === undefined ? null : input.cursor;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) throw new Error('Invalid history limit.');
  if (cursor !== null && !validCursor(cursor)) throw new Error('Invalid history cursor.');
  return { limit, cursor: cursor === null ? null : { ...cursor } };
}
// Binary comparison matches the database's simple string ordering, not locale collation.
function compareHistory(a, b) {
  if (a.endTime !== b.endTime) return a.endTime > b.endTime ? -1 : 1;
  return a.walkId === b.walkId ? 0 : a.walkId < b.walkId ? -1 : 1;
}
function historyItem(value) {
  if (!exactKeys(value, ITEM_KEYS) || !validId(value.walkId) ||
      !['completed', 'ended_early'].includes(value.status) || !validTime(value.startTime) || !validTime(value.endTime) ||
      value.endTime < value.startTime || !Number.isSafeInteger(value.actualDurationSeconds) ||
      value.actualDurationSeconds < 0 ||
      value.actualDurationSeconds !== Math.floor((Date.parse(value.endTime) - Date.parse(value.startTime)) / 1000) ||
      !['loop', 'out_and_back', 'point_to_point'].includes(value.routeType) ||
      !Number.isInteger(value.requestedDurationMinutes) || value.requestedDurationMinutes < 15 || value.requestedDurationMinutes > 120 ||
      typeof value.trajectoryEnabled !== 'boolean' || typeof value.trajectoryPartial !== 'boolean' ||
      (!value.trajectoryEnabled && value.trajectoryPartial) ||
      !Number.isSafeInteger(value.trajectoryEndTimeMs) || value.trajectoryEndTimeMs < Date.parse(value.endTime) ||
      value.trajectoryEndTimeMs > 253402300799999 ||
      (value.rating !== null && (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5))) {
    throw new Error('Invalid history item.');
  }
  return { ...value };
}
function validTotals(value) {
  return exactKeys(value, ['completedWalkCount', 'endedEarlyWalkCount']) &&
    Object.values(value).every(count => Number.isSafeInteger(count) && count >= 0);
}
function historyResponse(result, request) {
  if (!exactKeys(result, ['success', 'items', 'nextCursor', 'totals']) || result.success !== true ||
      !Array.isArray(result.items) || result.items.length > request.limit ||
      (request.cursor === null ? !validTotals(result.totals) : result.totals !== null) ||
      (result.nextCursor !== null && !validCursor(result.nextCursor))) throw new Error('Invalid history response.');
  const items = result.items.map(historyItem);
  const seen = new Set();
  items.forEach((item, index) => {
    if (seen.has(item.walkId) || (index && compareHistory(items[index - 1], item) >= 0) ||
        (request.cursor && (item.walkId === request.cursor.walkId || compareHistory(request.cursor, item) >= 0))) {
      throw new Error('Invalid history order.');
    }
    seen.add(item.walkId);
  });
  if (result.nextCursor !== null && (items.length !== request.limit ||
      compareHistory(items[items.length - 1], result.nextCursor) !== 0)) throw new Error('Invalid history continuation.');
  return { items, nextCursor: result.nextCursor === null ? null : { ...result.nextCursor },
    totals: result.totals === null ? null : { ...result.totals } };
}
module.exports = { MAX_HISTORY_LIMIT, ITEM_KEYS, validCursor, historyRequest, compareHistory, historyItem, validTotals, historyResponse };
