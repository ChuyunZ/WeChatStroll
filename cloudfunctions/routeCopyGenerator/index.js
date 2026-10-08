const cloud = require('wx-server-sdk');
const { MAX_INPUT_BYTES, byteLength, normalizeInput, parseCopy } = require('./contract');
const { buildPrompt } = require('./prompt');
const AI_MODEL = 'hy3';
const MODEL_REQUEST_TIMEOUT_MS = 60000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: MODEL_REQUEST_TIMEOUT_MS });
const MESSAGES = {
  COPY_UNAUTHORIZED: 'Authentication is required.',
  COPY_INVALID_INPUT: 'Route copy input is invalid.',
  COPY_UNAVAILABLE: 'Route copy service is unavailable.',
  COPY_INVALID_OUTPUT: 'Route copy output is invalid.',
  COPY_EXECUTION_UNKNOWN: 'Route copy execution status is unknown.'
};
const failure = code => ({ success: false, error: { code, message: MESSAGES[code] },
  ...(code === 'COPY_EXECUTION_UNKNOWN' ? { executionState: 'unknown' } : {}) });

async function generateCopy(event, { openid, createModel }) {
  if (typeof openid !== 'string' || !openid.trim()) return failure('COPY_UNAUTHORIZED');
  if (byteLength(event) > MAX_INPUT_BYTES * 2) return failure('COPY_INVALID_INPUT');
  // Read only the business envelope; CloudBase may inject other event metadata.
  const payload = normalizeInput(event && event.payload);
  if (!payload) return failure('COPY_INVALID_INPUT');
  let model;
  try { model = createModel(); } catch (_) { return failure('COPY_UNAVAILABLE'); }
  let result;
  try {
    result = await model.generateText({ model: AI_MODEL, maxSteps: 1,
      messages: [{ role: 'user', content: buildPrompt(payload) }] });
  } catch (_) {
    // A timed-out transport does not prove that upstream inference stopped.
    // Never log upstream errors: they may echo input or model output.
    return failure('COPY_EXECUTION_UNKNOWN');
  }
  if (!result || result.error) return failure('COPY_INVALID_OUTPUT');
  const copy = parseCopy(result.text, payload);
  return copy ? { success: true, copy } : failure('COPY_INVALID_OUTPUT');
}
exports.main = async event => {
  try {
    return await generateCopy(event, { openid: cloud.getWXContext().OPENID,
      createModel: () => cloud.ai().createModel('cloudbase') });
  } catch (_) { return failure('COPY_UNAVAILABLE'); }
};
exports.generateCopy = generateCopy;
