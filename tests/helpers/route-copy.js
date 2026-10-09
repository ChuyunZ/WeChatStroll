const preferences = { durationMinutes: 30, routeType: 'loop', crowdPreference: 'low',
  environmentPreferences: ['公园', '水边', '街道', '商街'] };
const history = { environmentWeights: { park: 1, water: 0.5, street: 0, shoppingStreet: 0 },
  preferredDurationMinutes: 40, crowdPreferenceSignal: -0.5, likedTags: ['quiet'],
  dislikedTags: [], evidenceWalkCount: 3 };
const copy = {
  title: '给心情放个悠闲小假',
  description: '从当前位置出发，途经人民公园与滨河广场，再返回起点。不妨放慢心情，在这次散步中留一点自由探索的空间。',
  recommendationReason: '你把公园排在散步偏好的前面，这次可以围绕人民公园展开探索，给日常换换心情。'
};
function route(id = 'route-1', overrides = {}) {
  const pois = ['人民公园', '滨河广场'].map((name, i) => ({ poiId: `poi-${i}`, name,
    category: i ? 'water' : 'park', type: i ? 'water' : 'park', latitude: 30 + i / 100, longitude: 120,
    address: 'PRIVATE_ADDRESS', providerMeta: { raw: 'PRIVATE_PROVIDER' } }));
  return { routeId: id, title: '默认路线标题', description: '默认路线介绍', recommendationReason: '默认推荐理由',
    routeType: 'loop', returnsToStart: true, distanceMeters: 1800, durationSeconds: 1200, durationMinutes: 20,
    routeOrder: { source: 'recommended', orderedWaypointIds: pois.map(p => p.poiId) },
    editableWaypoints: pois, recommendedWaypointIds: pois.map(p => p.poiId), recommendedDurationMinutes: 20,
    pointsOfInterest: pois, polyline: [{ latitude: 30, longitude: 120 }, { latitude: 30.01, longitude: 120 }],
    startPoint: { latitude: 30, longitude: 120 }, endPoint: { latitude: 30, longitude: 120 },
    crowdLevel: 'unknown', tags: [], ...overrides };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
// Emulate WeChat path updates AND the rendering-complete callback.
function setData(updates, callback) {
  for (const [path, value] of Object.entries(updates)) {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = this.data;
    for (const key of keys.slice(0, -1)) target = target[key];
    // The view receives serialized values. Do not let later path updates mutate
    // the original setData argument retained by Jest's call history.
    target[keys[keys.length - 1]] = value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value)) : value;
  }
  if (callback) callback();
}
module.exports = { preferences, history, copy, route, deferred, flush, setData };
