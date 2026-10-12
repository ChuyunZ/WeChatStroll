// Pure operator policy, NOT a public cloud action or an installed cleanup job.
const { DAY } = require('../cloudfunctions/mapProvider/quota')
const { canDeleteIngressRecord } = require('./issue107-ingress-retention.cjs')
function canDeleteQuotaRecord({ id, data, calendar, now }) {
  if (!calendar || !Number.isSafeInteger(now) || !Number.isSafeInteger(calendar.activeFromMs) ||
      !Number.isInteger(calendar.offsetMinutes) || Math.abs(calendar.offsetMinutes) > 840 ||
      !Number.isSafeInteger(calendar.latestDay) || now < calendar.activeFromMs) return false
  const offset = calendar.offsetMinutes * 60000
  const today = Math.floor((now + offset) / DAY)
  if (calendar.latestDay > today) return false
  if (typeof id === 'string' && id.startsWith('ingress_')) {
    return canDeleteIngressRecord({ id, data, now })
  }
  if (/^day_\d+$/.test(id)) {
    const day = Number(id.slice(4))
    return Number.isSafeInteger(day) && day < today - 3 && day < calendar.latestDay
  }
  if (!/^(request_[a-f0-9]{64}|attempt_[a-f0-9]{48})$/.test(id) || !data) return false
  // Full next-day grace for late completions/refunds, independent of a corrupted
  // early expires field. Never delete current-day dedup or reset any counters.
  return Number.isSafeInteger(data.day) && data.day >= 0 && data.day < today &&
    Number.isSafeInteger(data.expires) && data.expires >= (data.day + 2) * DAY - offset &&
    data.expires <= now
}
module.exports = { canDeleteQuotaRecord }
