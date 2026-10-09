// Explicit, developer-only live acceptance sampler. Never calls mapProvider,
// route planner, or any other cloud function besides routeCopyGenerator.
const { projectRoute } = require('./route-copy');
const { normalizeInput, validateCopy } = require('./route-copy-contract');
const DURATIONS = [15, 30, 45, 60, 90, 120];
const CROWDS = ['low', 'medium', 'high'];
const ENVIRONMENTS = ['公园', '水边', '街道', '商街'];
const MAX_SENDS = 16;
const MIN_INTERVAL_MS = 120000;

function generateCases({ routes, preferences, history, count = MAX_SENDS }) {
  if (!Array.isArray(routes) || !preferences || !Number.isInteger(count) || count < 1 || count > MAX_SENDS) return [];
  const snapshots = routes.slice(0, 3).map(route => projectRoute(route, preferences, history))
    .filter(Boolean).map(p => p.payload);
  const cases = [];
  for (let i = 0; i < count && snapshots.length; i++) {
    const sample = snapshots[i % snapshots.length];
    const rotation = i % 4;
    const environmentPreferences = [...ENVIRONMENTS.slice(rotation), ...ENVIRONMENTS.slice(0, rotation)];
    // Questionnaire targets intentionally vary independently of already
    // validated route metrics; this tests copy grounding, NOT route planning.
    const payload = normalizeInput({
      ...sample, preferences: { durationMinutes: DURATIONS[i % DURATIONS.length],
        crowdPreference: CROWDS[Math.floor(i / DURATIONS.length) % CROWDS.length],
        routeType: sample.routeFacts.routeType, environmentPreferences }
    });
    if (!payload) continue;
    cases.push({ id: `C${String(i + 1).padStart(2, '0')}`, payload,
      scenario: { sampleIndex: i % snapshots.length + 1,
        actualRouteMinutes: payload.routeFacts.durationMinutes,
        durationMinutes: payload.preferences.durationMinutes,
        crowdPreference: payload.preferences.crowdPreference,
        environmentPreferences, routeType: payload.routeFacts.routeType } });
  }
  return cases;
}

function publicRecord(testCase, startedAtMs, elapsedMs, response, error) {
  const { id, scenario, payload } = testCase;
  const envelope = response && typeof response === 'object' ? response : null;
  const result = envelope && envelope.result && typeof envelope.result === 'object' ? envelope.result : null;
  const requestId = envelope && (envelope.requestID || envelope.requestId);
  let code = 'COPY_TRANSPORT_UNKNOWN', status = 'stop';
  if (!error && result && result.success === true) {
    if (!validateCopy(result.copy, payload)) {
      code = 'CLIENT_VALIDATION_FAILED'; status = 'rejected';
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
  // No raw copy, POI names, OPENID, coordinates, prompt, token or provider keys
  // are collected. Use the CloudBase app logs for redacted rejection content.
  return { id, ...scenario, startedAt: new Date(startedAtMs).toISOString(),
    elapsedMs, status, code,
    ...(typeof requestId === 'string' && requestId.length < 100 ? { requestId } : {}) };
}

async function runBenchmark({ minutes, cases, call, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  shouldStop = () => false, onRecord = () => {} }) {
  if (![30, 60].includes(minutes) || !Array.isArray(cases) || cases.length < 1 ||
      cases.length > MAX_SENDS || typeof call !== 'function') throw new Error('Invalid benchmark setup');
  const begin = now(), deadline = begin + minutes * 60000;
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.ceil(minutes * 60000 / cases.length));
  const report = { schemaVersion: 1, tool: 'route-copy-development-benchmark',
    mode: 'live-hy3-copy-only', plannedMinutes: minutes, intervalMs,
    startedAt: new Date(begin).toISOString(), records: [], stopReason: null };
  for (let i = 0; i < cases.length; i++) {
    if (shouldStop()) { report.stopReason = 'USER_STOPPED'; break; }
    const due = begin + i * intervalMs;
    const delay = due - now();
    if (delay > 0) await sleep(delay);
    if (shouldStop()) { report.stopReason = 'USER_STOPPED'; break; }
    if (now() >= deadline) { report.stopReason = 'TIME_WINDOW_ENDED'; break; }
    const startedAt = now();
    let response = null, error = null;
    try { response = await call(cases[i].payload); }
    catch (_) { error = true; }
    const record = publicRecord(cases[i], startedAt, Math.max(0, now() - startedAt), response, error);
    report.records.push(record);
    try { onRecord(record, report); } catch (_) { /* Reporting must not trigger a retry. */ }
    if (record.status === 'stop') {
      report.stopReason = record.code; break;
    }
  }
  if (!report.stopReason) report.stopReason = shouldStop() ? 'USER_STOPPED' :
    report.records.length === cases.length ? 'CASE_LIMIT_REACHED' : 'TIME_WINDOW_ENDED';
  report.endedAt = new Date(now()).toISOString();
  report.summary = {
    total: report.records.length,
    accepted: report.records.filter(r => r.status === 'accepted').length,
    failed: report.records.filter(r => r.status !== 'accepted').length,
    rejected: report.records.filter(r => r.code === 'COPY_INVALID_OUTPUT').length
  };
  report.failures = report.records.filter(r => r.status !== 'accepted');
  return report;
}

module.exports = { MAX_SENDS, DURATIONS, CROWDS, generateCases, runBenchmark, publicRecord };
