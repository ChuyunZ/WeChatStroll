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
  safe = safe.replace(/https?:\/\/[^\\s"'<>]+/gi, '【链接】')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '【邮箱】')
    .replace(/(?:\+?86[-\\s]?)?1[3-9]\\d{9}/g, '【号码】')
    .replace(/-?\\d{1,3}\\.\\d{4,}/g, '【坐标或数字】')
    .replace(/[A-Za-z0-9_-]{24,}/g, '【长标识】');
  // Unknown or newly invented place names may still exist in an output. Treat
  // development-only content logs as potentially sensitive, despite scrubbing.
  return safe.slice(0, LOG_SNIPPET_LIMIT);
};
function reportCopyRejection({ reason, field }, modelText, payload, {
  env = process.env, logger = console.warn
} = {}) {
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
  logger('[Route Copy] Validation:', diagnostic);
}
module.exports = { LOG_SNIPPET_LIMIT, scrubOutput, reportCopyRejection };
