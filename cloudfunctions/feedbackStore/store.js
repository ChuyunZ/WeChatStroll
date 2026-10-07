// Explicit transactions, including missing-document reads, fence concurrent submissions.
function isTransactionConflict(error) {
  if (!error) return false;
  if (error.code === 'DATABASE_TRANSACTION_CONFLICT') return true;
  const detail = [error.errMsg, error.message]
    .filter(value => typeof value === 'string')
    .join(' ');
  return /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i.test(detail);
}

function createStore(db) {
  return {
    async transaction(work) {
      const transaction = await db.startTransaction();
      try {
        const result = await work({
          async get(path) {
            const [collection, id] = path.split('/');
            const result = await transaction.collection(collection).doc(id).get();
            if (!result.data) return null;
            const { _id, ...record } = result.data;
            return record;
          },
          async set(path, data) {
            const [collection, id] = path.split('/');
            const { _id, ...record } = data;
            await transaction.collection(collection).doc(id).set({ data: record });
          }
        });
        await transaction.commit();
        return result;
      } catch (error) {
        try { await transaction.rollback(); } catch (_) { /* already aborted */ }
        throw error;
      }
    }
  };
}

async function transact(store, work, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await store.transaction(work); } catch (error) {
      if (!isTransactionConflict(error) || attempt === 3) throw error;
      const baseDelayMs = 10 * (2 ** attempt);
      await sleep(baseDelayMs + Math.floor(Math.random() * baseDelayMs));
    }
  }
}

module.exports = { createStore, transact };
