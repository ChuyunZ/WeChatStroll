const PROVIDER_CODES = new Set([
  'PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isProviderCode = code => PROVIDER_CODES.has(code)
const providerBusy = () => Object.assign(new Error('Provider is temporarily busy'), { code: 'PROVIDER_BUSY' })
const gatewayFailed = () => Object.assign(new Error('Provider service is temporarily unavailable'), { code: 'PROVIDER_GATEWAY_FAILED' })
const rateLimited = () => Object.assign(new Error('Provider rate limit exceeded'), { code: 'PROVIDER_RATE_LIMITED' })
const quotaExhausted = () => Object.assign(new Error('Provider quota exhausted'), { code: 'PROVIDER_QUOTA_EXHAUSTED' })
// Only admission/contention errors survive infrastructure normalization.
const infrastructureFailure = error => error && error.code === 'PROVIDER_BUSY' ? providerBusy() : gatewayFailed()
module.exports = { isProviderCode, providerBusy, gatewayFailed, rateLimited, quotaExhausted, infrastructureFailure }
