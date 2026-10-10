const { traceMap, MAX_DISPLAY_POINTS, MAX_MAP_OBJECTS } = require('../miniprogram/utils/history-trace-map');
const point = (i, changes = {}) => ({ latitude: 31 + i * 0.00001, longitude: 121, timestampMs: 1760000000000 + i * 15000, ...changes });
test('empty and singleton traces have no fabricated line or center', () => {
  expect(traceMap([])).toMatchObject({ center: null, markers: [], polyline: [], includePoints: [] });
  const one = traceMap([point(0)]);
  expect(one.markers).toHaveLength(1); expect(one.polyline).toEqual([]);
  expect(one.center).toEqual({ latitude: 31, longitude: 121 });
});
test.each([2, 10])('%i continuous samples form one authentic segment', count => {
  const points = Array.from({ length: count }, (_, i) => point(i));
  const map = traceMap(points);
  expect(map.polyline).toHaveLength(1); expect(map.markers).toEqual([]);
  expect(map.includePoints).toEqual(points.map(({ latitude, longitude }) => ({ latitude, longitude })));
  expect(map.polyline[0].points).toEqual(map.includePoints);
});
test.each([
  { timestampMs: point(0).timestampMs + 61000 },
  { latitude: 32 },
  { latitude: 31.0005, timestampMs: point(0).timestampMs + 1000 },
  { longitude: -179 }
])('time gap, distance jump or speed withholds a connection: %j', changes => {
  const map = traceMap([point(0), point(1, changes)]);
  expect(map.polyline).toEqual([]); expect(map.markers).toHaveLength(2); expect(map.segmented).toBe(true);
});
test('same-second groups have no inferred links, including entry and exit', () => {
  const map = traceMap([point(0), point(1), point(2, { timestampMs: point(1).timestampMs }), point(3)]);
  expect(map.polyline).toEqual([]); expect(map.markers).toHaveLength(4);
});
test('disjoint multi-point segments are not bridged', () => {
  const points = [point(0), point(1), point(10), point(11)];
  const map = traceMap(points);
  expect(map.polyline.map(line => line.points.length)).toEqual([2, 2]); expect(map.markers).toEqual([]);
});
test.each([null, [null], [point(0, { latitude: 91 })], [point(1), point(0)], [point(0), point(0)], Array(1)])('malformed or nonmonotonic samples fail safely: %j', points => {
  expect(() => traceMap(points)).toThrow();
});
test('large traces render only an authentic bounded prefix, without skipping and reconnecting', () => {
  const points = Array.from({ length: 10000 }, (_, i) => point(i));
  const map = traceMap(points);
  expect(map.displayed).toBe(MAX_DISPLAY_POINTS); expect(map.total).toBe(10000); expect(map.limited).toBe(true);
  expect(map.includePoints).toEqual(points.slice(0, MAX_DISPLAY_POINTS).map(({ latitude, longitude }) => ({ latitude, longitude })));
  expect(map.polyline[0].points).toEqual(map.includePoints);
});
test('fragmented traces cap native objects and bounds include only displayed samples', () => {
  const points = Array.from({ length: 1000 }, (_, i) => point(i, { timestampMs: point(0).timestampMs + i * 120000 }));
  const map = traceMap(points);
  expect(map.markers).toHaveLength(MAX_MAP_OBJECTS); expect(map.polyline).toEqual([]);
  expect(map.includePoints).toHaveLength(MAX_MAP_OBJECTS); expect(map.limited).toBe(true);
});
test('repeated isolated coordinates use a single neutral marker', () => {
  const map = traceMap([point(0), point(0, { timestampMs: point(0).timestampMs + 120000 })]);
  expect(map.markers).toHaveLength(1); expect(map.markers[0].title).toBe('定位记录');
});
