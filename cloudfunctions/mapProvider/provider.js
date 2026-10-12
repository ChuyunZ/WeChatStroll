const { rateLimited, quotaExhausted, gatewayFailed, infrastructureFailure } = require('./errors')
const AVAILABILITY_STATUSES = new Set([500, 510, 520, 530, 531, 600])
// Key/origin/signature/authorization failures are provider configuration failures,
// not evidence that a particular walking edge is unreachable.
const CONFIGURATION_STATUSES = new Set([110, 111, 112, 113, 190, 199, 311])

function createProvider({ limiter, limits, request, admission, quotaOffsetMinutes, now = Date.now, log = () => {} }) {
  // When supplied by the authenticated gateway, the offset is the same value
  // used by the shared quota calendar. The provider never trusts client input.
  if (quotaOffsetMinutes !== undefined && (!Number.isInteger(quotaOffsetMinutes) ||
    Math.abs(quotaOffsetMinutes) > 840)) throw gatewayFailed()
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
          }, admission)
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
          if (status === 121) {
            // Tencent's official day boundary is unknown. Block this Key's
            // physical starts across instances until the NEXT internal day;
            // a new start then probes normal Tencent availability. A 121 on
            // that probe renews the block. Never retry the current request.
            if (quotaOffsetMinutes !== undefined) {
              const time = now()
              const offsetMs = quotaOffsetMinutes * 60000
              const nextResetMs = (Math.floor((time + offsetMs) / 86400000) + 1) * 86400000 - offsetMs
              try {
                await limiter.cooldown('tencent:key', Math.max(0, nextResetMs - time), operation)
              } catch (error) {
                log({ event: 'daily_quota_block_failed', operation })
                throw infrastructureFailure(error)
              }
              log({ event: 'daily_quota_blocked', operation, untilMs: nextResetMs })
            }
            throw quotaExhausted()
          }
          if (CONFIGURATION_STATUSES.has(status)) {
            log({ event: 'provider_configuration_failed', operation, status })
            throw gatewayFailed()
          }
          if (AVAILABILITY_STATUSES.has(status)) throw gatewayFailed()
          if (error) {
            log({ event: 'provider_failed', operation, attempt })
            // HTTP failures without a recognized Tencent business status are
            // gateway failures, never evidence that an edge is unreachable.
            throw gatewayFailed()
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
