const { generateCases, runBenchmark, publicRecord, MAX_SENDS } = require('../miniprogram/services/route-copy-benchmark');
const { preferences, history, route, copy } = require('./helpers/route-copy');
const { normalizeInput } = require('../miniprogram/services/route-copy-contract');

const cases = n => generateCases({ routes: [route()], preferences, history, count: n });
const copyResult = { result: { success: true, copy } };
test('generates valid diverse scenarios from a real route projection without changing actual facts', () => {
  const generated = cases(MAX_SENDS);
  expect(generated).toHaveLength(MAX_SENDS);
  expect(generated.map(c => c.scenario.durationMinutes).slice(0, 6)).toEqual([15, 30, 45, 60, 90, 120]);
  expect(new Set(generated.map(c => c.scenario.crowdPreference)).size).toBe(3);
  expect(new Set(generated.filter(c => c.scenario.durationMinutes === 15)
    .map(c => c.scenario.crowdPreference)).size).toBe(3);
  expect(new Set(generated.map(c => c.scenario.environmentPreferences.join('|'))).size).toBe(4);
  const baseline = generated[0].payload.routeFacts;
  for (const item of generated) {
    expect(item.payload.routeFacts).toEqual(baseline);
    expect(normalizeInput(item.payload)).toEqual(item.payload);
  }
});
test('requires actual route facts and refuses fake/oversized runs', () => {
  expect(generateCases({ routes: [], preferences, history })).toEqual([]);
  expect(generateCases({ routes: [route()], preferences, history, count: MAX_SENDS + 1 })).toEqual([]);
});
test('captures rejection/acceptance with bounded interval and no exposed model text', async () => {
  let t = Date.UTC(2026, 9, 9), calls = 0;
  const seen = [];
  const report = await runBenchmark({ minutes: 30, cases: cases(3),
    now: () => t, sleep: async ms => { t += ms; },
    call: async () => { calls++; return calls === 1 ?
      { result: { success: false, error: { code: 'COPY_INVALID_OUTPUT', message: 'PRIVATE_AI' } } } :
      { ...copyResult, requestID: `safe-${calls}` }; },
    onRecord: r => seen.push(r)
  });
  expect(report.records).toHaveLength(3); // all three scheduled before cutoff.
  expect(report.summary).toMatchObject({ total: 3, failed: 1, accepted: 2, rejected: 1 });
  expect(report.records.map(r => r.code)).toEqual(['COPY_INVALID_OUTPUT', 'OK', 'OK']);
  expect(report.intervalMs).toBeGreaterThanOrEqual(120000);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_AI|人民公园|latitude|poi-0/);
  expect(seen).toHaveLength(3);
});
test.each(['COPY_QUOTA_EXCEEDED', 'COPY_QUOTA_UNAVAILABLE', 'COPY_EXECUTION_UNKNOWN',
  'COPY_UNAUTHORIZED'])('stops when server refuses %s; never retries', async code => {
  let sent = 0;
  const report = await runBenchmark({ minutes: 60, cases: cases(5), call: async () => {
    sent++; return { result: { success: false, error: { code } } };
  } });
  expect(sent).toBe(1); expect(report.stopReason).toBe(code);
  expect(report.summary.total).toBe(1);
});
test('network rejection is unknown remote execution and does not send next case', async () => {
  let count = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(4), call: async () => {
    count++; throw new Error('SECRET_API_KEY');
  } });
  expect(count).toBe(1);
  expect(report.stopReason).toBe('COPY_TRANSPORT_UNKNOWN');
  expect(JSON.stringify(report)).not.toContain('SECRET_API_KEY');
});
test('user stop checked before each send', async () => {
  let sent = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(5),
    call: async () => { sent++; return copyResult; },
    shouldStop: () => sent === 1
  });
  expect(sent).toBe(1); expect(report.stopReason).toBe('USER_STOPPED');
});
test('invalid/unknown success body is a safe terminal condition', () => {
  const sample = cases(1)[0], now = Date.UTC(2026, 9, 9);
  const record = publicRecord(sample, now, 21, { result: { success: true, copy: { title: 'X' } } }, null);
  expect(record.code).toBe('CLIENT_VALIDATION_FAILED');
  expect(record).not.toHaveProperty('copy');
});
test('cloud-test has explicit user-run controls and a devtools-only platform gate', () => {
  const fs = require('fs'); const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.wxml'), 'utf8');
  expect(page).toContain("platform !== 'devtools'");
  expect(page).toContain("name: 'routeCopyGenerator'");
  expect(view).toContain('运行 30 分钟');
  expect(view).toContain('运行 60 分钟');
  expect(view).toContain('复制 JSON 报告');
});

test('successful model output arriving beyond 20-second UI deadline is reported as a failure', () => {
  const sample = cases(1)[0], now = Date.UTC(2026, 9, 9);
  const r = publicRecord(sample, now, 23000, copyResult, null);
  expect(r).toMatchObject({ status: 'rejected', code: 'COPY_UI_DEADLINE_EXCEEDED' });
});
