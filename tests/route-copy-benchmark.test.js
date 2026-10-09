const { generateCases, normalizePoiPool, runBenchmark, publicRecord,
  MAX_SENDS, AUDIT_COUNT, AUDIT_WINDOW_MINUTES, MIN_AUDIT_POOL } =
  require('../miniprogram/services/route-copy-benchmark');

const { normalizeInput } = require('../miniprogram/services/route-copy-contract');

// Simulates only the field-normalized POI candidates from Tencent nearbyPois,
// BEFORE route selection. Does not generate routes, call the planner or map SDK.
const poiPool = Array.from({ length: 18 }, (_, i) => ({
  poiId: 'map-poi-' + i,
  name: '测试地点' + i + ['公园', '水岸', '街区', '商圈'][i % 4],
  category: ['park', 'water', 'street', 'shoppingStreet'][i % 4],
  latitude: 30 + i / 100, longitude: 120,
  distanceInMeters: i * 200
}));
const cases = n => generateCases({ poiPool, count: n, seed: 777 });
// Valid for every simulated POI set: no unverified landmark assertions.
const acceptedCopy = {
  title: '给心情留一段散步时光',
  description: '从当前位置出发，走一段轻松自在的路，按自己喜欢的节奏看看周围，让日常多一点舒展和松弛感。',
  recommendationReason: '这段行程适合给忙碌的日常留点空白，慢慢调整心情，享受自己决定节奏的感觉。'
};
const copyResult = { result: { success: true, copy: acceptedCopy } };

test('uses all direct map candidates as a random sampling source, not validated routes', () => {
  const generated = cases(MAX_SENDS);
  expect(generated).toHaveLength(MAX_SENDS);
  const nameSet = new Set(poiPool.map(p => p.name));
  const visited = new Set();
  for (const item of generated) {
    const facts = item.payload.routeFacts;
    expect(item.scenario.inputMode).toBe('simulated-from-tencent-poi-pool');
    expect(item.scenario.poolSize).toBe(poiPool.length);
    expect(facts.orderedPois.length).toBeGreaterThanOrEqual(1);
    expect(facts.orderedPois.length).toBeLessThanOrEqual(8);
    expect(facts.durationMinutes).toBe(Math.ceil(facts.durationSeconds / 60));
    expect(facts.returnsToStart).toBe(facts.routeType !== 'point_to_point');
    for (const waypoint of facts.orderedPois) {
      expect(nameSet.has(waypoint.name)).toBe(true);
      visited.add(waypoint.name);
    }
    expect(normalizeInput(item.payload)).toEqual(item.payload);
  }
  expect(visited).toEqual(nameSet);
  expect(new Set(generated.map(x => x.scenario.durationMinutes))).toEqual(new Set([15,30,45,60,90,120]));
  expect(new Set(generated.map(x => x.scenario.crowdPreference))).toEqual(new Set(['low','medium','high']));
  expect(new Set(generated.map(x => x.scenario.environmentPreferences.join('|'))).size).toBeGreaterThan(1);
  expect(new Set(generated.map(x => x.scenario.routeType))).toEqual(new Set(['loop','out_and_back','point_to_point']));
});

test('filters structurally invalid or duplicated map POIs and never accepts AI route objects as source', () => {
  const pool = [...poiPool, { ...poiPool[0], poiId: 'new-id' },
    { poiId: 'bad1', name: '  space ', category: 'park' },
    { poiId: 'bad2', name: '安全', category: 'badcategory' },
    { poiId: 'bad3', name: 'A' + String.fromCharCode(10) + 'B', category: 'park' }];
  expect(normalizePoiPool(pool)).toHaveLength(poiPool.length);
  expect(generateCases({ poiPool: [], seed: 1 })).toEqual([]);
  expect(generateCases({ routes: [{ pointsOfInterest: poiPool }], seed: 1 })).toEqual([]);
  expect(generateCases({ poiPool, count: MAX_SENDS + 1, seed: 1 })).toEqual([]);
  const a = generateCases({ poiPool, count: 9, seed: 45 });
  const b = generateCases({ poiPool, count: 9, seed: 45 });
  expect(a).toEqual(b);
  expect(generateCases({ poiPool, count: 9, seed: 46 })).not.toEqual(a);
});

