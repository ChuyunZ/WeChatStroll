const { rateLimited, gatewayFailed, infrastructureFailure } = require('./errors')
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
        } catch (error) {
          log({ event: 'acquisition_failed', operation })
          throw infrastructureFailure(error) // Fail closed without claiming AMap QPS feedback.
        }
        // The queue deadline controls new starts, not completion of in-flight
        // HTTP or its start record. Still publish QPS feedback if recording failed.
        const outcome = await execution.outcome
        const response = outcome.value
        const error = outcome.error
        const infocode = rateLimitCode(error ? error.response && error.response.data : response && response.data)
        if (!infocode) {
          if (!execution.recorded) throw infrastructureFailure(execution.recordingError)
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
        } catch (error) {
          log({ event: 'cooldown_failed', operation, scope })
          throw infrastructureFailure(error) // Never retry without successfully publishing feedback.
        }
        if (!execution.recorded) throw infrastructureFailure(execution.recordingError)
        if (attempt === config.maxProviderAttempts) throw rateLimited()
        // Every retry reacquires all scopes; no direct HTTP retry path.
      }
      throw gatewayFailed()
    }
  }
}

module.exports = { createProvider }
