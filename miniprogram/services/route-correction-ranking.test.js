const assert = require('node:assert/strict')
const { createSessionDurationEstimator, straightLineMeters } = require('./route-correction-estimator')
const { proposeDeterministicWaypointSets, runBoundedRouteCorrections } = require('./route-correction')
const { createStartNode, createDirectedEdgeKey, buildPrefetchEdgePairs } = require('./route-graph')
const start = { latitude: 45.5, longitude: -73.6 }
const pois = [
  { poiId: 'A', latitude: 45.503, longitude: -73.6 },
  { poiId: 'B', latitude: 45.503, longitude: -73.604 },
  { poiId: 'C', latitude: 45.506, longitude: -73.606 },
  { poiId: 'D', latitude: 45.5002, longitude: -73.608 }
]
const nodes = new Map(pois.map(p => [p.poiId, { ...p, nodeType: 'waypoint', nodeId: p.poiId }]))
const startNode = createStartNode(start)
const toNode = id => id === 'START' ? startNode : nodes.get(id)
const key = (a,b) => createDirectedEdgeKey(toNode(a), toNode(b))
function session() {
  const cache = new Map()
  return {
    cache,
    settle(a,b,seconds) { cache.set(key(a,b), { success: true, durationSeconds: seconds, distanceMeters: seconds * 1.3 }) },
    fail(a,b) {cache.set(key(a,b), { success:false})},
    getCachedSegmentCosts() {return [...cache].map(([edgeKey,cost])=>({edgeKey,...cost}))},
    getWaypointSearchData(ids) {return {valid: ids.every(id=>nodes.has(id)), start, routeType: 'out_and_back',waypoints:ids.map(id=>nodes.get(id))}}
  }
}
const opts = (s, extra={}) => ({session:s,verifiedWaypointPool:pois,requestedDurationMinutes:30,
  allowPairFallback:true,excludedWaypointSets:pois.map(p=>[p.poiId]),...extra})

test('geometry correction learns from genuine nondegenerate cached directed segments',()=>{
 const s=session();const a=nodes.get('A');const b=nodes.get('B');
 const base=straightLineMeters(a,b)/1.4
 s.settle('A','B',base*2);s.settle('B','A',base*2)
 const model=createSessionDurationEstimator({searchData:s.getWaypointSearchData(pois.map(p=>p.poiId)),cachedCosts:s.getCachedSegmentCosts()})
 assert.equal(model.calibrationSampleCount,2)
 assert.ok(model.correctionRatio > 1 && model.correctionRatio < 2)
 const incomplete=model.estimate(['A','C'],'out_and_back',1800,1350,2250)
 assert.ok(incomplete.unresolvedEdges>0)
 assert.ok(incomplete.highSeconds>incomplete.durationSeconds)
 assert.ok(incomplete.lowSeconds<incomplete.durationSeconds)
})

test('explicit impossible directed edge rejects pair if every order traverses it',()=>{
 const s=session();s.fail('A','B')
 const results=proposeDeterministicWaypointSets(opts(s,{verifiedWaypointPool:pois.slice(0,2)}))
 assert.deepEqual(results,[])
})

test('fully cached route can be chosen without consuming a new segment budget',async()=>{
 const s=session()
 for(const [a,b,t] of [['START','A',400],['A','START',400],['START','B',500],['B','START',500],['A','B',450],['B','A',450]])s.settle(a,b,t)
 const proposed=proposeDeterministicWaypointSets(opts(s,{verifiedWaypointPool:pois.slice(0,2)}))
 assert.equal(proposed.length,1)
 assert.equal(proposed[0].rankTier,0)
 assert.equal(proposed[0].newSegmentUpperBound,0)
 let count=0
 const result=await runBoundedRouteCorrections({...opts(s,{verifiedWaypointPool:pois.slice(0,2)}),maxNewSegmentCalls:0,
  buildCandidateRoute:async()=>{count++;return{success:true,route:{id:'ok'}}}})
 assert.equal(result.success,true);assert.equal(count,1);assert.equal(result.remainingSegmentBudget,0)
})

