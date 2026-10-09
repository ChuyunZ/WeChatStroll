// All counters live in one independent CloudBase collection; no prompt/POI data is stored.
const COLLECTION = 'route_copy_quotas';
function createStore(db) {
  return {
    async transaction(work) {
      const tx = await db.startTransaction();
      try {
        const api = {
          async get(id) {
            const record = (await tx.collection(COLLECTION).doc(id).get()).data;
            return record || null;
          },
          async set(id, data) {
            await tx.collection(COLLECTION).doc(id).set({ data });
          }
        };
        const result = await work(api);
        await tx.commit();
        return result;
      } catch (error) {
        try { await tx.rollback(); } catch (_) { /* Preserve original error. */ }
        throw error;
      }
    }
  };
}
function isConflict(error) {
  return !!error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i
      .test([error.errMsg, error.message].filter(v => typeof v === 'string').join(' ')));
}
async function transact(store, work, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await store.transaction(work); } catch (error) {
      // Ambiguous commit acknowledgements are not retried: a double reservation
      // would violate the ceiling. Only known, rolled-back conflicts are safe.
      if (!isConflict(error) || attempt === 4) throw error;
      const jitter = 5 + Math.floor(Math.random() * (10 * (attempt + 1)));
      await sleep(jitter);
    }
  }
}
module.exports = { COLLECTION, createStore, isConflict, transact };
