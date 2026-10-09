const { loadBenchmarkPoiPool, getBenchmarkCenters, SEARCH_OFFSETS, RADIUS_METERS } =
  require('../miniprogram/services/route-copy-poi-source');

const point = { latitude: 31.2, longitude: 121.4 };
const group = {
  park: [{ poiId: 'park-1', name: '人民公园', category: 'park',
    latitude: 31.2, longitude: 121.4, address: 'private-address' }],
  water: [{ poiId: 'water-1', name: '河边绿地', category: 'water', latitude: 31.2 }],
  shoppingStreet: [{ poiId: 'shop-1', name: '商圈步行街', category: 'shoppingStreet',
    providerMeta: { token: 'TOP_SECRET' } }]
};

test('dev source searches five nearby centers through existing map action and strips private data', async () => {
  const getLocation = jest.fn().mockResolvedValue(point);
  const call = jest.fn().mockResolvedValue({ success: true, poisByCategory: group });
  const pool = await loadBenchmarkPoiPool({ getLocation, call });
  expect(RADIUS_METERS).toBe(1000);
  expect(getLocation).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledTimes(SEARCH_OFFSETS.length);
  expect(call).toHaveBeenNthCalledWith(1, 'mapProvider', {
    action: 'nearbyPois', latitude: 31.2, longitude: 121.4, radius: 1000
  }, expect.objectContaining({ fallbackCode: 'BENCHMARK_POI_UNAVAILABLE' }));
  for (const [, args] of call.mock.calls) {
    expect(args.radius).toBe(1000);
    expect(args.latitude).toBeGreaterThan(31.19);
    expect(args.latitude).toBeLessThan(31.21);
    expect(args.longitude).toBeGreaterThan(121.39);
    expect(args.longitude).toBeLessThan(121.41);
  }
  expect(pool).toEqual([
    { name: '人民公园', category: 'park' },
    { name: '河边绿地', category: 'water' },
    { name: '商圈步行街', category: 'shoppingStreet' }
  ]);
  expect(JSON.stringify(pool)).not.toMatch(/park-1|121\.4|31\.2|private-address|TOP_SECRET/);
});

test.each([
  [null], [{}], [{ latitude: '31', longitude: 121 }],
  [{ latitude: NaN, longitude: 121 }], [{ latitude: 91, longitude: 121 }]
])('invalid location %p does not call map API', async bad => {
  const call = jest.fn();
  await expect(loadBenchmarkPoiPool({
    getLocation: async () => bad, call
  })).rejects.toMatchObject({ code: 'BENCHMARK_LOCATION_INVALID' });
  expect(call).not.toHaveBeenCalled();
});

test.each([
  null, undefined, {}, { poisByCategory: null }, { poisByCategory: [] },
  { poisByCategory: { park: [], water: [] } },
  { poisByCategory: { park: [], water: [], shoppingStreet: 'bad' } }
])('rejects incomplete map response %p without AI work', async result => {
  const call = jest.fn().mockResolvedValue(result);
  await expect(loadBenchmarkPoiPool({
    getLocation: async () => point, call
  })).rejects.toMatchObject({ code: 'BENCHMARK_POI_INVALID' });
  expect(call).toHaveBeenCalledTimes(1);
});

test('empty and malformed POIs cannot start AI calls', async () => {
  await expect(loadBenchmarkPoiPool({
    getLocation: async () => point,
    call: async () => ({ poisByCategory: { park: [], water: [],
      shoppingStreet: [{ poiId: 'x', name: '<script>', category: 'shoppingStreet' }] } })
  })).rejects.toMatchObject({ code: 'BENCHMARK_POI_EMPTY' });
});

test('provider failure preserves no raw provider exception in sanitized pool', async () => {
  const call = jest.fn().mockRejectedValue(Object.assign(new Error('PRIVATE_LOC'), {
    code: 'PROVIDER_GATEWAY_FAILED'
  }));
  await expect(loadBenchmarkPoiPool({ getLocation: async () => point, call }))
    .rejects.toMatchObject({ code: 'PROVIDER_GATEWAY_FAILED' });
  expect(call).toHaveBeenCalledTimes(1);
});

