// Pure ingress metadata retention contract packaged *inside* the separate
// cleanup cloud function. No imports from other cloud function directories.
const DAY = 86400000
const WINDOW_MS = 60000
const POLICIES = Object.freeze({
  nearbyPois: true, walkingRoute: true, quotaStatus: true, closePlanning: true
})

const INGRESS_RETENTION_MS = 7 * DAY
const MAX_BATCH = 25
const ID_PATTERN = /^ingress_[a-f0-9]{24}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const LEASE_PATTERN = /^[a-f0-9]{32}$/
const OPERATIONS = Object.keys(POLICIES)

function canDeleteIngressRecord({ id, data, now } = {}) {
  if (!ID_PATTERN.test(id) || !data || typeof data !== 'object' || Array.isArray(data) ||
      !Number.isSafeInteger(now) || now < 0 ||
      typeof data.ownerHash !== 'string' || !HASH_PATTERN.test(data.ownerHash) ||
      id !== 'ingress_' + data.ownerHash.slice(0, 24) ||
      (Object.prototype.hasOwnProperty.call(data, '_id') && data._id !== id) ||
      !Number.isSafeInteger(data.windowStartMs) || data.windowStartMs < 0 ||
      !Number.isSafeInteger(data.updatedAtMs) || data.updatedAtMs < data.windowStartMs ||
      data.updatedAtMs > now || data.windowStartMs > now ||
      !data.counts || typeof data.counts !== 'object' || Array.isArray(data.counts) ||
      Object.keys(data.counts).length !== OPERATIONS.length ||
      !OPERATIONS.every(op => Number.isSafeInteger(data.counts[op]) && data.counts[op] >= 0) ||
      !Array.isArray(data.leases) || data.leases.length > 40) return false

  let latestActivity = Math.max(data.updatedAtMs, data.windowStartMs + WINDOW_MS)
  const seen = new Set()
  for (const lease of data.leases) {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease) ||
        !LEASE_PATTERN.test(lease.id) || seen.has(lease.id) ||
        !Object.prototype.hasOwnProperty.call(POLICIES, lease.operation) ||
        !Number.isSafeInteger(lease.expiresAtMs) || lease.expiresAtMs < 0 ||
        // Leases are at most 90 seconds from admission, but older windows
        // can retain unexpired leases; only time and validity matter here.
        lease.expiresAtMs > now) return false
    seen.add(lease.id)
    latestActivity = Math.max(latestActivity, lease.expiresAtMs)
  }
  // Never delete active or recently used limit state. The 7-day inactivity
  // window is much longer than the 60-second count/90-second lease lifetime.
  return now - latestActivity >= INGRESS_RETENTION_MS
}

// The caller MUST enumerate at most MAX_BATCH candidate IDs through a trusted
// admin-only, bounded scan. transact(work) MUST provide an atomic/versioned
// document read+delete transaction with tx.get(id), tx.delete(id).
// No destructive operation is available without an explicit approval string.
// Reports contain aggregate counts only; no hashed user identities.
async function sweepIngressCandidates({
  candidateIds, transact, now = Date.now, dryRun = true, approval
} = {}) {
  if (!Array.isArray(candidateIds) || candidateIds.length > MAX_BATCH ||
      !candidateIds.every(id => typeof id === 'string' && ID_PATTERN.test(id)) ||
      new Set(candidateIds).size !== candidateIds.length ||
      typeof transact !== 'function' || typeof now !== 'function' ||
      typeof dryRun !== 'boolean') throw new Error('Invalid admin ingress retention batch')
  if (!dryRun && approval !== 'DELETE_EXPIRED_INGRESS') {
    throw new Error('Destructive ingress retention requires explicit admin approval')
  }
  const summary = { scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 0, dryRun }
  for (const id of candidateIds) {
    summary.scanned++
    try {
      // Each decision is based on a fresh read inside the SAME transaction as
      // a potential delete. A competing acquire/release must conflict.
      const outcome = await transact(async tx => {
        const document = await tx.get(id)
        if (!canDeleteIngressRecord({ id, data: document, now: now() })) return 'skipped'
        if (dryRun) return 'eligible'
        await tx.delete(id)
        return 'deleted'
      })
      if (outcome === 'eligible') summary.eligible++
      else if (outcome === 'deleted') { summary.eligible++; summary.deleted++ }
      else summary.skipped++
    } catch (_) {
      // Unknown commit outcomes: never claim deletion succeeded. Retrying
      // in a later operator run is safe after a new transactional read.
      summary.failed++
    }
  }
  return summary
}

module.exports = { canDeleteIngressRecord, sweepIngressCandidates, INGRESS_RETENTION_MS, MAX_BATCH, WINDOW_MS, OPERATIONS }
