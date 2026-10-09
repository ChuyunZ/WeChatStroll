// DEVTOOLS ONLY. Sample from an already prepared Tencent nearbyPois candidate
// pool, independently of AI route planning and walking validation.
// This sampler never calls map APIs or requests location. The separate POI
// source performs one developer-only nearbyPois call per Cloud Test page.
const { normalizeInput, validateCopyDetailed } = require('./route-copy-contract');
const DURATIONS = [15, 30, 45, 60, 90, 120];
const CROWDS = ['low', 'medium', 'high'];
const ENVIRONMENTS = ['公园', '水边', '街道', '商街'];
const CATEGORIES = new Set(['park', 'water', 'street', 'shoppingStreet']);
const TYPES = ['loop', 'out_and_back', 'point_to_point'];
const MAX_SENDS = 500;
const MIN_INTERVAL_MS = 15000;
const BAD_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>]/;
function rng(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normalizePoiPool(pool) {
  if (!Array.isArray(pool)) return [];
  const ids = new Set(), output = [];
  for (const poi of pool) {
    if (!poi || typeof poi.poiId !== 'string' || !poi.poiId.trim() ||
        typeof poi.name !== 'string' || !poi.name || poi.name !== poi.name.trim() ||
        [...poi.name].length > 120 || BAD_TEXT.test(poi.name) ||
        !CATEGORIES.has(poi.category)) continue;
    const key = poi.category + ':' + poi.name;
    if (ids.has(key)) continue;
    ids.add(key); output.push({ name: poi.name, category: poi.category });
  }
  return output;
}
function generateCases({ poiPool, count = MAX_SENDS, seed = 1 }) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SENDS ||
      !Number.isSafeInteger(seed)) return [];
  const pool = normalizePoiPool(poiPool);
  if (!pool.length) return [];
  const random = rng(seed);
  let available = [];
  function refill() {
    available = [...pool];
    for (let i = available.length - 1; i > 0; i--) {
      const k = Math.floor(random() * (i + 1));
      [available[i], available[k]] = [available[k], available[i]];
    }
  }
  refill();
  const cases = [];
  for (let i = 0; i < count; i++) {
    const n = Math.min(1 + (i % 8), pool.length);
    const chosen = [];
    while (chosen.length < n) {
      if (!available.length) refill();
      const poi = available.shift();
      if (!chosen.some(p => p.name === poi.name && p.category === poi.category)) chosen.push(poi);
    }
    const routeType = TYPES[Math.floor(i / 8) % TYPES.length];
    const durationMinutes = DURATIONS[i % DURATIONS.length];
    const crowdPreference = CROWDS[Math.floor(i / DURATIONS.length) % CROWDS.length];
    const rotation = (i + Math.floor(random() * 4)) % 4;
    const environmentPreferences = [...ENVIRONMENTS.slice(rotation), ...ENVIRONMENTS.slice(0, rotation)];
    // Simulated, internally consistent only; NOT actual Tencent walking data.
    const distanceMeters = Math.round((n * 650 + 400 + random() * 1100) / 10) * 10;
    const durationSeconds = Math.ceil((distanceMeters / (65 + random() * 15) + n * 2.5) * 60);
    const payload = normalizeInput({ schemaVersion: 1,
      routeFacts: { routeType, returnsToStart: routeType !== 'point_to_point',
        distanceMeters, durationSeconds, durationMinutes: Math.ceil(durationSeconds / 60),
        orderedPois: chosen.map((poi, j) => ({
          ref: `P${j + 1}`, name: poi.name, category: poi.category
        })) },
      preferences: { durationMinutes, routeType, crowdPreference, environmentPreferences },
      historicalPreferenceProfile: null
    });
    if (!payload) continue;
    cases.push({ id: `C${String(i + 1).padStart(3, '0')}`, payload,
      scenario: { inputMode: 'simulated-from-tencent-poi-pool', poolSize: pool.length,
        sampledPoiCount: chosen.length, sampleIndex: i + 1,
        actualRouteMinutes: payload.routeFacts.durationMinutes, durationMinutes,
        crowdPreference, environmentPreferences, routeType } });
  }
  return cases;
}

