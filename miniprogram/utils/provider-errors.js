const PROVIDER_UNAVAILABLE_CODES = new Set([
  'PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isProviderUnavailableCode = code => PROVIDER_UNAVAILABLE_CODES.has(code)
module.exports = { isProviderUnavailableCode }
