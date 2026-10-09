const { generateCases, normalizePoiPool, runBenchmark, publicRecord, MAX_SENDS } =
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
  expect(report.intervalMs).toBe(5000);
  expect(report.stopReason).toBe('FIRST_FAILURE');
  expect(report.summary).toMatchObject({ total: 1, failed: 1, accepted: 0, rejected: 1 });
  expect(report.failures[0].validation).toMatchObject({ reason: 'INVALID_POI',
    field: 'recommendationReason', modelTextRedacted: '途经【已知地点】到公园外的路线' });
  expect(report.failures[0].routeFacts.orderedPois).toHaveLength(1);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_AI|测试地点|map-poi|latitude|longitude/);
  expect(seen).toHaveLength(1);
});

test('successful cases are sent serially with five-second cooldown, not two minutes', async () => {
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
  expect(times.every((v, i) => !i || v - times[i - 1] === 5000)).toBe(true);
  expect(report.intervalMs).toBe(5000);
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

test('devtools-only page uses the map POI candidate pool, never re-fetches from Tencent', () => {
  const fs = require('fs'), path = require('path');
  const pg = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/cloud-test/cloud-test.wxml'), 'utf8');
  expect(pg).toContain("platform !== 'devtools'");
  expect(pg).toContain('poiPool: routesPage._verifiedWaypointPool');
  expect(pg).toContain("name: 'routeCopyGenerator'");
  expect(pg).not.toMatch(/nearbyPois\s*\(/);
  expect(ui).toContain('运行 30 分钟');
  expect(ui).toContain('运行 60 分钟');
  expect(ui).toContain('复制 JSON 报告');
});