function publicRecord(testCase, startedAtMs, elapsedMs, response, error) {
  const { id, scenario, payload } = testCase;
  const envelope = response && typeof response === 'object' ? response : null;
  const result = envelope && envelope.result && typeof envelope.result === 'object' ? envelope.result : null;
  const requestId = envelope && (envelope.requestID || envelope.requestId);
  let code = 'COPY_TRANSPORT_UNKNOWN', status = 'stop';
  let clientReason = null;
  if (!error && result && result.success === true) {
    const checked = validateCopyDetailed(result.copy, payload);
    if (!checked.copy) {
      code = 'CLIENT_VALIDATION_FAILED'; status = 'rejected';
      clientReason = { reason: checked.reason, field: checked.field };
    } else if (elapsedMs >= 20000) {
      // The actual UI will stop accepting copy after its 20-second deadline.
      code = 'COPY_UI_DEADLINE_EXCEEDED'; status = 'rejected';
    } else { code = 'OK'; status = 'accepted'; }
  } else if (!error && result && result.success === false && result.error &&
      typeof result.error.code === 'string') {
    const allowed = ['COPY_INVALID_OUTPUT', 'COPY_QUOTA_EXCEEDED', 'COPY_QUOTA_UNAVAILABLE',
      'COPY_INVALID_INPUT', 'COPY_UNAUTHORIZED', 'COPY_UNAVAILABLE', 'COPY_EXECUTION_UNKNOWN'];
    code = allowed.includes(result.error.code) ? result.error.code : 'COPY_UNKNOWN_RESPONSE';
    status = code === 'COPY_INVALID_OUTPUT' ? 'rejected' : 'stop';
  }
  const record = { id, ...scenario, startedAt: new Date(startedAtMs).toISOString(),
    elapsedMs, status, code,
    ...(typeof requestId === 'string' && requestId.length < 100 ? { requestId } : {}) };
  if (status === 'accepted') return record;
  // Preserve the non-sensitive, grounded inputs needed to reproduce a rule
  // failure, while excluding real names, IDs, geometry and exact position.
  record.routeFacts = {
    routeType: payload.routeFacts.routeType,
    returnsToStart: payload.routeFacts.returnsToStart,
    distanceMeters: payload.routeFacts.distanceMeters,
    durationSeconds: payload.routeFacts.durationSeconds,
    durationMinutes: payload.routeFacts.durationMinutes,
    orderedPois: payload.routeFacts.orderedPois.map(p => ({
      ref: p.ref, category: p.category, nameLength: [...p.name].length
    }))
  };
  if (clientReason) record.validation = clientReason;
  if (code === 'COPY_INVALID_OUTPUT' && result && result.debug &&
      result.debug.event === 'ROUTE_COPY_REJECTED') {
    const d = result.debug;
    const acceptedReasons = new Set([
      'UPSTREAM_ERROR', 'INVALID_RESPONSE_TYPE', 'OVERSIZED_RESPONSE',
      'INVALID_JSON', 'INVALID_JSON_TOKENS', 'INVALID_FIELDS',
      'INVALID_FIELD_TYPE', 'INVALID_LENGTH', 'UNSAFE_TEXT', 'WRONG_MEASUREMENT',
      'INVALID_POI', 'UNSUPPORTED_FACT', 'INVALID_ORIGIN_OR_INTERIOR',
      'WRONG_ROUTE_TYPE', 'NAVIGATION_INSTRUCTION', 'WRONG_POI_ORDER',
      'DUPLICATE_CONTENT'
    ]);
    record.validation = {
      reason: acceptedReasons.has(d.reason) ? d.reason : 'UNKNOWN',
      ...(['title', 'description', 'recommendationReason'].includes(d.field)
        ? { field: d.field } : {}),
      ...(typeof d.modelTextRedacted === 'string' && d.modelTextRedacted.length <= 1000
        ? { modelTextRedacted: d.modelTextRedacted } : {})
    };
  }
  if (code === 'COPY_EXECUTION_UNKNOWN' && result && result.debug &&
      result.debug.event === 'ROUTE_COPY_MODEL_EXCEPTION') {
    const diag = result.debug;
    const categories = ['RATE_LIMIT', 'CONCURRENCY_LIMIT', 'TOKEN_QUOTA',
      'RESOURCE_LIMIT_UNKNOWN', 'AUTH_OR_PERMISSION', 'INVALID_UPSTREAM_REQUEST',
      'UPSTREAM_SERVER', 'TIMEOUT', 'NETWORK', 'UNCLASSIFIED'];
    const providerCodes = ['429', 'RATE_LIMIT', 'RATE_LIMIT_EXCEEDED',
      'TOO_MANY_REQUESTS', 'RESOURCE_EXHAUSTED', 'EXCEED_RATELIMIT',
      'EXCEED_CONCURRENT_REQUEST_LIMIT', 'EXCEED_TOKEN_QUOTA_LIMIT'];
    record.upstream = {
      category: categories.includes(diag.category) ? diag.category : 'UNCLASSIFIED',
      ...(Number.isInteger(diag.httpStatus) && diag.httpStatus >= 400 && diag.httpStatus <= 599
        ? { httpStatus: diag.httpStatus } : {}),
      ...(providerCodes.includes(diag.providerCode)
        ? { providerCode: diag.providerCode } : {})
    };
  }
  if (code === 'COPY_INVALID_OUTPUT' && !record.validation) record.diagnosticsMissing = true;
  if (code === 'COPY_EXECUTION_UNKNOWN' && !record.upstream) record.diagnosticsMissing = true;
  return record;
}