test('newly observed segments trigger re-ranking of pending candidates', async()=>{
 const s=session()
 for(const p of pois){s.settle('START',p.poiId,500);s.settle(p.poiId,'START',500)}
 const initial=proposeDeterministicWaypointSets(opts(s))
 assert.ok(initial.length>3)
 let snapshots=0;let builds=0;const seen=[]
 const originalGetter=s.getCachedSegmentCosts.bind(s)
 s.getCachedSegmentCosts=()=>{snapshots++;return originalGetter()}
 await runBoundedRouteCorrections({...opts(s),maxCandidates:3,maxNewSegmentCalls:12,
  buildCandidateRoute:async({candidate})=>{
   builds++;seen.push(candidate.waypointIds.join(''))
   const pts=candidate.waypointIds.map(x=>nodes.get(x))
   for(const [a,b] of buildPrefetchEdgePairs(startNode,pts,'out_and_back')){
    const from=a.nodeId,to=b.nodeId
    if(!s.cache.has(key(from,to)))s.settle(from,to,180)
   }
   return {success:false,error:'ROUTE_VALIDATION_FAILED',reason:'ROUTE_DURATION_OUT_OF_RANGE',actualDurationSeconds:1300,
     targetDurationSeconds:1800,minDurationSeconds:1350,maxDurationSeconds:2250}
  }})
 assert.equal(builds,3)
 assert.ok(snapshots>=3,'re-ranking must reread cache after each evaluated candidate')
 assert.equal(new Set(seen).size,3,'no duplicate complete sets')
})

test('rejects only fully resolved out-of-range sets; estimates never certify them',()=>{
 const s=session()
 for(const [a,b] of [['START','A'],['A','START'],['START','B'],['B','START'],['A','B'],['B','A']])s.settle(a,b,100)
 assert.deepEqual(proposeDeterministicWaypointSets(opts(s,{verifiedWaypointPool:pois.slice(0,2)})),[])
})


test('dynamic ranking changes the next choice when the first candidate resolves new costs', async () => {
  const loc = { latitude: 45.5, longitude: -73.6 }
  const pool = [
    ['A',45.501210647217924,-73.60438353129406],
    ['B',45.50521921420376,-73.60446564321848],
    ['C',45.50136490792595,-73.60263933092564],
    ['D',45.505735320688224,-73.5954825517775]
  ].map(([poiId,latitude,longitude]) => ({poiId,latitude,longitude}))
  const indexed = new Map(pool.map(p => [p.poiId,{...p,nodeType:'waypoint',nodeId:p.poiId}]))
  const costs = new Map()
  const point = id => id === 'START' ? createStartNode(loc) : indexed.get(id)
  const edge = (a,b) => createDirectedEdgeKey(point(a),point(b))
  const settle = (a,b,durationSeconds) =>
    costs.set(edge(a,b), {success:true,durationSeconds})
  for (const [id,forward,backward] of [
    ['A',494.780485983938,544.6630021440797],
    ['B',389.8744619684294,295.03858770476654],
    ['C',461.4298643078655,501.1176376021467],
    ['D',441.96030104067177,576.3203119509853]
  ]) {
    settle('START',id,forward);settle(id,'START',backward)
  }
  const fakeSession = {
    getWaypointSearchData: ids => ({
      valid: ids.every(id => indexed.has(id)), start: loc,
      routeType: 'out_and_back', waypoints: ids.map(id => indexed.get(id))
    }),
    getCachedSegmentCosts: () => [...costs].map(([edgeKey,cost])=>({edgeKey,...cost}))
  }
  const input = {session:fakeSession,verifiedWaypointPool:pool,requestedDurationMinutes:30,
    allowPairFallback:true,excludedWaypointSets:pool.map(p=>[p.poiId])}
  const initial = proposeDeterministicWaypointSets(input)
  assert.equal(initial[0].key, '["A","B"]')
  assert.equal(initial[1].key, '["B","C"]')
  const tried = []
  const outcome = await runBoundedRouteCorrections({...input,maxCandidates:2,maxNewSegmentCalls:4,
    buildCandidateRoute: async ({candidate}) => {
      tried.push(candidate.waypointIds.join(''))
      if (tried.length === 1) { settle('A','B',750);settle('B','A',750) }
      return {success:false,reason:'ROUTE_DURATION_OUT_OF_RANGE',
        actualDurationSeconds:2500,minDurationSeconds:1350,maxDurationSeconds:2250,
        targetDurationSeconds:1800}
    }
  })
  assert.deepEqual(tried,['AB','AC'])
  assert.equal(outcome.attemptedCandidates,2)
  assert.equal(outcome.remainingSegmentBudget,0)
})


test('radial detours cannot be used as a calibration prior for unknown POI-to-POI segments', () => {
  const s = session()
  const a = nodes.get('A'), b = nodes.get('B')
  const radialA = straightLineMeters(start, a) / 1.4
  const radialB = straightLineMeters(start, b) / 1.4
  for (const [id,seconds] of [['A',radialA*2.8],['B',radialB*2.5]]) {
    s.settle('START',id,seconds)
    s.settle(id,'START',seconds)
  }
  const model = createSessionDurationEstimator({
    searchData:s.getWaypointSearchData(pois.map(p=>p.poiId)),
    cachedCosts:s.getCachedSegmentCosts()
  })
  expect(model.calibrationSampleCount).toBe(4)
  expect(model.radialCorrectionRatio).toBeGreaterThan(1)
  expect(model.interPoiCalibrationSampleCount).toBe(0)
  expect(model.correctionRatio).toBe(1)
})