test('normalized sanitized {name,category} POIs are accepted without restoring provider IDs or coords', () => {
  const sanitized = normalizePoiPool(poiPool);
  expect(sanitized).toEqual(poiPool.map(({ name, category }) => ({ name, category })));
  const casesFromSanitized = generateCases({ poiPool: sanitized, count: 100, seed: 8642 });
  expect(casesFromSanitized).toHaveLength(100);
  expect(casesFromSanitized[0].scenario.poolSize).toBe(18);
  expect(casesFromSanitized.every(c => c.payload.routeFacts.orderedPois.length > 0)).toBe(true);
  expect(JSON.stringify(casesFromSanitized)).not.toContain('map-poi-');
  expect(JSON.stringify(casesFromSanitized)).not.toContain('latitude');
  expect(JSON.stringify(casesFromSanitized)).not.toContain('longitude');

  // Missing POI ID is only allowed for the exact sanitized two-field
  // representation. Raw/incomplete map objects must remain rejected.
  expect(normalizePoiPool([
    { name: '应被接受的公园', category: 'park' },
    { name: '不能接受的公园', category: 'park', latitude: 31.2 },
    { name: '不能接受的公园', category: 'park', address: 'raw address' },
    { name: '不能接受的公园', category: 'park', poiId: '' },
    { name: '不能接受的公园', category: 'park', raw: true }
  ])).toEqual([{ name: '应被接受的公园', category: 'park' }]);
});

test('first output validation failure stops immediately, including redacted developer evidence', async () => {
  let t = Date.UTC(2026, 9, 9), sent = 0;
  const seen = [];
  const report = await runBenchmark({ minutes: 30, cases: cases(8),
    now: () => t, sleep: async ms => { t += ms; },
    call: async () => { sent++; return { result: { success: false,
      error: { code: 'COPY_INVALID_OUTPUT', message: 'PRIVATE_AI' },
      debug: { event: 'ROUTE_COPY_REJECTED', reason: 'INVALID_POI',
        field: 'recommendationReason',
        modelTextRedacted: '途经【已知地点】到公园外的路线' } } }; },
    onRecord: record => seen.push(record)
  });
  expect(sent).toBe(1);
  expect(report.intervalMs).toBe(15000);
  expect(report.stopReason).toBe('FIRST_FAILURE');
  expect(report.summary).toMatchObject({ total: 1, failed: 1, accepted: 0, rejected: 1 });
  expect(report.failures[0].validation).toMatchObject({ reason: 'INVALID_POI',
    field: 'recommendationReason', modelTextRedacted: '途经【已知地点】到公园外的路线' });
  expect(report.failures[0].routeFacts.orderedPois).toHaveLength(1);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_AI|测试地点|map-poi|latitude|longitude/);
  expect(seen).toHaveLength(1);
});

test('successful cases are sent serially with 15-second cooldown to reduce shared AI rate-limit pressure', async () => {
  let now = Date.UTC(2026, 9, 9), sent = 0;
  const times = [];
  // The server has already accepted this valid copy as a fixture.
  const report = await runBenchmark({ minutes: 30, cases: cases(3),
    now: () => now, sleep: async ms => { now += ms; },
    call: async () => { sent++; times.push(now); return copyResult; }
  });
  // The fixed fixture uses different POI names and would be rejected by the
  // client only if it makes an explicit ungrounded claim; all are generic.
  expect(sent).toBeGreaterThanOrEqual(1);
  expect(times.every((v, i) => !i || v - times[i - 1] === 15000)).toBe(true);
  expect(report.intervalMs).toBe(15000);
});

test.each(['COPY_QUOTA_EXCEEDED', 'COPY_QUOTA_UNAVAILABLE', 'COPY_EXECUTION_UNKNOWN',
  'COPY_UNAUTHORIZED'])('fails closed without a retry on %s', async code => {
  let count = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(7), call: async () => {
    count++; return { result: { success: false, error: { code } } };
  } });
  expect(count).toBe(1);
  expect(report.stopReason).toBe(code);
  expect(report.summary.failed).toBe(1);
});

