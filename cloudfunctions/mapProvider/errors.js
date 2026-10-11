const PROVIDER_CODES = new Set([
  'MAP_UNAUTHORIZED', 'MAP_SESSION_INVALID', 'MAP_SESSION_EXPIRED', 'MAP_REQUEST_INVALID',
  'MAP_EXECUTION_UNKNOWN', 'MAP_USER_QUOTA_EXHAUSTED', 'MAP_GLOBAL_QUOTA_EXHAUSTED',
  'MAP_QUOTA_UNAVAILABLE', 'MAP_QUOTA_NOT_READY',
  'PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isProviderCode = code => PROVIDER_CODES.has(code)
const providerBusy = () => Object.assign(new Error('Provider is temporarily busy'), { code: 'PROVIDER_BUSY' })
const gatewayFailed = () => Object.assign(new Error('Provider service is temporarily unavailable'), { code: 'PROVIDER_GATEWAY_FAILED' })
const rateLimited = () => Object.assign(new Error('Provider rate limit exceeded'), { code: 'PROVIDER_RATE_LIMITED' })
const quotaExhausted = () => Object.assign(new Error('Provider quota exhausted'), { code: 'PROVIDER_QUOTA_EXHAUSTED' })
// Only admission/contention errors survive infrastructure normalization.
const infrastructureFailure = error => error && isProviderCode(error.code) ? error : gatewayFailed()
module.exports = { isProviderCode, providerBusy, gatewayFailed, rateLimited, quotaExhausted, infrastructureFailure }
