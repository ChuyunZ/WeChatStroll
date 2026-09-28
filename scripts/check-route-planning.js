// Offline acceptance demo. Uses the real engine/optimizer with synthetic segments.
// node scripts/check-route-planning.js
// node scripts/check-route-planning.js --devtools
const assert = require('node:assert/strict')
const { createRoutePlanningSession } = require('../miniprogram/services/route-engine')
const { optimizeWaypointOrder } = require('../miniprogram/services/waypoint-order-optimizer')
const { buildGeneratedRouteFromAiCandidate } = require('../miniprogram/services/route-generation')
const { buildRouteMap } = require('../miniprogram/utils/route-map')
const { ORDERING_MAX_EVALUATIONS, ORDERING_MAX_ROUNDS } = require('../miniprogram/config/route-planning')

const start = { latitude: 31.2304, longitude: 121.4737 }
const pois = Array.from({ length: 8 }, (_, index) => ({
  poiId: String.fromCharCode(65 + index),
  name: `测试地点 ${index + 1}${index === 3 ? '：用于检查长名称是否完整显示的散步地点' : ''}`,
  category: 'park',
  latitude: start.latitude + Math.sin(index * Math.PI / 4) * 0.004,
  longitude: start.longitude + Math.cos(index * Math.PI / 4) * 0.005
}))

function createSession(routeType, costs) {
  let calls = 0
  return {
    getCalls: () => calls,
    session: createRoutePlanningSession({
      start, verifiedWaypointPool: pois, routeType,
      segmentResolver: async (from, to) => {
        calls++
        const key = `${from.nodeId}->${to.nodeId}`
        const durationSeconds = costs ? costs[key] : 100
        assert.ok(Number.isFinite(durationSeconds), `Missing fixture edge: ${key}`)
        return { success: true, durationSeconds, distanceMeters: durationSeconds * 2,
          polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude })) }
      }
    })
  }
}

async function main() {
  const devtools = process.argv.includes('--devtools')
  const rows = []
  const routes = []
  for (const [routeType, expectedAB, expectedBA] of [
    ['point_to_point', 30, 53], ['loop', 70, 54], ['out_and_back', 34, 113]
  ]) {
    const { session, getCalls } = createSession(routeType, {
      'START->A': 10, 'A->B': 20, 'START->B': 50,
      'B->A': 3, 'A->START': 1, 'B->START': 40
    })
    const options = { allowedWaypointIds: ['A', 'B'] }
    const ab = await session.evaluateRouteOrder({ ...options, orderedWaypointIds: ['A', 'B'] })
    const ba = await session.evaluateRouteOrder({ ...options, orderedWaypointIds: ['B', 'A'] })
    assert.equal(ab.durationSeconds, expectedAB)
    assert.equal(ba.durationSeconds, expectedBA)
    const best = await optimizeWaypointOrder({ session, waypointIds: ['B', 'A'] })
    assert.deepEqual(best.recommendedWaypointIds, expectedAB < expectedBA ? ['A', 'B'] : ['B', 'A'])
    const target = await optimizeWaypointOrder({ session, waypointIds: ['A', 'B'], requestedDurationMinutes: 1 })
    assert.deepEqual(target.recommendedWaypointIds,
      Math.abs(expectedAB - 60) < Math.abs(expectedBA - 60) ? ['A', 'B'] : ['B', 'A'])
    const before = getCalls()
    await session.buildRouteForOrder({ ...options, orderedWaypointIds: best.recommendedWaypointIds })
    assert.equal(getCalls(), before)
    rows.push({ routeType, 'AB seconds': ab.durationSeconds, 'BA seconds': ba.durationSeconds,
      shortest: best.recommendedWaypointIds.join(' -> '),
      'target 60s': target.recommendedWaypointIds.join(' -> '),
      'mock edge calls': getCalls(), 'extra build calls': getCalls() - before })

    const large = createSession(routeType)
    const ids = pois.map(poi => poi.poiId)
    const recommendation = await optimizeWaypointOrder({ session: large.session, waypointIds: ids })
    assert.equal(recommendation.success, true)
    assert.equal(recommendation.optimization.strategy, 'heuristic')
    assert.ok(recommendation.optimization.evaluatedOrderCount <= ORDERING_MAX_EVALUATIONS)
    assert.ok(recommendation.optimization.improvementRounds <= ORDERING_MAX_ROUNDS)
    assert.equal(recommendation.optimization.roundEvaluationCounts.reduce((sum, n) => sum + n,
      recommendation.optimization.seedCount), recommendation.optimization.evaluatedOrderCount)
    assert.deepEqual([...recommendation.recommendedWaypointIds].sort(), ids)
    const walkingRoute = await large.session.buildRouteForOrder({
      allowedWaypointIds: ids, orderedWaypointIds: recommendation.recommendedWaypointIds, source: 'optimized'
    })
    assert.equal(walkingRoute.success, true)
    const route = buildGeneratedRouteFromAiCandidate({ location: start, walkingRoute, candidateIndex: routes.length })
    route.routeId = `offline-acceptance-${routeType}`
    route.title = `[离线测试] ${routeType} · 8 个地点`
    route.description = '合成路段，仅用于显示验收；地图折线不是实际道路，不用于导航。'
    route.recommendationReason = '检查全部地点、长名称、编号、地图视野和详情页传递。'
    const map = buildRouteMap(route)
    assert.equal(map.displayPois.length, 8)
    assert.equal(map.markers.length, 9)
    routes.push(route)
  }
  if (devtools) {
    // Paste into DevTools AppService console with the routes page visible.
    const snippet = `(() => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || page.route !== 'pages/routes/routes') throw new Error('请先打开路线列表页');
  const routes = ${JSON.stringify(routes, null, 2)};
  page._routeRequestId = (page._routeRequestId || 0) + 1;
  page._routePlanningSession = null;
  page._waypointCandidateCache = null;
  page._replacementSession = null;
  page._rawRoutes = routes;
  page.setData({ routes: page.prepareRoutes(routes), routeState: 'success' });
  console.log('已载入三种路线，各 8 个 POI。可打开详情检查。重新编译恢复正常规划；本数据不用于换路线或真实导航。');
})();`
    // ASCII survives legacy PowerShell pipe encodings. JavaScript restores
    // Chinese strings from Unicode escapes when the snippet is evaluated.
    console.log(snippet.replace(/[^\x00-\x7f]/g, character =>
      '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    ))
  } else {
    console.log('OFFLINE acceptance: real functions + synthetic segments; no cloud/API calls.')
    console.table(rows)
    console.log('PASS: all 3 route shapes, target ranking, cached rebuilds, 8-POI search and map data.')
    console.log('Map fixture: node scripts/check-route-planning.js --devtools')
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