test('network uncertainty stops after one request and leaks no raw error text', async () => {
  let count = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(7),
    call: async () => { count++; throw new Error('PRIVATE_TOKEN'); } });
  expect(count).toBe(1);
  expect(report.stopReason).toBe('COPY_TRANSPORT_UNKNOWN');
  expect(JSON.stringify(report)).not.toContain('PRIVATE_TOKEN');
});

test('user stop before next call prevents additional sends', async () => {
  let sent = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(10),
    call: async () => { sent++; return copyResult; },
    shouldStop: () => sent === 1
  });
  expect(sent).toBe(1);
  expect(report.stopReason).toBe('USER_STOPPED');
});

test('client validation failure and delayed accepted output both count as failures', () => {
  const sample = cases(1)[0], now = Date.UTC(2026, 9, 9);
  const invalid = publicRecord(sample, now, 5, { result: { success: true, copy: { title: 'x' } } });
  expect(invalid).toMatchObject({ status: 'rejected', code: 'CLIENT_VALIDATION_FAILED' });
  const delayed = publicRecord(sample, now, 23000, copyResult);
  // A successful payload accepted by client has no critical route claims.
  expect(['COPY_UI_DEADLINE_EXCEEDED', 'CLIENT_VALIDATION_FAILED']).toContain(delayed.code);
  expect(invalid).not.toHaveProperty('copy');
});

