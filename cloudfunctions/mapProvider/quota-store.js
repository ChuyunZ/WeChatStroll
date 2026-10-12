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
// Persist 64-character owner hashes and 48-character session IDs as values,
// not nested CloudBase database keys (which are limited to 32 characters).
// Keep the in-memory ledger model and full identities untouched; reject
// collisions/malformed storage mappings instead of granting more quota.
function compactKey(full, prefix, length) {
  if (typeof full !== 'string' || full.length !== length || !/^[a-f0-9]+$/.test(full)) {
    throw fail('MAP_QUOTA_UNAVAILABLE')
  }
  return prefix + full.slice(0, 31)
}
function encodeMap(value, prefix, length, identity) {
  const result = {}
  for (const [full, entry] of Object.entries(value || {})) {
    const short = compactKey(full, prefix, length)
    if (Object.prototype.hasOwnProperty.call(result, short) ||
        !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail('MAP_QUOTA_UNAVAILABLE')
    }
    result[short] = { ...entry, [identity]: full }
  }
  return result
}
function decodeMap(value, prefix, length, identity) {
  const result = {}
  for (const [short, entry] of Object.entries(value || {})) {
    const full = entry && entry[identity]
    if (short !== compactKey(full, prefix, length) ||
        Object.prototype.hasOwnProperty.call(result, full) ||
        typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail('MAP_QUOTA_UNAVAILABLE')
    }
    const { [identity]: ignoredIdentity, ...record } = entry
    result[full] = record
  }
  return result
}
function encodeDay(data) {
  return {
    ...data,
    users: encodeMap(data.users, 'u', 64, 'ownerHash'),
    sessions: encodeMap(data.sessions, 's', 48, 'sessionId'),
    creations: {
      ...data.creations,
      users: encodeMap(data.creations && data.creations.users, 'u', 64, 'ownerHash')
    }
  }
}
function decodeDay(data) {
  return {
    ...data,
    users: decodeMap(data.users, 'u', 64, 'ownerHash'),
    sessions: decodeMap(data.sessions, 's', 48, 'sessionId'),
    creations: {
      ...data.creations,
      users: decodeMap(data.creations && data.creations.users, 'u', 64, 'ownerHash')
    }
  }
}
function withoutDocumentId(data, id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('MAP_QUOTA_UNAVAILABLE')
  if (Object.prototype.hasOwnProperty.call(data, '_id') && data._id !== id) throw fail('MAP_QUOTA_UNAVAILABLE')
  const { _id, ...rest } = data
  return rest
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
            if (!response.data) return null
            const record = withoutDocumentId(response.data, id)
            return /^day_\d+$/.test(id) ? decodeDay(record) : record
          },
          set: (id, data) => {
            phase = 'write_' + documentKind(id)
            const clean = withoutDocumentId(data, id)
            return tx.collection(COLLECTION).doc(id).set({
              data: /^day_\d+$/.test(id) ? encodeDay(clean) : clean
            })
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
