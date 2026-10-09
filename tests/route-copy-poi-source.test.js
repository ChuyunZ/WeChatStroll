const { loadBenchmarkPoiPool, RADIUS_METERS } =
  require('../miniprogram/services/route-copy-poi-source');

const point = { latitude: 31.2, longitude: 121.4 };
const group = {
  park: [{ poiId: 'park-1', name: '人民公园', category: 'park',
    latitude: 31.2, longitude: 121.4, address: 'private-address' }],
  water: [{ poiId: 'water-1', name: '河边绿地', category: 'water', latitude: 31.2 }],
  shoppingStreet: [{ poiId: 'shop-1', name: '商圈步行街', category: 'shoppingStreet',
    providerMeta: { token: 'TOP_SECRET' } }]
};

test('direct dev source performs only one cloud function call with existing map radius and strips private data', async () => {
  const getLocation = jest.fn().mockResolvedValue(point);
  const call = jest.fn().mockResolvedValue({ success: true, poisByCategory: group });
  const pool = await loadBenchmarkPoiPool({ getLocation, call });
  expect(RADIUS_METERS).toBe(1000);
  expect(getLocation).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith('mapProvider', {
    action: 'nearbyPois', latitude: 31.2, longitude: 121.4, radius: 1000
  }, expect.objectContaining({ fallbackCode: 'BENCHMARK_POI_UNAVAILABLE' }));
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
  expect(page).toContain('this._benchmarkPoiPool || await loadBenchmarkPoiPool()');
  expect(page).toContain('this._benchmarkPoiPool = poiPool');
  expect(page).toContain('if (control.stopped || this._unloaded)');
  expect(page).toContain('this._benchmarkPoiPool = null;');
  expect(page).not.toContain('getCurrentPages()');
});