test('devtools-only page loads a direct Tencent POI pool once, independent of Routes', () => {
  const fs = require('fs'), path = require('path');
  const pg = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.wxml'), 'utf8');
  expect(pg).toContain("platform !== 'devtools'");
  expect(pg).toContain('this._benchmarkPoiPool || await loadBenchmarkPoiPool()');
  expect(pg).toContain('this._benchmarkPoiPool = poiPool');
  expect(pg).not.toContain('getCurrentPages()');
  expect(pg).not.toContain('_verifiedWaypointPool');
  expect(pg).toContain('poiPool, seed, count: MAX_SENDS');
  expect(MAX_SENDS).toBe(500);
  expect(pg).toContain("name: 'routeCopyGenerator'");
  expect(pg).not.toMatch(/(?:walkingRoute|aiRoutePlanner|generateRoutes)\s*\(/);
  expect(ui).toContain('运行 30 分钟');
  expect(ui).toContain('运行 60 分钟');
  expect(ui).toContain('复制 JSON 报告');
});

test('unknown model execution stops once and includes only safe upstream diagnostic metadata', async () => {
  let calls = 0;
  const report = await runBenchmark({ minutes: 30, cases: cases(5),
    call: async () => { calls++; return {
      result: { success: false, error: { code: 'COPY_EXECUTION_UNKNOWN' },
        executionState: 'unknown',
        debug: { event: 'ROUTE_COPY_MODEL_EXCEPTION', category: 'RATE_LIMIT',
          httpStatus: 429, secret: 'PRIVATE_PROVIDER_ERROR' } }
    }; }
  });
  expect(calls).toBe(1);
  expect(report.stopReason).toBe('COPY_EXECUTION_UNKNOWN');
  expect(report.failures[0].upstream).toEqual({ category: 'RATE_LIMIT', httpStatus: 429 });
  expect(JSON.stringify(report)).not.toContain('PRIVATE_PROVIDER_ERROR');
});

test('preserves allowlisted provider error codes but never arbitrary transport strings', () => {
  const sample = cases(1)[0], now = Date.UTC(2026, 9, 9);
  const known = publicRecord(sample, now, 946, { result: {
    success: false, error: { code: 'COPY_EXECUTION_UNKNOWN' },
    debug: { event: 'ROUTE_COPY_MODEL_EXCEPTION', category: 'CONCURRENCY_LIMIT',
      providerCode: 'EXCEED_CONCURRENT_REQUEST_LIMIT', secret: 'PRIVATE_AI' }
  } });
  expect(known.upstream).toEqual({
    category: 'CONCURRENCY_LIMIT', providerCode: 'EXCEED_CONCURRENT_REQUEST_LIMIT'
  });
  expect(JSON.stringify(known)).not.toContain('PRIVATE_AI');
  const unknown = publicRecord(sample, now, 946, { result: {
    success: false, error: { code: 'COPY_EXECUTION_UNKNOWN' },
    debug: { event: 'ROUTE_COPY_MODEL_EXCEPTION', category: 'RATE_LIMIT',
      providerCode: 'SENSITIVE_POI_FAKE_CODE' }
  } });
  expect(unknown.upstream).toEqual({ category: 'RATE_LIMIT' });
});

test('200-case audit PASS is 200 checked with at most one copy rejection', async () => {
  const generated = cases(200);
  let clock = Date.UTC(2026, 9, 9), sent = 0;
  const report = await runBenchmark({ minutes: AUDIT_WINDOW_MINUTES, cases: generated, audit200: true, seed: 7,
    now: () => clock, sleep: async ms => { clock += ms; },
    call: async () => { sent++;
      if (sent === 21) return { result: { success: false,
        error: { code: 'COPY_INVALID_OUTPUT' } } };
      return copyResult;
    }
  });
  expect(sent).toBe(200);
  expect(report.stopReason).toBe('AUDIT_200_COMPLETE');
  expect(report.audit).toMatchObject({
    target: 200, maxAcceptanceFailures: 1, assessed: 200,
    accepted: 199, acceptanceFailures: 1, verdict: 'PASS'
  });
  expect(report.seed).toBe(7);
  expect(report.intervalMs).toBe(15000);
});
test('200-case audit fails promptly at second copy rejection', async () => {
  const generated = cases(200);
  let sent = 0;
  const report = await runBenchmark({ minutes: AUDIT_WINDOW_MINUTES, cases: generated, audit200: true,
    sleep: async () => {}, call: async () => { sent++;
      return [8, 17].includes(sent) ? { result: { success: false,
        error: { code: 'COPY_INVALID_OUTPUT' } } } : copyResult;
    } });
  expect(sent).toBe(17);
  expect(report.stopReason).toBe('ACCEPTANCE_TARGET_MISSED');
  expect(report.audit).toMatchObject({ verdict: 'FAIL',
    assessed: 17, accepted: 15, acceptanceFailures: 2 });
});
test('200-case audit provider errors are inconclusive and never retried', async () => {
  const generated = cases(200);
  let sent = 0;
  const report = await runBenchmark({ minutes: AUDIT_WINDOW_MINUTES, cases: generated, audit200: true,
    sleep: async () => {}, call: async () => { sent++;
      return sent === 2 ? { result: { success: false,
        error: { code: 'COPY_EXECUTION_UNKNOWN' } } } : copyResult;
    } });
  expect(sent).toBe(2);
  expect(report.stopReason).toBe('COPY_EXECUTION_UNKNOWN');
  expect(report.audit).toMatchObject({ verdict: 'INCONCLUSIVE',
    assessed: 1, accepted: 1, acceptanceFailures: 0 });
});
test('audit requires 200 prepared cases, 75-minute window and devtest pool guidance', async () => {
  expect(AUDIT_COUNT).toBe(200);
  expect(AUDIT_WINDOW_MINUTES).toBe(75);
  expect(MIN_AUDIT_POOL).toBe(16);
  await expect(runBenchmark({ minutes: 60, cases: cases(200), audit200: true,
    call: async () => copyResult })).rejects.toThrow('Invalid benchmark setup');
  await expect(runBenchmark({ minutes: 75, cases: cases(199), audit200: true,
    call: async () => copyResult })).rejects.toThrow('Invalid benchmark setup');
  await expect(runBenchmark({ minutes: 75, cases: cases(200), audit200: false,
    call: async () => copyResult })).rejects.toThrow('Invalid benchmark setup');
});

test('audit200 times out as INCONCLUSIVE rather than declaring a false pass', async () => {
  let clock = Date.UTC(2026, 9, 9), sent = 0;
  const report = await runBenchmark({
    minutes: AUDIT_WINDOW_MINUTES, cases: cases(200), audit200: true,
    now: () => clock, sleep: async ms => { clock += ms; },
    call: async () => { sent++; clock += 50000; return copyResult; }
  });
  expect(sent).toBeLessThan(200);
  expect(report.stopReason).toBe('TIME_WINDOW_ENDED');
  expect(report.audit.verdict).toBe('INCONCLUSIVE');
});
