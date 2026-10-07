const crypto = require('crypto');
const { buildProfile } = require('./profile-builder');
const { PUBLIC_FIELDS, validateProfile } = require('./profile-schema');
const { conflict, revision } = require('./store');
const REFRESH_ATTEMPTS = 4;
const messages = {
  UNAUTHENTICATED: 'Unable to identify the current user.',
  INVALID_ACTION: 'Unsupported preference profile operation.',
  INVALID_INPUT: 'Only the action may be supplied.',
  PREFERENCE_PROFILE_STORE_FAILED: 'Preference profile storage is temporarily unavailable.'
};
function fail(code) { throw Object.assign(new Error(messages[code]), { code }); }
function publicFailure(error) {
  const code = Object.prototype.hasOwnProperty.call(messages, error && error.code) ? error.code : 'PREFERENCE_PROFILE_STORE_FAILED';
  return { success: false, error: { code, message: messages[code] } };
}
function publicProfile(record, ownerKey) {
  if (!record) return null;
  if (record.ownerKey !== ownerKey || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Invalid stored profile.');
  if (record.profile === null && Object.keys(record).every(key => ['_id', 'ownerKey', 'revision', 'profile'].includes(key))) return null;
  return validateProfile(Object.fromEntries(PUBLIC_FIELDS.map(key => [key, record[key]])));
}
function createProfileHandler({ store, getOpenId, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return async (event = {}) => {
    try {
      const openid = getOpenId();
      if (typeof openid !== 'string' || !openid.trim()) fail('UNAUTHENTICATED');
      const ownerKey = crypto.createHash('sha256').update(openid).digest('hex');
      if (!event || !['getProfile', 'refreshProfile'].includes(event.action)) fail('INVALID_ACTION');
      if (Object.keys(event).some(key => key !== 'action')) fail('INVALID_INPUT');
      if (event.action === 'getProfile') return { success: true, profile: publicProfile(await store.getProfile(ownerKey), ownerKey) };
      for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
        try {
          // Read the fence BEFORE loading history. A conflict retries the entire read/build/write.
          const previous = await store.getProfile(ownerKey);
          publicProfile(previous, ownerKey);
          const history = await store.loadHistory(ownerKey);
          const profile = buildProfile({ ...history, ownerKey, lastUpdatedAt: new Date(now()).toISOString() });
          if (profile) validateProfile(profile);
          const result = await store.compareAndSet(ownerKey, revision(previous), profile);
          if (!result.retry) return { success: true, profile: publicProfile(result.record, ownerKey) };
        } catch (error) { if (!conflict(error)) throw error; }
        if (attempt + 1 < REFRESH_ATTEMPTS) await sleep(10 * (2 ** attempt));
      }
      fail('PREFERENCE_PROFILE_STORE_FAILED');
    } catch (error) { return publicFailure(error); }
  };
}
module.exports = { createProfileHandler, publicFailure };
