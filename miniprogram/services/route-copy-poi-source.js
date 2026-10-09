// DEVELOPMENT ONLY: collect verified Tencent POI names/categories via the
// existing mapProvider.nearbyPois action. No Routes or walking-route requests.
// mapProvider's 1,000m radius and per-category result cap remain unchanged.
// Several nearby search centers provide a broader *testing* input pool, not
// a claimed set of POIs reachable from the original location.
const { getCurrentLocation } = require('./location');
const { callCloudFunction } = require('./cloud-function-client');
const { isValidGeoPoint } = require('../utils/geo');
const { normalizePoiPool } = require('./route-copy-benchmark');

const RADIUS_METERS = 1000;
const SEARCH_OFFSET_METERS = 700;
const SEARCH_OFFSETS = Object.freeze([
  [0, 0], [SEARCH_OFFSET_METERS, 0], [-SEARCH_OFFSET_METERS, 0],
  [0, SEARCH_OFFSET_METERS], [0, -SEARCH_OFFSET_METERS]
]);
const CATEGORIES = ['park', 'water', 'shoppingStreet'];

function poiSourceError(code) {
  const error = new Error('Benchmark POI source unavailable.');
  error.code = code;
  return error;
}

function getBenchmarkCenters(point) {
  if (!isValidGeoPoint(point)) return [];
  const latitudeRadians = point.latitude * Math.PI / 180;
  const longitudeMetersPerDegree = 111320 * Math.cos(latitudeRadians);
  return SEARCH_OFFSETS.map(([north, east]) => {
    if (east && longitudeMetersPerDegree < 1) return null;
    const latitude = Number((point.latitude + north / 111320).toFixed(6));
    const longitude = Number((point.longitude + east / longitudeMetersPerDegree).toFixed(6));
    const candidate = { latitude, longitude };
    return isValidGeoPoint(candidate) ? candidate : null;
  }).filter(Boolean);
}

async function loadBenchmarkPoiPool({
  getLocation = getCurrentLocation,
  call = callCloudFunction,
  shouldStop = () => false
} = {}) {
  const point = await getLocation();
  if (!isValidGeoPoint(point)) throw poiSourceError('BENCHMARK_LOCATION_INVALID');
  const results = [];
  const seen = new Set();
  const centers = getBenchmarkCenters(point);
  for (const [index, center] of centers.entries()) {
    if (shouldStop()) break;
    let result;
    try {
      result = await call('mapProvider', {
        action: 'nearbyPois', latitude: center.latitude,
        longitude: center.longitude, radius: RADIUS_METERS
      }, {
        fallbackCode: 'BENCHMARK_POI_UNAVAILABLE',
        fallbackMessage: 'Benchmark POI source unavailable.'
      });
    } catch (error) {
      // A failure at the original location is fatal. Satellite centers are
      // best-effort; do not retry unknown provider execution or expose errors.
      if (index === 0) throw error;
      continue;
    }
    const grouped = result && result.poisByCategory;
    if (!grouped || typeof grouped !== 'object' || Array.isArray(grouped) ||
        CATEGORIES.some(category => !Array.isArray(grouped[category]))) {
      if (index === 0) throw poiSourceError('BENCHMARK_POI_INVALID');
      continue;
    }
    // Strip provider IDs/locations/addresses BEFORE keeping any POI in
    // page memory. Dedupe across overlapping search centers.
    const normalized = normalizePoiPool(CATEGORIES.flatMap(category =>
      grouped[category].map(poi => ({ ...poi, category }))));
    for (const poi of normalized) {
      const key = poi.category + ':' + poi.name;
      if (!seen.has(key)) { seen.add(key); results.push(poi); }
    }
  }
  if (!results.length) throw poiSourceError('BENCHMARK_POI_EMPTY');
  return results;
}

module.exports = { loadBenchmarkPoiPool, getBenchmarkCenters, RADIUS_METERS,
  SEARCH_OFFSET_METERS, SEARCH_OFFSETS };
