const cloudbase = require('@cloudbase/node-sdk')

const ACTION = 'walkingRoute'
const FORWARD_DEADLINE_MS = 65000

// Independently deployed functions keep this small adapter local. Parity is
// verified by the wrapper contract tests; neither adapter owns provider retries.
function diagnosticCode(error) {
  const code = error && error.code
  if (code === 'FORWARD_DEADLINE_EXCEEDED') return code
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'TIMEOUT'].includes(code)) return 'TRANSPORT_TIMEOUT'
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'TRANSPORT_NETWORK_FAILED'
  return 'SDK_CALL_FAILED'
}

function businessResult(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch (_) { return null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.success !== 'boolean') return null
  if (!value.success && (!value.error || typeof value.error.code !== 'string' || !value.error.code.trim() ||
    typeof value.error.message !== 'string' || !value.error.message.trim())) return null
  return value
}

exports.main = async (event, context = {}) => {
  const log = record => console.info('[AMap Legacy Wrapper]', { ...record, action: ACTION })
  let timer
  context.callbackWaitsForEmptyEventLoop = false
  log({ event: 'forward_start', target: 'amapProvider', transport: 'cloudbase-node-3.17.2',
    timeoutMs: 60000, executionLimitMs: Number.isFinite(context.time_limit_in_ms) ? context.time_limit_in_ms : null })
  try {
    // The watchdog bounds a never-settling SDK promise independently of the
    // platform execution timeout; it does not retry or cancel the child.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Forwarding deadline exceeded'),
        { code: 'FORWARD_DEADLINE_EXCEEDED' })), FORWARD_DEADLINE_MS)
    })
    // Use documented Node SDK transport options; wx-server-sdk ignores slow.
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV,
      timeout: 60000, retries: 0, keepalive: false })
    const invocation = app.callFunction({
      name: 'amapProvider', data: { ...(event || {}), action: ACTION }
    }, { timeout: 60000, retryOptions: { retries: 0 } })
    const response = await Promise.race([invocation, deadline])
    // The Node SDK can resolve infrastructure failures as error envelopes.
    if (response && response.code) throw new Error('Gateway invocation failed')
    const raw = response && response.result
    const result = businessResult(raw)
    if (result) {
      log({ event: 'forward_return', success: result.success })
      return result
    }
    log({ event: 'forward_failed', code: 'INVALID_GATEWAY_RESULT' })
  } catch (error) {
    log({ event: 'forward_failed', code: diagnosticCode(error) })
  } finally {
    clearTimeout(timer)
  }
  return { success: false, error: {
    code: 'PROVIDER_GATEWAY_FAILED', message: 'Unable to contact the provider gateway'
  } }
}
