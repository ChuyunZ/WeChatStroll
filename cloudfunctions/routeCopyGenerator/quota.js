const crypto = require('crypto');
const { transact } = require('./quota-store');
const PER_USER_DAILY_LIMIT = 24;
const GLOBAL_DAILY_LIMIT = 200;

// Enforced across all Cloud Function instances before any model inference.
// Counters reset at 00:00 UTC; transaction protects both counters atomically.
function createQuotaGate({ store, now = Date.now, sleep,
  userLimit = PER_USER_DAILY_LIMIT, globalLimit = GLOBAL_DAILY_LIMIT }) {
  if (!store || typeof store.transaction !== 'function' ||
      !Number.isSafeInteger(userLimit) || userLimit < 1 ||
      !Number.isSafeInteger(globalLimit) || globalLimit < 1) throw new Error('Invalid quota configuration');
  return async openid => {
    if (typeof openid !== 'string' || !openid.trim()) throw new Error('Missing identity');
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid clock');
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const ownerHash = crypto.createHash('sha256').update(openid).digest('hex');
    return transact(store, async tx => {
      // Fixed document IDs are shared across dates; never persist model input.
      const userId = `user_${ownerHash}`;
      const user = await tx.get(userId);
      const global = await tx.get('global');
      const userUsed = user && user.day === day ? user.used : 0;
      const globalUsed = global && global.day === day ? global.used : 0;
      if (![userUsed, globalUsed].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid quota state');
      if (userUsed >= userLimit || globalUsed >= globalLimit) return { allowed: false, reason: 'exhausted' };
      await tx.set(userId, { day, used: userUsed + 1, updatedAtMs: timestamp });
      await tx.set('global', { day, used: globalUsed + 1, updatedAtMs: timestamp });
      return { allowed: true };
    }, sleep);
  };
}
module.exports = { PER_USER_DAILY_LIMIT, GLOBAL_DAILY_LIMIT, createQuotaGate };
