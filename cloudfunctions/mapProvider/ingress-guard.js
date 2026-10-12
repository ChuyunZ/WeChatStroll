const { randomBytes } = require('crypto')
const { transact } = require('./quota-store')
const { fail } = require('./planning-token')

// Defense in depth, NOT a CloudBase-edge QPS limit. Each admission uses one
// shared DB transaction, so resource-level admission controls remain required.
const WINDOW_MS = 60000
const LEASE_MS = 90000
const POLICIES = Object.freeze({
  nearbyPois: Object.freeze({ perMinute: 6, concurrent: 3 }),
  walkingRoute: Object.freeze({ perMinute: 180, concurrent: 24 }),
  quotaStatus: Object.freeze({ perMinute: 30, concurrent: 4 }),
  closePlanning: Object.freeze({ perMinute: 20, concurrent: 4 })
})
const MAX_DENIAL_CACHE = 2048

function documentId(owner) {
  if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) throw fail('MAP_UNAUTHORIZED')
  // 112-bit deterministic lookup with the complete identity verified in data.
  return 'ingress_' + owner.slice(0, 28)
}
function emptyCounts() {
  return { nearbyPois: 0, walkingRoute: 0, quotaStatus: 0, closePlanning: 0 }
}
function validCounts(counts) {
  return counts && !Array.isArray(counts) &&
    Object.keys(POLICIES).every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0)
}
function validateLedger(state, owner) {
  if (!state || state.ownerHash !== owner ||
      !Number.isSafeInteger(state.windowStartMs) || state.windowStartMs < 0 ||
      !Number.isSafeInteger(state.updatedAtMs) || state.updatedAtMs < 0 ||
      !validCounts(state.counts) || !Array.isArray(state.leases) ||
      state.leases.length > 40) throw fail('MAP_QUOTA_UNAVAILABLE')
  for (const lease of state.leases) {
    if (!lease || typeof lease.id !== 'string' || !/^[a-f0-9]{32}$/.test(lease.id) ||
        !POLICIES[lease.operation] || !Number.isSafeInteger(lease.expiresAtMs) ||
        lease.expiresAtMs < 0) throw fail('MAP_QUOTA_UNAVAILABLE')
  }
}
function createIngressGuard({ store, now = Date.now, nonce = () => randomBytes(16).toString('hex') }) {
  // Once a rate limit is established for this warm instance, skip its database
  // entirely for that owner/action/window. Other instances still enforce the
  // authoritative transactional ledger.
  const rejectedUntil = new Map()
  function cooldownKey(owner, operation) { return owner + ':' + operation }
  function rejectCached(owner, operation, time) {
    const key = cooldownKey(owner, operation)
    const until = rejectedUntil.get(key)
    if (until && time < until) throw fail('MAP_REQUEST_LIMITED')
    if (until) rejectedUntil.delete(key)
  }
  function rememberRateDenial(owner, operation, until) {
    const key = cooldownKey(owner, operation)
    if (rejectedUntil.size >= MAX_DENIAL_CACHE && !rejectedUntil.has(key)) {
      rejectedUntil.delete(rejectedUntil.keys().next().value)
    }
    rejectedUntil.set(key, until)
  }

  async function acquire(owner, operation) {
    const policy = POLICIES[operation]
    if (!policy) throw fail('MAP_REQUEST_INVALID')
    const id = documentId(owner)
    rejectCached(owner, operation, now())
    const leaseId = nonce()
    if (typeof leaseId !== 'string' || !/^[a-f0-9]{32}$/.test(leaseId)) throw fail('MAP_QUOTA_UNAVAILABLE')
    let deniedUntil = null
    try {
      await transact(store, async tx => {
        const time = now()
        let state = await tx.get(id)
        if (!state) {
          state = { ownerHash: owner, windowStartMs: time, updatedAtMs: time,
            counts: emptyCounts(), leases: [] }
        } else validateLedger(state, owner)
        // A clock rollback or a damaged future bucket must not reset limits.
        if (time < state.windowStartMs) throw fail('MAP_QUOTA_UNAVAILABLE')
        const newWindow = time - state.windowStartMs >= WINDOW_MS
        const active = state.leases.filter(l => l.expiresAtMs > time)
        const counts = newWindow ? emptyCounts() : { ...state.counts }
        if (counts[operation] >= policy.perMinute) {
          deniedUntil = state.windowStartMs + WINDOW_MS
          throw fail('MAP_REQUEST_LIMITED')
        }
        if (active.filter(l => l.operation === operation).length >= policy.concurrent) {
          throw fail('MAP_REQUEST_LIMITED')
        }
        counts[operation]++
        await tx.set(id, { ownerHash: owner, windowStartMs: newWindow ? time : state.windowStartMs,
          updatedAtMs: time, counts,
          leases: [...active, { id: leaseId, operation, expiresAtMs: time + LEASE_MS }] })
      })
    } catch (error) {
      if (error && error.code === 'MAP_REQUEST_LIMITED' && deniedUntil && now() < deniedUntil) {
        rememberRateDenial(owner, operation, deniedUntil)
      }
      throw error
    }
    // Loss of a release acknowledgement is harmless: the lease expires. Never
    // downgrade an already successful business result to a release error.
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await transact(store, async tx => {
          const state = await tx.get(id)
          if (!state) return
          validateLedger(state, owner)
          const leases = state.leases.filter(l => l.id !== leaseId)
          if (leases.length !== state.leases.length) {
            await tx.set(id, { ...state, leases, updatedAtMs: now() })
          }
        })
      } catch (_) { /* recovered by the 90-second lease expiry */ }
    }
  }
  return { acquire }
}
module.exports = { createIngressGuard, POLICIES, WINDOW_MS, LEASE_MS }
