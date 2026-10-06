const crypto = require('crypto');
const { transact } = require('./store');

const MIN_WALKING_DURATION_MINUTES = 15;
const MAX_WALKING_DURATION_MINUTES = 120;
const MAX_ACTIVE_WALK_AGE_MS = 12 * 60 * 60 * 1000;

const messages = {
  UNAUTHENTICATED: 'Unable to identify the current user.',
  INVALID_ACTION: 'Unsupported walk operation.',
  INVALID_INPUT: 'Invalid walk metadata.',
  WALK_NOT_FOUND: 'Walk not found.',
  WALK_STATE_CONFLICT: 'Walk is already finalized with another state.',
  WALK_STORE_FAILED: 'Walk storage is temporarily unavailable.'
};
function fail(code) { throw Object.assign(new Error(messages[code]), { code }); }
function publicFailure(error) {
  const code = Object.hasOwn(messages, error && error.code) ? error.code : 'WALK_STORE_FAILED';
  return { success: false, error: { code, message: messages[code] } };
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) fail('INVALID_INPUT');
  return value;
}
function preferencesOf(input) {
  if (!input || !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < MIN_WALKING_DURATION_MINUTES ||
      input.durationMinutes > MAX_WALKING_DURATION_MINUTES ||
      !['loop', 'out_and_back', 'point_to_point'].includes(input.routeType) ||
      !['low', 'medium', 'high'].includes(input.crowdPreference) ||
      !Array.isArray(input.environmentPreferences) || input.environmentPreferences.length > 10 ||
      !input.environmentPreferences.every(value => ['公园', '水边', '街道', '商街'].includes(value))) fail('INVALID_INPUT');
  return { durationMinutes: input.durationMinutes, routeType: input.routeType,
    crowdPreference: input.crowdPreference, environmentPreferences: [...input.environmentPreferences] };
}
function publicWalk(walk) {
  if (!walk) return null;
  const { ownerKey, _id, ...record } = walk;
  return record;
}
function isExpiredActiveWalk(walk, nowMs) {
  const startMs = walk && Date.parse(walk.startTime);
  return Boolean(
    walk &&
    walk.status === 'active' &&
    Number.isFinite(startMs) &&
    Number.isFinite(nowMs) &&
    nowMs >= startMs &&
    nowMs - startMs >= MAX_ACTIVE_WALK_AGE_MS
  );
}
async function abandonIfExpired(tx, walk, lockPath, nowMs, knownLock) {
  if (!isExpiredActiveWalk(walk, nowMs)) return walk;
  const abandoned = {
    ...walk,
    status: 'abandoned',
    endTime: null,
    actualDurationSeconds: null,
    completionStatus: 'abandoned',
    trajectoryPartial: Boolean(walk.trajectoryEnabled || walk.trajectoryPartial),
    trajectoryEndTimeMs: null,
    updatedAt: new Date(nowMs).toISOString()
  };
  await tx.set(`walks/${id(walk.walkId)}`, abandoned);
  const lock = knownLock === undefined ? await tx.get(lockPath) : knownLock;
  if (lock && lock.walkId === walk.walkId) await tx.set(lockPath, { walkId: null });
  return abandoned;
}
function createWalkHandler({ store, getOpenId, now = Date.now, newId = () => crypto.randomBytes(16).toString('hex'), sleep }) {
  return async (event = {}) => {
    try {
      const openid = getOpenId();
      if (typeof openid !== 'string' || !openid.trim()) fail('UNAUTHENTICATED');
      const ownerKey = crypto.createHash('sha256').update(openid).digest('hex');
      const lockPath = `active_walks/${ownerKey}`;
      if (!['startWalk', 'getActiveWalk', 'getWalk', 'completeWalk'].includes(event.action)) fail('INVALID_ACTION');
      const owned = walk => {
        if (!walk || walk.ownerKey !== ownerKey) fail('WALK_NOT_FOUND');
        return walk;
      };
      const walk = await transact(store, async tx => {
        const nowMs = now();
        if (event.action === 'startWalk' || event.action === 'getActiveWalk') {
          const lock = await tx.get(lockPath);
          if (lock && lock.walkId) {
            const existing = owned(await tx.get(`walks/${id(lock.walkId)}`));
            const current = await abandonIfExpired(tx, existing, lockPath, nowMs, lock);
            if (current.status === 'active') return current;
            if (event.action === 'getActiveWalk') {
              await tx.set(lockPath, { walkId: null });
              return null;
            }
          }
          if (event.action === 'getActiveWalk') return null;
          const preferences = preferencesOf(event.preferences);
          if (typeof event.trajectoryEnabled !== 'boolean') fail('INVALID_INPUT');
          const time = new Date(nowMs).toISOString();
          const record = { walkId: newId(), ownerKey, status: 'active', routeId: id(event.routeId), preferences,
            requestedDurationMinutes: preferences.durationMinutes, routeType: preferences.routeType,
            startTime: time, endTime: null, actualDurationSeconds: 0, completionStatus: null,
            trajectoryEnabled: event.trajectoryEnabled, trajectoryPartial: event.trajectoryEnabled,
            trajectoryEndTimeMs: null, schemaVersion: 1, createdAt: time, updatedAt: time };
          await tx.set(`walks/${record.walkId}`, record);
          await tx.set(lockPath, { walkId: record.walkId });
          return record;
        }
        const path = `walks/${id(event.walkId)}`;
        let record = owned(await tx.get(path));
        record = await abandonIfExpired(tx, record, lockPath, nowMs);
        if (event.action === 'getWalk' || record.status === 'abandoned') return record;
        if (!['completed', 'ended_early'].includes(event.completionStatus)) fail('INVALID_INPUT');
        if (record.status !== 'active') {
          if (record.status !== event.completionStatus) fail('WALK_STATE_CONFLICT');
          return record;
        }
        const startMs = Date.parse(record.startTime);
        const endMs = event.endTimeMs;
        if (!Number.isSafeInteger(endMs) || endMs < startMs || endMs > nowMs + 60000 ||
            typeof event.trajectoryPartial !== 'boolean') fail('INVALID_INPUT');
        const terminal = { ...record, status: event.completionStatus, completionStatus: event.completionStatus,
          endTime: new Date(endMs).toISOString(), actualDurationSeconds: Math.floor((endMs - startMs) / 1000),
          trajectoryPartial: record.trajectoryEnabled && event.trajectoryPartial,
          trajectoryEndTimeMs: endMs, updatedAt: new Date(nowMs).toISOString() };
        const lock = await tx.get(lockPath);
        await tx.set(path, terminal);
        if (lock && lock.walkId === record.walkId) await tx.set(lockPath, { walkId: null });
        return terminal;
      }, sleep);
      return { success: true, walk: publicWalk(walk) };
    } catch (error) { return publicFailure(error); }
  };
}
module.exports = { createWalkHandler, publicFailure };
