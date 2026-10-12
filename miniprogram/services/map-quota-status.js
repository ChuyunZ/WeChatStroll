const { callCloudFunction } = require('./cloud-function-client')

// No local balance arithmetic: live quotas depend on server-side user/global
// spending, currently active reservations, retry calls and creation budgets.
async function getMapQuotaStatus({ call = callCloudFunction } = {}) {
  const result = await call('mapProvider', { action: 'quotaStatus' }, {
    fallbackCode: 'MAP_QUOTA_UNAVAILABLE',
    fallbackMessage: 'Planning quota status is temporarily unavailable.'
  })
  const status = result && result.quota
  if (!status || !Number.isSafeInteger(status.remainingPlanningSessions) ||
      status.remainingPlanningSessions < 0 || status.remainingPlanningSessions > 3 ||
      !Number.isSafeInteger(status.resetAtMs) || status.resetAtMs < 0) {
    throw Object.assign(new Error('Invalid planning quota status'), { code: 'MAP_QUOTA_UNAVAILABLE' })
  }
  return { remainingPlanningSessions: status.remainingPlanningSessions, resetAtMs: status.resetAtMs }
}

function quotaStatusText(status) {
  if (!status) return '今日规划额度暂不可查询'
  return `今日预计还可发起 ${status.remainingPlanningSessions} 次完整规划 · 每天 09:00 更新`
}
module.exports = { getMapQuotaStatus, quotaStatusText }
