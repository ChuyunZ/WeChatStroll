// Development pacing defaults. Explore was verified at 5 QPS / 200 calls per day
// for the current development key on 2026-10-04; other API quotas remain separate.
function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name])
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid provider configuration: ${name}`)
  }
  return value
}

function loadLimits(env = process.env) {
  const service = (prefix, scope, defaultMinIntervalMs) => ({
    scope,
    minIntervalMs: integer(env, `${prefix}_MIN_INTERVAL_MS`, defaultMinIntervalMs, 1, 60000),
    maxQueueWaitMs: integer(env, `${prefix}_MAX_QUEUE_WAIT_MS`, 12000, 1, 60000),
    maxProviderAttempts: integer(env, `${prefix}_MAX_ATTEMPTS`, 2, 1, 4),
    cooldownBaseMs: integer(env, `${prefix}_COOLDOWN_MS`, 3000, 1, 60000)
  })
  return {
    walkingRoute: service('TENCENT_MAPS_WALKING', 'tencent:walking', 1500),
    nearbyPois: service('TENCENT_MAPS_POI', 'tencent:poi-explore', 200),
    keyMinIntervalMs: integer(env, 'TENCENT_MAPS_KEY_MIN_INTERVAL_MS', 0, 0, 60000),
    clockGuardMs: integer(env, 'TENCENT_MAPS_CLOCK_GUARD_MS', 100, 0, 5000),
    leaseStartWindowMs: integer(env, 'TENCENT_MAPS_LEASE_START_WINDOW_MS', 10000, 1000, 60000),
    leasePollMs: 100,
    bookkeepingWaitMs: 5000,
    requestTimeoutMs: integer(env, 'TENCENT_MAPS_REQUEST_TIMEOUT_MS', 10000, 1, 60000),
    transactionMaxAttempts: 6,
    transactionJitterMs: 40
  }
}

module.exports = { loadLimits }
