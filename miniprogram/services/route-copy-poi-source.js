// DEVELOPMENT-ONLY. Prepare input POI names/categories directly from Tencent
// mapProvider.nearbyPois. Do not involve Routes, AI route planning or Walking.
// This is a single client call per page session; mapProvider internally makes
// up to three category-specific Explore requests through its existing limiter.
const { getCurrentLocation } = require('./location');
const { callCloudFunction } = require('./cloud-function-client');
const { isValidGeoPoint } = require('../utils/geo');
const { normalizePoiPool } = require('./route-copy-benchmark');

const RADIUS_METERS = 1000;
const CATEGORIES = ['park', 'water', 'shoppingStreet'];

function poiSourceError(code) {
  const error = new Error('Benchmark POI source unavailable.');
  error.code = code;
  return error;
}

async function loadBenchmarkPoiPool({
  getLocation = getCurrentLocation,
  call = callCloudFunction
} = {}) {
  const point = await getLocation();
  if (!isValidGeoPoint(point)) throw poiSourceError('BENCHMARK_LOCATION_INVALID');
  const result = await call('mapProvider', {
    action: 'nearbyPois', latitude: point.latitude,
    longitude: point.longitude, radius: RADIUS_METERS
  }, {
    fallbackCode: 'BENCHMARK_POI_UNAVAILABLE',
    fallbackMessage: 'Benchmark POI source unavailable.'
  });
  const grouped = result && result.poisByCategory;
  if (!grouped || typeof grouped !== 'object' || Array.isArray(grouped) ||
      CATEGORIES.some(category => !Array.isArray(grouped[category])))
    throw poiSourceError('BENCHMARK_POI_INVALID');
  // Discard IDs, coordinates, distance, addresses, provider payload and keys
  // BEFORE caching in Page memory. No database, storage or debug report.
  const pool = normalizePoiPool(CATEGORIES.flatMap(category =>
    grouped[category].map(poi => ({ ...poi, category }))));
  if (!pool.length) throw poiSourceError('BENCHMARK_POI_EMPTY');
  return pool;
}

module.exports = { loadBenchmarkPoiPool, RADIUS_METERS };
