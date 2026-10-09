const { rankInitialCandidates, conflictsBySubset } = require('./initial-candidate-quality')
const { getAllowedDurationRange } = require('./route-validation')
const { ROUTE_TYPES } = require('../constants/route-types')
const { waypointSetKey } = require('./agentic-route-planning')
const start = { latitude: 30, longitude: 120 }
const pts = [
  ['A', 30.002, 120.000], ['B',30.002,120.002],
  ['C',30.004,120.000], ['D',30.004,120.003],
  ['E',30.006,120.000], ['F',30.005,120.006],
  ['G',30.007,120.003], ['H',30.007,120.006]
]
const pool=pts.map(([poiId,latitude,longitude],index)=>({
  poiId, latitude, longitude, category: index < 6 ? 'park':'water',
  distanceInMeters:Math.round((latitude-30)*110000), name:poiId
}))
const plan=ids=>ids.map(poiId=>({waypoints:[{poiId}]}))
const options=(candidates, overrides={})=>({
  candidates, verifiedWaypointPool:pool, location:start,
  preferences:{durationMinutes:30,routeType:ROUTE_TYPES.OUT_AND_BACK,
    environmentPreferences:['公园','水边']}, ...overrides
})
const ids = candidate => candidate.waypoints.map(p=>p.poiId)
function checkAntichain(candidates) {
 for (let i=0;i<candidates.length;i++)
  for (let j=i+1;j<candidates.length;j++)
   expect(conflictsBySubset(ids(candidates[i]),ids(candidates[j]))).toBe(false)
}
test('preserves 5 useful slots without any subset duplicate when supplementing singletons',()=>{
  const input=plan(['A','B','C','D','E'])
  const before=JSON.stringify(input)
  const result=rankInitialCandidates(options(input))
  expect(result.applied).toBe(true)
  expect(result.candidates).toHaveLength(5)
  expect(result.supplementalPairCount).toBeGreaterThan(0)
  expect(result.supplementalPairCount).toBeLessThanOrEqual(2)
  expect(result.origins.filter(x=>x==='ai').length).toBeGreaterThanOrEqual(3)
  expect(result.candidates.some(c=>ids(c).length===2)).toBe(true)
  checkAntichain(result.candidates)
  expect(JSON.stringify(input)).toBe(before)
  for (const c of result.candidates)expect(c.waypoints.every(w=>pool.some(p=>p.poiId===w.poiId))).toBe(true)
})
test('does not consume slots with {A} plus {A,B} or change a constrained five-POI pool',()=>{
 const limited=pool.slice(0,5)
 const input=plan(['A','B','C','D','E'])
 const result=rankInitialCandidates(options(input,{verifiedWaypointPool:limited}))
 expect(result.candidates).toHaveLength(5)
 expect(result.supplementalPairCount).toBe(0)
 checkAntichain(result.candidates)
})
test('retains original multi-waypoint batches and their exact order, including manual recovery semantics',()=>{
 const input=[{waypoints:[{poiId:'A'},{poiId:'B'}]},
              {waypoints:[{poiId:'C'},{poiId:'D'}]},
              {waypoints:[{poiId:'E'},{poiId:'F'}]}]
 const result=rankInitialCandidates(options(input))
 expect(result.applied).toBe(false)
 expect(result.candidates).toBe(input)
})
test('does not invent routes for an empty, malformed, or unverified AI batch',()=>{
 for(const input of [[],null,[{waypoints:[{poiId:'X'}]},{waypoints:[{poiId:'A'}]},{waypoints:[{poiId:'B'}]}]]) {
  const result=rankInitialCandidates(options(input))
  expect(result.candidates).toBe(input)
  expect(result.applied).toBe(false)
 }
})
test('never changes subset-conflicting AI input (contract remains authoritative)',()=>{
 const input=[...plan(['A','B']),{waypoints:[{poiId:'A'},{poiId:'C'}]},...plan(['D'])]
 expect(rankInitialCandidates(options(input)).applied).toBe(false)
})
test('does not request the map provider, AI or mutate session cache (pure candidate ranking)',()=>{
 const result=rankInitialCandidates(options(plan(['A','B','C','D','E'])))
 const allowed = getAllowedDurationRange(30)
 expect(allowed).toMatchObject({minSeconds:1350,maxSeconds:2250})
 expect(result.origins).toHaveLength(result.candidates.length)
 expect(result.candidates.every(c=>c.waypoints.every(w=>Object.keys(w).join()==='poiId'))).toBe(true)
})
test('selection is deterministic under candidate/POI iteration and tied geometry',()=>{
 const input=plan(['A','B','C','D','E'])
 const one=rankInitialCandidates(options(input))
 const two=rankInitialCandidates(options(input))
 expect(two).toEqual(one)
 for(const arr of [one.candidates,two.candidates]) {
  expect(new Set(arr.map(c=>waypointSetKey(ids(c)))).size).toBe(arr.length)
 }
})
