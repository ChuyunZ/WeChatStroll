const TEMPORARY_PROVIDER_CODES = new Set([
  'AMAP_RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isTemporaryProviderCode = code => TEMPORARY_PROVIDER_CODES.has(code)
const providerBusy = () => Object.assign(new Error('Provider is temporarily busy'), { code: 'PROVIDER_BUSY' })
const gatewayFailed = () => Object.assign(new Error('Provider service is temporarily unavailable'), { code: 'PROVIDER_GATEWAY_FAILED' })
const rateLimited = () => Object.assign(new Error('Provider rate limit exceeded'), { code: 'AMAP_RATE_LIMITED' })
// Only admission/contention errors survive infrastructure normalization.
const infrastructureFailure = error => error && error.code === 'PROVIDER_BUSY' ? providerBusy() : gatewayFailed()
module.exports = { isTemporaryProviderCode, providerBusy, gatewayFailed, rateLimited, infrastructureFailure }