test('source never imports planner/Walking APIs and page caches sanitized POI pool', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname,
    '../miniprogram/services/route-copy-poi-source.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname,
    '../miniprogram/pages/cloud-test/cloud-test.js'), 'utf8');
  expect(src).not.toMatch(/require\(['"].*route-generation/);
  expect(src).not.toContain('walkingRoute');
  expect(src).not.toContain('aiRoutePlanner');
  expect(page).toContain('this._benchmarkPoiPool || await loadBenchmarkPoiPool({');
  expect(page).toContain('this._benchmarkPoiPool = poiPool');
  expect(page).toContain('if (control.stopped || this._unloaded)');
  expect(page).toContain('this._benchmarkPoiPool = null;');
  expect(page).not.toContain('getCurrentPages()');
});

// Integration regression for first-run Cloud Test after compiling:
// POI loader deliberately strips provider IDs, then generator must still
// produce 200 usable route-copy requests from those safe in-memory records.
test('first-click POI loader output feeds the 200-case benchmark without Routes page', async () => {
  const { generateCases } = require('../miniprogram/services/route-copy-benchmark');
  const pool = await loadBenchmarkPoiPool({
    getLocation: async () => point,
    call: async () => ({ success: true, poisByCategory: group })
  });
  expect(pool).toEqual([
    { name: '人民公园', category: 'park' },
    { name: '河边绿地', category: 'water' },
    { name: '商圈步行街', category: 'shoppingStreet' }
  ]);
  const inputs = generateCases({ poiPool: pool, seed: 1791500000000, count: 200 });
  expect(inputs).toHaveLength(200);
  expect(inputs[0].scenario).toMatchObject({
    inputMode: 'simulated-from-tencent-poi-pool', poolSize: 3, sampledPoiCount: 1
  });
  expect(inputs.every(item => item.payload.routeFacts.orderedPois.length > 0)).toBe(true);
  expect(inputs.some(item => item.payload.routeFacts.orderedPois.length === 3)).toBe(true);
  expect(JSON.stringify(inputs)).not.toContain('poiId');
  expect(JSON.stringify(inputs)).not.toContain('private-address');
});

test('satellite searches add distinct POIs and safely deduplicate overlapping names', async () => {
  let query = 0;
  const call = jest.fn(async () => {
    const i = ++query;
    return { poisByCategory: {
      park: [
        { poiId: 'same-' + i, name: '共同公园' },
        { poiId: 'park-' + i, name: '测试新增公园' + i }
      ],
      water: [{ poiId: 'water-' + i, name: '河道绿地' + i }],
      shoppingStreet: []
    } };
  });
  const pool = await loadBenchmarkPoiPool({ getLocation: async () => point, call });
  expect(call).toHaveBeenCalledTimes(5);
  expect(pool).toHaveLength(11);
  expect(pool.every(p => Object.keys(p).sort().join(',') === 'category,name')).toBe(true);
  expect(pool.filter(p => p.name === '共同公园')).toHaveLength(1);
  expect(JSON.stringify(pool)).not.toMatch(/poiId|same-|park-|water-/);
});

test('satellite provider failure does not retry uncertain work or discard validated center POIs', async () => {
  let count = 0;
  const pool = await loadBenchmarkPoiPool({
    getLocation: async () => point,
    call: async () => {
      if (++count === 2) throw new Error('PRIVATE_PROVIDER_MESSAGE');
      return { poisByCategory: group };
    }
  });
  expect(count).toBe(5);
  expect(pool).toHaveLength(3);
  expect(JSON.stringify(pool)).not.toContain('PRIVATE_PROVIDER_MESSAGE');
});

test('explicit stop prevents subsequent satellite requests', async () => {
  let stop = false;
  const call = jest.fn(async () => {
    stop = true;
    return { poisByCategory: group };
  });
  const pool = await loadBenchmarkPoiPool({
    getLocation: async () => point, call, shouldStop: () => stop
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect(pool).toHaveLength(3);
});

test('search center offsets are bounded and do not exceed mapProvider radius', () => {
  const centers = getBenchmarkCenters(point);
  expect(centers).toHaveLength(5);
  expect(centers[0]).toEqual(point);
  expect(new Set(centers.map(c => c.latitude + ':' + c.longitude)).size).toBe(5);
  expect(getBenchmarkCenters({ latitude: 92, longitude: 121 })).toEqual([]);
  expect(getBenchmarkCenters({ latitude: 90, longitude: 121 }).length).toBeLessThanOrEqual(3);
});
