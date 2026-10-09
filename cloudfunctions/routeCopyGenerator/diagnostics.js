// Developer diagnostics: opt in only for a controlled development Cloud Function.
// Never log prompt, context, identity, geometry or model transport errors.
const LOG_SNIPPET_LIMIT = 1000;
const ALLOWED_REASONS = new Set([
  'UPSTREAM_ERROR', 'INVALID_RESPONSE_TYPE', 'OVERSIZED_RESPONSE',
  'INVALID_JSON', 'INVALID_JSON_TOKENS', 'INVALID_FIELDS', 'INVALID_FIELD_TYPE',
  'INVALID_LENGTH', 'UNSAFE_TEXT', 'WRONG_MEASUREMENT', 'INVALID_POI',
  'UNSUPPORTED_FACT', 'INVALID_ORIGIN_OR_INTERIOR', 'WRONG_ROUTE_TYPE',
  'NAVIGATION_INSTRUCTION', 'WRONG_POI_ORDER', 'DUPLICATE_CONTENT'
]);
const ALLOWED_FIELDS = new Set(['title', 'description', 'recommendationReason']);
const scrubOutput = (text, payload) => {
  if (typeof text !== 'string') return null;
  const pois = payload && payload.routeFacts && payload.routeFacts.orderedPois;
  if (!Array.isArray(pois)) return null;
  // Mask first, then truncate, so no partial unmasked known name is emitted.
  let safe = text;
  const names = [...new Set(pois.map(p => p && p.name).filter(n => typeof n === 'string' && n.length))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) safe = safe.split(name).join('【已知地点】');
  safe = safe.replace(/https?:\/\/[^\s"'<>]+/gi, '【链接】')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '【邮箱】')
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, '【号码】')
    .replace(/-?\d{1,3}\.\d{4,}/g, '【坐标或数字】')
    .replace(/[A-Za-z0-9_-]{24,}/g, '【长标识】');
  // Unknown or newly invented place names may still exist in an output. Treat
  // development-only content logs as potentially sensitive, despite scrubbing.
  return safe.slice(0, LOG_SNIPPET_LIMIT);
};
function buildRejectionDiagnostic({ reason, field }, modelText, payload, env = process.env) {
  const diagnostic = { event: 'ROUTE_COPY_REJECTED',
    reason: ALLOWED_REASONS.has(reason) ? reason : 'INVALID_FIELDS' };
  if (ALLOWED_FIELDS.has(field)) diagnostic.field = field;
  // Production and unset env always log category only; development opts into
  // masked model output. Do not infer stage from client input or payload.
  if (env && env.ROUTE_COPY_DEPLOYMENT_STAGE === 'development' &&
      env.ROUTE_COPY_DEBUG_TEXT === '1') {
    const snippet = scrubOutput(modelText, payload);
    if (snippet !== null) diagnostic.modelTextRedacted = snippet;
  }
  return diagnostic;
}
function reportCopyRejection(reason, modelText, payload, {
  env = process.env, logger = console.warn
} = {}) {
  const diagnostic = buildRejectionDiagnostic(reason, modelText, payload, env);
  logger('[Route Copy] Validation:', diagnostic);
  return diagnostic;
}

// A generateText() exception may contain full prompts, POIs, access tokens or
// raw provider payloads, even in error.message. Never copy/log error/message,
// stack, arbitrary code, request/response bodies or nested provider objects.
// Only fixed categories and whitelisted numeric HTTP statuses may escape.
function buildModelFailureDiagnostic(error) {
  const safeGet = (value, key) => {
    try { return value && typeof value === 'object' ? value[key] : undefined; }
    catch (_) { return undefined; }
  };
  const resp = safeGet(error, 'response');
  const candidates = [
    safeGet(error, 'statusCode'), safeGet(error, 'status'),
    safeGet(error, 'httpStatus'), safeGet(resp, 'statusCode'),
    safeGet(resp, 'status')
  ];
  const httpStatus = candidates.map(v => typeof v === 'string' && /^[45]\d\d$/.test(v)
    ? Number(v) : v).find(v => Number.isInteger(v) && v >= 400 && v <= 599);
  const safeCode = safeGet(error, 'code');
  const shortCode = typeof safeCode === 'string' ? safeCode : '';
  // Explicit allowlist: NEVER include an arbitrary SDK code, which could
  // contain dynamic upstream content, user input or access tokens.
  const providerCodes = new Set([
    '429', 'RATE_LIMIT', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS',
    'RESOURCE_EXHAUSTED', 'EXCEED_RATELIMIT',
    'EXCEED_CONCURRENT_REQUEST_LIMIT', 'EXCEED_TOKEN_QUOTA_LIMIT'
  ]);
  const providerCode = providerCodes.has(shortCode) ? shortCode : null;
  let category = 'UNCLASSIFIED';
  if (providerCode === 'EXCEED_TOKEN_QUOTA_LIMIT') category = 'TOKEN_QUOTA';
  else if (providerCode === 'EXCEED_CONCURRENT_REQUEST_LIMIT') category = 'CONCURRENCY_LIMIT';
  else if (providerCode === 'RESOURCE_EXHAUSTED') category = 'RESOURCE_LIMIT_UNKNOWN';
  else if (httpStatus === 429 ||
      ['429', 'RATE_LIMIT', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS',
        'EXCEED_RATELIMIT'].includes(shortCode))
    category = 'RATE_LIMIT';
  else if (httpStatus === 401 || httpStatus === 403 ||
      ['UNAUTHORIZED', 'PERMISSION_DENIED'].includes(shortCode))
    category = 'AUTH_OR_PERMISSION';
  else if (httpStatus === 400 || httpStatus === 422) category = 'INVALID_UPSTREAM_REQUEST';
  else if (httpStatus >= 500) category = 'UPSTREAM_SERVER';
  else if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'TIMEOUT'].includes(shortCode))
    category = 'TIMEOUT';
  else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'NETWORK_ERROR'].includes(shortCode))
    category = 'NETWORK';
  return { event: 'ROUTE_COPY_MODEL_EXCEPTION', category,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(providerCode === null ? {} : { providerCode }) };
}
function reportModelFailure(error, { logger = console.warn } = {}) {
  const diagnostic = buildModelFailureDiagnostic(error);
  logger('[Route Copy] Model exception:', diagnostic);
  return diagnostic;
}
module.exports = { LOG_SNIPPET_LIMIT, scrubOutput, buildRejectionDiagnostic, reportCopyRejection,
  buildModelFailureDiagnostic, reportModelFailure };
