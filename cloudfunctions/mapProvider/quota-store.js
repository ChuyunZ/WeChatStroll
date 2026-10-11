const { isTransactionConflict } = require('./cloudbase-store')
const { fail } = require('./planning-token')
const COLLECTION = 'map_planning_quotas'
function createQuotaStore(db) {
  return {
    async transaction(work) {
      const tx = await db.startTransaction()
      try {
        const result = await work({
          get: async id => (await tx.collection(COLLECTION).doc(id).get()).data || null,
          set: (id, data) => tx.collection(COLLECTION).doc(id).set({ data })
        })
        await tx.commit()
        return result
      } catch (error) {
        try { await tx.rollback() } catch (_) { /* outcome can be unknown */ }
        throw error
      }
    }
  }
}
async function transact(store, work) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await store.transaction(work) } catch (error) {
      if (isTransactionConflict(error) && attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 5 + Math.floor(Math.random() * 25)))
        continue
      }
      if (error && /^(MAP_|INVALID_|CONFIG_)/.test(error.code || '')) throw error
      throw fail('MAP_QUOTA_UNAVAILABLE')
    }
  }
}
module.exports = { createQuotaStore, transact, COLLECTION }
