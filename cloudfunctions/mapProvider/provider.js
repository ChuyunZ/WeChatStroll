const { rateLimited, quotaExhausted, gatewayFailed, infrastructureFailure } = require('./errors')
const AVAILABILITY_STATUSES = new Set([500, 510, 520, 530, 531, 600])

function createProvider({ limiter, limits, request, now = Date.now, log = () => {} }) {
  return function forOperation(operation) {
    const config = limits[operation]
    const scopes = [
      { id: 'tencent:key', minIntervalMs: limits.keyMinIntervalMs },
      { id: config.scope, minIntervalMs: config.minIntervalMs }
    ]
    return async function providerRequest(url, options) {
      const deadline = now() + config.maxQueueWaitMs
      for (let attempt = 1; attempt <= config.maxProviderAttempts; attempt++) {
        let execution
        try {
          execution = await limiter.execute(scopes, deadline, operation, ({ startedAtMs, waitMs }) => {
            log({ event: 'provider_start', operation, scope: config.scope, startedAtMs, waitMs, attempt })
            return request(url, { ...options, timeout: limits.requestTimeoutMs })
          })
        } catch (error) {
          log({ event: 'acquisition_failed', operation })
          throw infrastructureFailure(error)
        }
        // In-flight completion and start accounting may outlive admission's deadline.
        const outcome = await execution.outcome
        const response = outcome.value
        const error = outcome.error
        const data = error ? error.response && error.response.data : response && response.data
        const status = data && data.status
        if (status !== 120) {
          if (!execution.recorded) throw infrastructureFailure(execution.recordingError)
          if (status === 121) throw quotaExhausted() // No retry or short fake cooldown.
          if (AVAILABILITY_STATUSES.has(status)) throw gatewayFailed()
          if (error) {
            log({ event: 'provider_failed', operation, attempt })
            throw error
          }
          return response
        }
        // Publish key-wide feedback even if start accounting failed.
        const scope = 'tencent:key'
        log({ event: 'rate_limited', operation, scope, attempt, status })
        try {
          await limiter.cooldown(scope, config.cooldownBaseMs * attempt, operation)
        } catch (error) {
          log({ event: 'cooldown_failed', operation, scope })
          throw infrastructureFailure(error)
        }
        if (!execution.recorded) throw infrastructureFailure(execution.recordingError)
        if (attempt === config.maxProviderAttempts) throw rateLimited()
        // Every retry reacquires both scopes within the original deadline.
      }
      throw gatewayFailed()
    }
  }
}

module.exports = { createProvider }
