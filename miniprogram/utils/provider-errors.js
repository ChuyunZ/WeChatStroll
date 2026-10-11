const PROVIDER_UNAVAILABLE_CODES = new Set([
  'MAP_UNAUTHORIZED', 'MAP_SESSION_INVALID', 'MAP_SESSION_EXPIRED', 'MAP_REQUEST_INVALID',
  'MAP_EXECUTION_UNKNOWN', 'MAP_USER_QUOTA_EXHAUSTED', 'MAP_GLOBAL_QUOTA_EXHAUSTED',
  'MAP_QUOTA_UNAVAILABLE', 'MAP_QUOTA_NOT_READY',
  'PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'
])
const isProviderUnavailableCode = code => PROVIDER_UNAVAILABLE_CODES.has(code)
const MAP_MESSAGES = {
  MAP_UNAUTHORIZED: '请重新进入小程序后再规划',
  MAP_SESSION_INVALID: '规划授权已失效，请重新规划',
  MAP_SESSION_EXPIRED: '规划已过期，已有路线仍可使用',
  MAP_REQUEST_INVALID: '规划请求无效，请重新进入页面',
  MAP_EXECUTION_UNKNOWN: '请求结果未确认，请勿重复提交',
  MAP_USER_QUOTA_EXHAUSTED: '你今天的规划额度已用完',
  MAP_GLOBAL_QUOTA_EXHAUSTED: '今天的规划服务额度已用完',
  MAP_QUOTA_UNAVAILABLE: '规划额度服务暂时不可用',
  MAP_QUOTA_NOT_READY: '规划服务尚未开放'
}
function mapErrorMessage(error) {
  const values = typeof error === 'string' ? [error] : error &&
    [error.code, error.error, error.causeCode, error.failedSegment && error.failedSegment.error,
      error.failedSegment && error.failedSegment.causeCode] || []
  return values.map(code => MAP_MESSAGES[code]).find(Boolean) || null
}
module.exports = { isProviderUnavailableCode, mapErrorMessage }
