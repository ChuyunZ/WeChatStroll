const cloud = require('wx-server-sdk');
const { MAX_INPUT_BYTES, byteLength, normalizeInput, parseCopyDetailed } = require('./contract');
const { reportCopyRejection, buildRejectionDiagnostic } = require('./diagnostics');
const { buildPrompt } = require('./prompt');
const { createStore } = require('./quota-store');
const { createQuotaGate, quotaLimitsForEnvironment } = require('./quota');
const AI_MODEL = 'hy3';
const MODEL_REQUEST_TIMEOUT_MS = 60000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: MODEL_REQUEST_TIMEOUT_MS });
const MESSAGES = {
  COPY_UNAUTHORIZED: 'Authentication is required.',
  COPY_INVALID_INPUT: 'Route copy input is invalid.',
  COPY_UNAVAILABLE: 'Route copy service is unavailable.',
  COPY_INVALID_OUTPUT: 'Route copy output is invalid.',
  COPY_QUOTA_EXCEEDED: 'Route copy daily quota is exhausted.',
  COPY_QUOTA_UNAVAILABLE: 'Route copy quota check is unavailable.',
  COPY_EXECUTION_UNKNOWN: 'Route copy execution status is unknown.'
};
const failure = code => ({ success: false, error: { code, message: MESSAGES[code] },
  ...(code === 'COPY_EXECUTION_UNKNOWN' ? { executionState: 'unknown' } : {}) });

async function generateCopy(event, { openid, createModel, reserveQuota, reportRejection = reportCopyRejection,
  diagnosticsEnv = process.env } = {}) {
  if (typeof openid !== 'string' || !openid.trim()) return failure('COPY_UNAUTHORIZED');
  if (byteLength(event) > MAX_INPUT_BYTES * 2) return failure('COPY_INVALID_INPUT');
  // Read only the business envelope; CloudBase may inject other event metadata.
  const payload = normalizeInput(event && event.payload);
  if (!payload) return failure('COPY_INVALID_INPUT');
  let model;
  try { model = createModel(); } catch (_) { return failure('COPY_UNAVAILABLE'); }
  // Fail closed when quota storage is missing or its outcome is uncertain.
  if (typeof reserveQuota !== 'function') return failure('COPY_QUOTA_UNAVAILABLE');
  let quota;
  try { quota = await reserveQuota(openid); } catch (_) { return failure('COPY_QUOTA_UNAVAILABLE'); }
  if (!quota || quota.allowed !== true) {
    return failure(quota && quota.reason === 'exhausted' ? 'COPY_QUOTA_EXCEEDED' : 'COPY_QUOTA_UNAVAILABLE');
  }
  // A reserved send is not refunded even if output or transport later fails:
  // the upstream inference may have consumed tokens.
  let result;
  try {
    result = await model.generateText({ model: AI_MODEL, maxSteps: 1,
      messages: [{ role: 'user', content: buildPrompt(payload) }] });
  } catch (_) {
    // A timed-out transport does not prove that upstream inference stopped.
    // Never log upstream errors: they may echo input or model output.
    return failure('COPY_EXECUTION_UNKNOWN');
  }
  // Only an explicitly requested benchmark in a configured development Cloud
  // Function may receive a redacted rejection diagnostic. Normal app callers,
  // and every production deployment, receive the original fixed error shape.
  const rejectModelOutput = (reason, raw) => {
    let diagnostic = null;
    try { diagnostic = buildRejectionDiagnostic(reason, raw, payload, diagnosticsEnv); } catch (_) { /* safe fallback */ }
    try { reportRejection(reason, raw, payload); } catch (_) { /* Logging is best effort. */ }
    const response = failure('COPY_INVALID_OUTPUT');
    if (event && event.benchmarkDebug === true &&
        diagnosticsEnv && diagnosticsEnv.ROUTE_COPY_DEPLOYMENT_STAGE === 'development' &&
        diagnosticsEnv.ROUTE_COPY_DEBUG_TEXT === '1' && diagnostic) {
      response.debug = diagnostic;
    }
    return response;
  };
  if (!result || result.error) return rejectModelOutput({ reason: 'UPSTREAM_ERROR' }, null);
  const parsed = parseCopyDetailed(result.text, payload);
  if (!parsed.copy) return rejectModelOutput(parsed, result.text);
  return { success: true, copy: parsed.copy };
}
exports.main = async event => {
  try {
    return await generateCopy(event, { openid: cloud.getWXContext().OPENID,
      createModel: () => cloud.ai().createModel('cloudbase'),
      reserveQuota: openid => createQuotaGate({
        store: createStore(cloud.database({ throwOnNotFound: false })),
        ...quotaLimitsForEnvironment(process.env)
      })(openid) });
  } catch (_) { return failure('COPY_UNAVAILABLE'); }
};
exports.generateCopy = generateCopy;
