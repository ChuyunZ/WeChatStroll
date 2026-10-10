const crypto = require('crypto');
const { traceError, exactKeys } = require('./trace-schema');
const COLLECTION = 'history_trace_rate_limits';
const LIMIT = 20, WINDOW_MS = 60 * 60 * 1000;
// Same explicit transaction/rollback pattern as walkStore, scoped to one collection.
function createQuotaStore(db) {
  return { async transaction(work) {
    const transaction = await db.startTransaction();
    try {
      const result = await work({
        async get(id) {
          const result = await transaction.collection(COLLECTION).doc(id).get();
          if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid quota read.');
          if (result.data === null) return null;
          const { _id, ...record } = result.data;
          if (_id !== undefined && _id !== id) throw new Error('Invalid quota identity.');
          return record;
        },
        async set(id, data) { await transaction.collection(COLLECTION).doc(id).set({ data }); }
      });
      await transaction.commit();
      return result;
    } catch (error) {
      try { await transaction.rollback(); } catch (_) { /* Already aborted. */ }
      throw error;
    }
  } };
}
function conflict(error) {
  return error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i.test(
      [error.errMsg, error.message].filter(x => typeof x === 'string').join(' ')));
}
function validateState(record, now) {
  if (!exactKeys(record, ['requestTimesMs', 'updatedAtMs']) ||
      !Number.isSafeInteger(record.updatedAtMs) || record.updatedAtMs < 0 || record.updatedAtMs > now ||
      !Array.isArray(record.requestTimesMs) || record.requestTimesMs.length > LIMIT ||
      !Array.from(record.requestTimesMs).every((time, i) => Number.isSafeInteger(time) && time > 0 &&
        time <= record.updatedAtMs && (!i || time >= record.requestTimesMs[i - 1])) ||
      (record.requestTimesMs.length && record.requestTimesMs[record.requestTimesMs.length - 1] !== record.updatedAtMs)) {
    throw new Error('Invalid quota state.');
  }
}
function createHistoryLimiter({ store, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  return { async reserve(openid) {
    let allowed;
    try {
      if (typeof openid !== 'string' || !openid.trim()) throw new Error('Invalid identity.');
      const id = crypto.createHash('sha256').update(openid).digest('hex');
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          allowed = await store.transaction(async tx => {
            const record = await tx.get(id), time = now();
            if (!Number.isSafeInteger(time) || time <= 0) throw new Error('Invalid clock.');
            if (record !== null) validateState(record, time);
            // Trailing window is (now - 60 minutes, now]; exact-hour timestamps expire.
            const times = record === null ? [] : record.requestTimesMs.filter(t => t > time - WINDOW_MS);
            if (times.length >= LIMIT) return false;
            await tx.set(id, { requestTimesMs: [...times, time], updatedAtMs: time });
            return true;
          });
          break;
        } catch (error) {
          if (!conflict(error) || attempt === 3) throw error;
          const base = 10 * (2 ** attempt);
          await sleep(base + Math.floor(random() * base));
        }
      }
      if (allowed !== true && allowed !== false) throw new Error('Invalid transaction result.');
    } catch (_) { throw traceError('TRACK_RATE_LIMIT_STORE_FAILED'); }
    if (allowed !== true) throw traceError('TRACK_SEARCH_RATE_LIMITED');
  } };
}
module.exports = { COLLECTION, LIMIT, WINDOW_MS, createQuotaStore, createHistoryLimiter };
