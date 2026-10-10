const { validPoint, comparePoints, MAX_TRACE_POINTS } = require('./history-trace-schema');
const MAX_DISPLAY_POINTS = 500, MAX_MAP_OBJECTS = 100;
const MAX_GAP_SECONDS = 60, MAX_DISTANCE_METERS = 150, MAX_SPEED_MPS = 3;
function distance(a, b) {
  const rad = x => x * Math.PI / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function traceMap(points) {
  if (!Array.isArray(points) || points.length > MAX_TRACE_POINTS ||
      !Array.from(points).every((p, i) => validPoint(p) && (!i || comparePoints(points[i - 1], p) < 0))) throw new Error('Invalid trace points.');
  const segments = [];
  let displayed = 0;
  for (let i = 0; i < Math.min(points.length, MAX_DISPLAY_POINTS); i++) {
    const p = points[i], previous = points[i - 1];
    const dt = previous ? (p.timestampMs - previous.timestampMs) / 1000 : 0;
    // Every sample in an ambiguous same-second group is isolated, including its edges.
    const ambiguous = (points[i + 1] && points[i + 1].timestampMs === p.timestampMs) ||
      (i > 1 && points[i - 2].timestampMs === previous.timestampMs);
    const meters = previous ? distance(previous, p) : 0;
    const connect = previous && !ambiguous && dt > 0 && dt <= MAX_GAP_SECONDS &&
      meters <= MAX_DISTANCE_METERS && meters / dt <= MAX_SPEED_MPS && Math.abs(p.longitude - previous.longitude) <= 180;
    if (!connect) {
      if (segments.length >= MAX_MAP_OBJECTS) break;
      segments.push([]);
    }
    segments[segments.length - 1].push({ latitude: p.latitude, longitude: p.longitude });
    displayed++;
  }
  const markers = [], polyline = [], seen = new Set();
  segments.forEach(segment => {
    if (segment.length > 1) polyline.push({ points: segment, color: '#2fc766', width: 5 });
    else {
      const point = segment[0], key = `${point.latitude},${point.longitude}`;
      if (!seen.has(key)) markers.push({ id: markers.length + 1, ...point, iconPath: '/images/map-poi.png', width: 24, height: 24, title: '定位记录' });
      seen.add(key);
    }
  });
  const includePoints = segments.flat();
  return { markers, polyline, includePoints, center: includePoints[0] || null,
    displayed, total: points.length, limited: displayed < points.length, segmented: segments.length > 1 };
}
module.exports = { traceMap, MAX_DISPLAY_POINTS, MAX_MAP_OBJECTS, MAX_GAP_SECONDS, MAX_DISTANCE_METERS, MAX_SPEED_MPS };
