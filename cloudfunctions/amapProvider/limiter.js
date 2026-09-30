const { randomBytes } = require('crypto')
const { isTransactionConflict } = require('./cloudbase-store')

function busy() {
  return Object.assign(new Error('Provider is temporarily busy'), { code: 'AMAP_RATE_LIMITED' })
}

function stateOf(data) {
  const state = data || { nextAllowedAtMs: 0, cooldownUntilMs: 0 }
  // Old limiter documents are valid without lease fields; upgrade on write.
  const lease = {
    leaseOwner: state.leaseOwner === undefined ? null : state.leaseOwner,
    leaseStartBeforeMs: state.leaseStartBeforeMs === undefined ? 0 : state.leaseStartBeforeMs,
    leaseUntilMs: state.leaseUntilMs === undefined ? 0 : state.leaseUntilMs
  }
  for (const value of [state.nextAllowedAtMs, state.cooldownUntilMs, lease.leaseStartBeforeMs, lease.leaseUntilMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw busy()
  }
  if (lease.leaseOwner !== null && (typeof lease.leaseOwner !== 'string' || !lease.leaseOwner ||
    lease.leaseUntilMs <= lease.leaseStartBeforeMs)) throw busy()
  if (lease.leaseOwner === null && (lease.leaseUntilMs || lease.leaseStartBeforeMs)) throw busy()
  return { nextAllowedAtMs: state.nextAllowedAtMs, cooldownUntilMs: state.cooldownUntilMs, ...lease }
}

const clearedLease = { leaseOwner: null, leaseStartBeforeMs: 0, leaseUntilMs: 0 }

function createLimiter({ store, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random, ownerId = () => randomBytes(16).toString('hex'),
  log = () => {}, clockGuardMs = 100, leaseStartWindowMs = 10000,
  leasePollMs = 100, bookkeepingWaitMs = 5000,
  transactionMaxAttempts = 6, transactionJitterMs = 40 }) {
  function queueExpired(operation, startedAt) {
    log({ event: 'queue_deadline_exceeded', operation, waitMs: now() - startedAt })
    return busy()
  }

  async function transact(work, deadline, operation) {
    const startedAt = now()
    for (let attempt = 1; attempt <= transactionMaxAttempts; attempt++) {
      if (now() > deadline) throw queueExpired(operation, startedAt)
      try {
        return await store.transaction(work)
      } catch (error) {
        if (!isTransactionConflict(error)) throw error
        log({ event: 'transaction_conflict', operation, transactionAttempt: attempt })
        if (attempt === transactionMaxAttempts) throw busy()
        const delay = 1 + Math.floor(random() * transactionJitterMs)
        if (now() + delay > deadline) throw queueExpired(operation, startedAt)
        await sleep(delay) // The store has already rolled back.
      }
    }
  }

  async function readScopes(tx, scopes) {
    const states = []
    for (const scope of scopes) states.push(stateOf(await tx.get(scope.id)))
    return states
  }

  function pacingBlockedUntil(scopes, states) {
    return Math.max(0, ...states.map((state, i) => Math.max(state.cooldownUntilMs,
      scopes[i].minIntervalMs > 0 ? state.nextAllowedAtMs : 0)))
  }

  async function acquire(scopes, deadline, operation) {
    const startedAt = now()
    while (now() <= deadline) {
      const owner = ownerId()
      const result = await transact(async tx => {
        const states = await readScopes(tx, scopes)
        const time = now()
        if (time > deadline) throw queueExpired(operation, startedAt)
        const blockedUntil = pacingBlockedUntil(scopes, states)
        const leaseBlocked = states.some(state => state.leaseOwner && state.leaseUntilMs > time)
        if (blockedUntil > time || leaseBlocked) return { blockedUntil, leaseBlocked }

        // A crash after the latest permitted start must still leave a complete
        // pacing interval before anyone can recover the lease. This tail is NOT
        // available for starting HTTP. It includes backend clock-skew allowance.
        const startBeforeMs = time + leaseStartWindowMs
        const leaseUntilMs = startBeforeMs + Math.max(...scopes.map(scope => scope.minIntervalMs)) + 2 * clockGuardMs
        const recovered = []
        for (let i = 0; i < scopes.length; i++) {
          const scope = scopes[i]
          if (states[i].leaseOwner) recovered.push(scope.id)
          await tx.set(scope.id, {
            ...states[i],
            // Unpaced key participates in cooldown fencing, but owns no lease.
            ...(scope.minIntervalMs > 0
              ? { leaseOwner: owner, leaseStartBeforeMs: startBeforeMs, leaseUntilMs }
              : clearedLease),
            updatedAtMs: time
          })
        }
        return { owner, scopes, startBeforeMs, leaseUntilMs, recovered }
      }, deadline, operation)
      if (result.owner) {
        for (const scope of result.recovered) log({ event: 'lease_recovered', operation, scope })
        return result
      }
      if (result.blockedUntil > deadline || now() >= deadline) break
      if (result.leaseBlocked) log({ event: 'lease_wait', operation })
      // A live lease can be released well before expiry. Poll, do not reserve a
      // future slot or reject just because lease expiry exceeds the queue budget.
      const delay = result.leaseBlocked ? leasePollMs : Math.max(1, result.blockedUntil - now())
      await sleep(Math.min(delay, deadline - now()))
    }
    throw queueExpired(operation, startedAt)
  }

  async function clearOwned(tx, lease, states) {
    for (let i = 0; i < lease.scopes.length; i++) {
      if (states[i].leaseOwner === lease.owner) {
        await tx.set(lease.scopes[i].id, { ...states[i], ...clearedLease, updatedAtMs: now() })
      }
    }
  }

  async function confirm(lease, deadline, operation) {
    return transact(async tx => {
      const states = await readScopes(tx, lease.scopes)
      const time = now()
      const ownsAll = lease.scopes.every((scope, i) => scope.minIntervalMs === 0 ||
        states[i].leaseOwner === lease.owner)
      if (!ownsAll || time > lease.startBeforeMs || time > deadline ||
        pacingBlockedUntil(lease.scopes, states) > time) {
        // Cooldown may have arrived while the acquisition commit was returning.
        // Give up the lease rather than hold a reservation through that cooldown.
        await clearOwned(tx, lease, states)
        return false
      }
      // Fence concurrent cooldown publication (including an unpaced key) under
      // snapshot isolation. A later cooldown cannot revoke already admitted HTTP.
      for (let i = 0; i < lease.scopes.length; i++) {
        await tx.set(lease.scopes[i].id, { ...states[i], updatedAtMs: time })
      }
      return true
    }, deadline, operation)
  }

  async function recordStart(lease, startedAtMs, operation) {
    return transact(async tx => {
      const states = await readScopes(tx, lease.scopes)
      if (!lease.scopes.every((scope, i) => scope.minIntervalMs === 0 ||
        states[i].leaseOwner === lease.owner)) throw busy()
      for (let i = 0; i < lease.scopes.length; i++) {
        const scope = lease.scopes[i]
        if (scope.minIntervalMs === 0) continue
        await tx.set(scope.id, { ...states[i], ...clearedLease,
          nextAllowedAtMs: Math.max(states[i].nextAllowedAtMs, startedAtMs + scope.minIntervalMs + 2 * clockGuardMs),
          updatedAtMs: now() })
      }
    }, now() + bookkeepingWaitMs, operation)
  }

  async function execute(scopes, deadline, operation, startRequest) {
    const queuedAt = now()
    while (now() <= deadline) {
      const lease = await acquire(scopes, deadline, operation)
      if (!await confirm(lease, deadline, operation)) continue
      const startedAtMs = now()
      // Only a genuinely expired lease/queue forbids start, not normal commit
      // latency. The safety tail ensures even a crashed owner cannot start late.
      if (startedAtMs > deadline || startedAtMs > lease.startBeforeMs) {
        log({ event: 'lease_start_expired', operation })
        // No HTTP was sent. An ownership-checked release is safe; on storage
        // failure leave the lease for bounded recovery instead of starting.
        await transact(async tx => clearOwned(tx, lease, await readScopes(tx, scopes)),
          now() + bookkeepingWaitMs, operation)
        if (startedAtMs > deadline) throw queueExpired(operation, queuedAt)
        continue
      }

      // Invoke HTTP synchronously beside the timestamp, before any DB await.
      // Observe rejection immediately while the start record is being persisted.
      let response
      try { response = Promise.resolve(startRequest({ startedAtMs, waitMs: startedAtMs - queuedAt })) }
      catch (error) { response = Promise.reject(error) }
      const outcome = response.then(value => ({ value }), error => ({ error }))
      let recorded = true
      try { await recordStart(lease, startedAtMs, operation) }
      catch (_) {
        recorded = false
        log({ event: 'start_record_failed', operation })
        // Never blindly unlock after HTTP. The safety tail protects crash/failure
        // recovery even if neither start time nor response can be persisted.
      }
      return { outcome, recorded }
    }
    throw queueExpired(operation, queuedAt)
  }

  async function cooldown(scope, durationMs, operation) {
    const proposed = now() + durationMs + clockGuardMs
    const cooldownUntilMs = await transact(async tx => {
      const state = stateOf(await tx.get(scope))
      const until = Math.max(state.cooldownUntilMs, proposed)
      await tx.set(scope, { ...state, cooldownUntilMs: until, updatedAtMs: now() })
      return until
    }, now() + bookkeepingWaitMs, operation)
    log({ event: 'shared_cooldown', operation, scope, cooldownUntilMs,
      cooldownMs: Math.max(0, cooldownUntilMs - now()) })
  }

  return { acquire, execute, cooldown }
}

module.exports = { createLimiter, busy }
