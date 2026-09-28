const { isValidGeoPoint, areGeoPointsEqual, copyGeoPoint } = require('./geo')

function createMarker(id, point, title, kind, labelText = title) {
  const colors = { start: '#58b978', poi: '#208ca8', end: '#e66a63' }
  return {
    id,
    ...copyGeoPoint(point),
    title,
    iconPath: `/images/map-${kind}.png`,
    width: 20,
    height: 20,
    anchor: { x: 0.5, y: 0.5 },
    label: {
      content: labelText,
      color: '#ffffff',
      fontSize: 12,
      borderRadius: 6,
      bgColor: colors[kind],
      padding: 4,
      textAlign: 'center'
    }
  }
}

// pointsOfInterest already follows the engine's final visit order.
// Keep the text list even if a legacy POI has no usable map coordinate.
function buildRouteMap(route) {
  const polyline = Array.isArray(route.polyline) ? route.polyline.filter(isValidGeoPoint) : []
  const start = isValidGeoPoint(route.startPoint) ? route.startPoint : polyline[0]
  const end = isValidGeoPoint(route.endPoint) ? route.endPoint : polyline[polyline.length - 1]
  const sameEndpoints = areGeoPointsEqual(start, end)
  const displayPois = (Array.isArray(route.pointsOfInterest) ? route.pointsOfInterest : [])
    .filter(poi => poi && typeof poi === 'object')
    .map((poi, index) => ({
      ...poi,
      visitNumber: index + 1,
      displayName: typeof poi.name === 'string' && poi.name.trim() ? poi.name.trim() : `地点 ${index + 1}`
    }))
  const markers = []
  if (start) markers.push(createMarker(1, start, sameEndpoints ? '起点 / 终点' : '起点', 'start'))
  let endMarked = sameEndpoints
  displayPois.forEach(poi => {
    if (!isValidGeoPoint(poi)) return
    const isEnd = !sameEndpoints && areGeoPointsEqual(poi, end)
    if (isEnd) endMarked = true
    const title = `${poi.visitNumber}. ${poi.displayName}${isEnd ? '（终点）' : ''}`
    // Keep permanent labels compact even when a POI name is very long.
    // Full names remain in marker titles and the numbered list below the map.
    const labelText = `${poi.visitNumber}${isEnd ? '·终点' : ''}`
    markers.push(createMarker(markers.length + 1, poi, title, isEnd ? 'end' : 'poi', labelText))
  })
  if (end && !endMarked) markers.push(createMarker(markers.length + 1, end, '终点', 'end'))

  // POI coordinates can sit off the snapped walking polyline.
  const mapPoints = polyline.map(copyGeoPoint)
  for (const marker of markers) {
    if (!mapPoints.some(point => areGeoPointsEqual(point, marker))) mapPoints.push(copyGeoPoint(marker))
  }
  return { markers, mapPoints, displayPois }
}

module.exports = { buildRouteMap }
