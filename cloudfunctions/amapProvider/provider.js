const { busy } = require('./limiter')
const QPS_CODES = new Set(['10019', '10020', '10021', '10022', '10023'])

function rateLimitCode(data) {
  const code = String(data && data.infocode)
  return QPS_CODES.has(code) ? code : null
}

function createProvider({ limiter, limits, request, now = Date.now, log = () => {} }) {
  // One context per cloud invocation; POI categories and retries share deadline.
  return function forOperation(operation) {
    const config = limits[operation]
    const deadline = now() + config.maxQueueWaitMs
    const scopes = [
      { id: 'amap:key', minIntervalMs: limits.keyMinIntervalMs },
      { id: config.scope, minIntervalMs: config.minIntervalMs }
    ]
    return async function providerRequest(url, options) {
      for (let attempt = 1; attempt <= config.maxProviderAttempts; attempt++) {
        let execution
        try {
          execution = await limiter.execute(scopes, deadline, operation, ({ startedAtMs, waitMs }) => {
            log({ event: 'provider_start', operation, scope: config.scope, startedAtMs, waitMs, attempt })
            return request(url, { ...options, timeout: limits.requestTimeoutMs })
          })
        } catch (_) {
          log({ event: 'acquisition_failed', operation })
          throw busy() // Fail closed on DB outages, corrupt state and contention.
        }
        // The queue deadline controls new starts, not completion of in-flight
        // HTTP or its start record. Still publish QPS feedback if recording failed.
        const outcome = await execution.outcome
        const response = outcome.value
        const error = outcome.error
        const infocode = rateLimitCode(error ? error.response && error.response.data : response && response.data)
        if (!infocode) {
          if (!execution.recorded) throw busy()
          if (error) {
            log({ event: 'provider_failed', operation, attempt })
            throw error
          }
          return response
        }
        const scope = infocode === '10023' ? 'amap:key' : config.scope
        log({ event: 'rate_limited', operation, scope, attempt, infocode })
        try {
          await limiter.cooldown(scope, config.cooldownBaseMs * attempt, operation)
        } catch (_) {
          log({ event: 'cooldown_failed', operation, scope })
          throw busy() // Never retry without successfully publishing feedback.
        }
        if (!execution.recorded || attempt === config.maxProviderAttempts) throw busy()
        // Every retry reacquires all scopes; no direct HTTP retry path.
      }
      throw busy()
    }
  }
}

module.exports = { createProvider }
