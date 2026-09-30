const TEMPORARY_PROVIDER_CODES = new Set([
  'AMAP_RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isTemporaryProviderCode = code => TEMPORARY_PROVIDER_CODES.has(code)
module.exports = { isTemporaryProviderCode }
