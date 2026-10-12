const cloud = require('wx-server-sdk')
const { runCleanup } = require('./service')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const NAME = 'dailyIngressRetention'
function isExpectedTimer(event, time) {
  if (!event || event.Type !== 'Timer' || event.TriggerName !== NAME ||
      typeof event.Time !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(event.Time) ||
      !Number.isSafeInteger(time)) return false
  const scheduled = Date.parse(event.Time)
  return Number.isFinite(scheduled) && scheduled <= time + 120000 &&
    time - scheduled <= 6 * 60 * 60 * 1000
}

// Timer event fields are spoofable: ONLY a platform function security rule
// mapQuotaCleanup.invoke=false is an authorization boundary. The operator
// must verify that rule before enabling dry-run or deletion.
function createHandler({ cloudSdk = cloud, env = process.env, now = Date.now,
  log = record => console.info('[Map Quota Retention]', record) } = {}) {
  return async event => {
    const mode = env.MAP_QUOTA_CLEANUP_MODE || 'disabled'
    if (!['dry-run', 'delete'].includes(mode)) {
      return { success: false, error: { code: 'CLEANUP_DISABLED' } }
    }
    const time = now()
    if (!isExpectedTimer(event, time)) {
      return { success: false, error: { code: 'CLEANUP_UNAUTHORIZED' } }
    }
    if (mode === 'delete' &&
        env.MAP_QUOTA_CLEANUP_DELETE_APPROVED !== 'I_ACCEPT_7_DAY_CLEANUP') {
      return { success: false, error: { code: 'CLEANUP_NOT_APPROVED' } }
    }
    try {
      const db = cloudSdk.database({ throwOnNotFound: false })
      const report = await runCleanup({ db, now, mode })
      // Only a bounded aggregate; never log per-user IDs, request inputs,
      // SDK messages or stack traces.
      log({ event: 'cleanup_completed', success: true,
        ...report })
      return report
    } catch (_) {
      log({ event: 'cleanup_failed' })
      return { success: false, error: { code: 'CLEANUP_UNAVAILABLE' } }
    }
  }
}
exports.main = createHandler()
exports.createHandler = createHandler
exports.isExpectedTimer = isExpectedTimer
