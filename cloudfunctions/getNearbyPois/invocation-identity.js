// Derive identity only from the current invocation's trusted SCF context.
// getWXContext() reads process state and may reuse another caller's WX_OPENID
// when a warm function instance receives both Mini Program and server calls.
function invocationEnvironment(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null
  if (context.environment != null) {
    try {
      const value = typeof context.environment === 'string'
        ? JSON.parse(context.environment) : context.environment
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch (_) { return null }
  }
  if (context.environ && typeof context.environ === 'object' && !Array.isArray(context.environ)) {
    return context.environ
  }
  if (typeof context.environ !== 'string') return null
  const values = Object.create(null)
  for (const field of context.environ.split(';')) {
    const equals = field.indexOf('=')
    if (equals <= 0) continue
    const key = field.slice(0, equals)
    if (key === 'WX_APPID' || key === 'WX_OPENID') {
      if (Object.prototype.hasOwnProperty.call(values, key)) return null
      values[key] = field.slice(equals + 1)
    }
  }
  return values
}
function currentWXIdentity(context) {
  const env = invocationEnvironment(context)
  if (!env || !Object.prototype.hasOwnProperty.call(env, 'WX_APPID') ||
      !Object.prototype.hasOwnProperty.call(env, 'WX_OPENID') ||
      typeof env.WX_APPID !== 'string' || !env.WX_APPID.trim() ||
      typeof env.WX_OPENID !== 'string' || !env.WX_OPENID.trim()) {
    throw Object.assign(new Error('Current invocation lacks Mini Program identity'), { code: 'MAP_UNAUTHORIZED' })
  }
  return { APPID: env.WX_APPID, OPENID: env.WX_OPENID }
}
module.exports = { currentWXIdentity }