async function runBenchmark({ minutes, cases, call, audit100 = false, seed = null,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  shouldStop = () => false, onRecord = () => {} }) {
  if (![30, 60].includes(minutes) || !Array.isArray(cases) || cases.length < 1 ||
      cases.length > MAX_SENDS || typeof call !== 'function' ||
      typeof audit100 !== 'boolean' || (audit100 && (minutes !== 60 || cases.length < 100)))
    throw new Error('Invalid benchmark setup');
  const begin = now(), deadline = begin + minutes * 60000;
  // Add a 15-second cooldown after each settled request, never parallel.
  // Tencent CloudBase notes that 429 can stem from shared model pool
  // contention even when the caller stays below its own concurrency cap.
  // This reduces our burst rate; it is NOT a guarantee of availability.
  const intervalMs = MIN_INTERVAL_MS;
  const report = { schemaVersion: 1, tool: 'route-copy-development-benchmark',
    mode: 'simulated-from-tencent-poi-pool', plannedMinutes: minutes, intervalMs,
    testMode: audit100 ? 'audit100' : 'fail-fast',
    ...(Number.isSafeInteger(seed) ? { seed } : {}),
    startedAt: new Date(begin).toISOString(), records: [], stopReason: null };
  for (let i = 0; i < (audit100 ? 100 : cases.length); i++) {
    if (shouldStop()) { report.stopReason = 'USER_STOPPED'; break; }
    if (i > 0) await sleep(intervalMs);
    if (shouldStop()) { report.stopReason = 'USER_STOPPED'; break; }
    if (now() >= deadline) { report.stopReason = 'TIME_WINDOW_ENDED'; break; }
    const startedAt = now();
    let response = null, error = null;
    try { response = await call(cases[i].payload); }
    catch (_) { error = true; }
    const record = publicRecord(cases[i], startedAt, Math.max(0, now() - startedAt), response, error);
    report.records.push(record);
    try { onRecord(record, report); } catch (_) { /* Reporting must not trigger a retry. */ }
    // Default debug mode remains strict fail-fast. Explicit 100-case audit
    // counts copy rejections separately but never retries a request.
    if (!audit100 && record.status !== 'accepted') {
      report.stopReason = record.status === 'rejected' ? 'FIRST_FAILURE' : record.code;
      break;
    }
    // Unknown transport/provider errors have uncertain upstream execution.
    // Never continue sending after them, even in the audit mode.
    if (audit100 && record.status === 'stop') {
      report.stopReason = record.code;
      break;
    }
    if (audit100 && report.records.filter(r => r.status === 'rejected').length >= 2) {
      report.stopReason = 'ACCEPTANCE_TARGET_MISSED';
      break;
    }
  }
  if (!report.stopReason) report.stopReason = shouldStop() ? 'USER_STOPPED' :
    audit100 && report.records.length === 100 ? 'AUDIT_100_COMPLETE' :
    report.records.length === cases.length ? 'CASE_LIMIT_REACHED' : 'TIME_WINDOW_ENDED';
  report.endedAt = new Date(now()).toISOString();
  report.summary = {
    total: report.records.length,
    accepted: report.records.filter(r => r.status === 'accepted').length,
    failed: report.records.filter(r => r.status !== 'accepted').length,
    rejected: report.records.filter(r => r.code === 'COPY_INVALID_OUTPUT').length
  };
  report.failures = report.records.filter(r => r.status !== 'accepted');
  if (audit100) {
    const acceptanceFailures = report.records.filter(r => r.status === 'rejected').length;
    const assessed = report.records.filter(r => r.status === 'accepted' || r.status === 'rejected').length;
    const verdict = acceptanceFailures >= 2 ? 'FAIL' :
      report.stopReason === 'AUDIT_100_COMPLETE' && assessed === 100 &&
        acceptanceFailures <= 1 ? 'PASS' : 'INCONCLUSIVE';
    report.audit = { target: 100, maxAcceptanceFailures: 1, assessed,
      accepted: report.summary.accepted, acceptanceFailures, verdict };
  }
  return report;
}

module.exports = { MAX_SENDS, DURATIONS, CROWDS, normalizePoiPool, generateCases,
  runBenchmark, publicRecord };
