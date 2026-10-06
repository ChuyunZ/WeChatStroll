// Explicit transactions, including missing-document reads, fence concurrent starts.
function isTransactionConflict(error) {
  return !!error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i.test(error.errMsg || ''));
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
            return result.data || null;
          },
          async set(path, data) {
            const [collection, id] = path.split('/');
            await transaction.collection(collection).doc(id).set({ data });
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
      await sleep(10 * (attempt + 1) + Math.floor(Math.random() * 10));
    }
  }
}

module.exports = { createStore, transact };
