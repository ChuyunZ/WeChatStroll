const { isTransactionConflict } = require('./cloudbase-store')
const { fail } = require('./planning-token')
const COLLECTION = 'map_planning_quotas'

// Logging must never include dynamic IDs, owner hashes, payloads, coordinates,
// SDK error messages or stack traces. These fixed labels identify the failed
// storage stage without exposing any request or provider data.
function documentKind(id) {
  if (id === 'calendar') return 'calendar'
  if (/^day_\d+$/.test(id)) return 'day'
  if (/^request_[a-f0-9]{64}$/.test(id)) return 'request'
  if (/^attempt_[a-f0-9]{48}$/.test(id)) return 'attempt'
  return 'other'
}
function diagnostic(error, phase) {
  const code = error && error.code
  return {
    event: 'map_quota_transaction_failed',
    phase,
    kind: error && /^(MAP_|INVALID_|CONFIG_)/.test(code || '')
      ? 'application'
      : isTransactionConflict(error) ? 'transaction_conflict' : 'sdk_or_unknown',
    // Only symbolic, non-sensitive SDK codes. Never emit errMsg/message.
    ...(typeof code === 'string' && /^(?:DATABASE|DB|DOCUMENT)_[A-Z0-9_]{1,48}$/.test(code)
      ? { sdkCode: code } : {})
  }
}
function createQuotaStore(db, { log = () => {} } = {}) {
  return {
    async transaction(work) {
      let phase = 'start'
      let tx
      try {
        tx = await db.startTransaction()
      } catch (error) {
        log(diagnostic(error, phase))
        throw error
      }
      try {
        const result = await work({
          get: async id => {
            phase = 'read_' + documentKind(id)
            const response = await tx.collection(COLLECTION).doc(id).get()
            return response.data || null
          },
          set: (id, data) => {
            phase = 'write_' + documentKind(id)
            return tx.collection(COLLECTION).doc(id).set({ data })
          }
        })
        phase = 'commit'
        await tx.commit()
        return result
      } catch (error) {
        log(diagnostic(error, phase))
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
