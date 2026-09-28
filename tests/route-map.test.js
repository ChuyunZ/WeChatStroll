const { buildRouteMap } = require('../miniprogram/utils/route-map')
const fs = require('fs')
const path = require('path')

const start = { latitude: 30, longitude: 120 }
const pois = Array.from({ length: 8 }, (_, index) => ({
  poiId: `poi-${index}`, name: `Place ${index + 1}`,
  latitude: 30 + (index + 1) / 100, longitude: 120.01
}))

test.each([1, 3, 8])('maps all %i POIs and combines destination with the last POI', count => {
  const selected = pois.slice(0, count)
  const result = buildRouteMap({ startPoint: start, endPoint: selected[count - 1],
    polyline: [start, { latitude: 30.1, longitude: 120 }], pointsOfInterest: selected })
  expect(result.displayPois.map(poi => poi.poiId)).toEqual(selected.map(poi => poi.poiId))
  expect(result.markers).toHaveLength(count + 1)
  expect(new Set(result.markers.map(marker => marker.id)).size).toBe(count + 1)
  selected.forEach((poi, index) => {
    expect(result.markers[index + 1]).toMatchObject({ latitude: poi.latitude, longitude: poi.longitude })
    expect(result.markers[index + 1].title).toContain(`${index + 1}. ${poi.name}`)
    expect(result.markers[index + 1].label.content).toBe(`${index + 1}${index === count - 1 ? '·终点' : ''}`)
    expect(result.mapPoints).toContainEqual({ latitude: poi.latitude, longitude: poi.longitude })
  })
  expect(result.markers[count].title).toContain('终点')
  result.markers.forEach(marker => {
    const icon = fs.readFileSync(path.join(__dirname, '../miniprogram', marker.iconPath))
    expect(icon.subarray(1, 4).toString()).toBe('PNG')
  })
})

test.each(['loop', 'out_and_back'])('%s keeps the real return point and every POI', routeType => {
  const result = buildRouteMap({ routeType, startPoint: start, endPoint: start,
    polyline: [start, pois[0], pois[1], start], pointsOfInterest: pois.slice(0, 2) })
  expect(result.markers).toHaveLength(3)
  expect(result.markers[0]).toMatchObject({ ...start, title: '起点 / 终点' })
  expect(result.markers.slice(1).map(marker => marker.title)).toEqual(['1. Place 1', '2. Place 2'])
})

test('coincident POIs keep distinct identities, numbering and readable text entries', () => {
  const result = buildRouteMap({ polyline: [start, pois[0]],
    pointsOfInterest: [pois[0], { ...pois[0], poiId: 'other', name: 'Other place' }] })
  expect(result.displayPois.map(poi => poi.poiId)).toEqual(['poi-0', 'other'])
  expect(result.markers.map(marker => marker.id)).toEqual([1, 2, 3])
})

test('long POI names stay in the list and title without expanding permanent map labels', () => {
  const name = '用于检查长名称是否完整显示的散步地点'.repeat(5)
  const result = buildRouteMap({ polyline: [start, pois[1]],
    pointsOfInterest: [{ ...pois[0], name }, pois[1]] })
  expect(result.markers[1].label.content).toBe('1')
  expect(result.markers[1].title).toBe(`1. ${name}`)
  expect(result.displayPois[0].displayName).toBe(name)
  expect(result.markers[2].label.content).toBe('2·终点')
})

test('legacy missing/invalid POIs do not break the map or add invalid coordinates', () => {
  const route = { polyline: [start, pois[0]], pointsOfInterest: [null, { name: 'No coordinates' }, pois[0]] }
  const original = JSON.stringify(route)
  const result = buildRouteMap(route)
  expect(result.displayPois).toHaveLength(2)
  expect(result.markers).toHaveLength(2)
  expect(result.markers[1].title).toContain('2. Place 1')
  expect(JSON.stringify(route)).toBe(original)
  expect(buildRouteMap({ polyline: [start, pois[0]] }).markers.map(marker => marker.title))
    .toEqual(['起点', '终点'])
})

test.each(['routes', 'route-detail'])('%s template binds markers, fitting points and the full POI list', page => {
  const template = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${page}/${page}.wxml`), 'utf8')
  expect(template).toMatch(/markers="{{(?:item.previewMarkers|markers)}}"/)
  expect(template).toMatch(/include-points="{{(?:item.previewPoints|mapPoints)}}"/)
  expect(template).toMatch(/wx:for="{{(?:item|route).displayPois}}"/)
})
