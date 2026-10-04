const COLLECTION = 'provider_rate_limits'

// Use explicit transactions: the SDK's implicit retry loop has no jitter/deadline.
function createCloudBaseStore(db) {
  return {
    async transaction(work) {
      const transaction = await db.startTransaction()
      try {
        const result = await work({
          async get(id) {
            // db must be configured with throwOnNotFound: false. Missing rows
            // are initialized via transactional set, never via a separate add.
            const result = await transaction.collection(COLLECTION).doc(id).get()
            return result.data
          },
          async set(id, data) {
            await transaction.collection(COLLECTION).doc(id).set({ data })
          }
        })
        await transaction.commit()
        return result
      } catch (error) {
        try { await transaction.rollback() } catch (_) { /* may already be aborted */ }
        throw error
      }
    }
  }
}

// wx-server-sdk wraps document errors in errCode/errMsg, but commit errors
// can retain CloudBase's symbolic code. Do not retry unrelated DB failures.
function isTransactionConflict(error) {
  return !!error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i.test(error.errMsg || ''))
}

module.exports = { createCloudBaseStore, isTransactionConflict }
