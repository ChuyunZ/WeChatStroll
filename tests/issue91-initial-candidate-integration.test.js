/**
 * Regression for #91 initial candidate quality.
 * Actual generation, optimizer, walking session and validator; ONLY external
 * network boundaries are mocked. Geometry scores never certify a route.
 */
jest.mock('../miniprogram/services/location',()=>({getCurrentLocation:jest.fn()}))
jest.mock('../miniprogram/services/preference-profile-records',()=>({refreshProfile:jest.fn()}))
jest.mock('../miniprogram/services/cloud-function-client',()=>({callCloudFunction:jest.fn()}))
jest.mock('../miniprogram/services/walking-segment',()=>({getWalkingSegment:jest.fn()}))

const { getCurrentLocation } = require('../miniprogram/services/location')
const { refreshProfile } = require('../miniprogram/services/preference-profile-records')
const { callCloudFunction } = require('../miniprogram/services/cloud-function-client')
const { getWalkingSegment } = require('../miniprogram/services/walking-segment')
const { generateRoutes } = require('../miniprogram/services/route-generation')
const { getAllowedDurationRange } = require('../miniprogram/services/route-validation')
const { waypointSetKey } = require('../miniprogram/services/agentic-route-planning')
const { conflictsBySubset } = require('../miniprogram/services/initial-candidate-quality')

const start={latitude:30,longitude:120}
const points=[
 ['A',30.002,120],['B',30.002,120.002],
 ['C',30.004,120],['D',30.004,120.003],
 ['E',30.006,120],['F',30.005,120.006],
 ['G',30.007,120.003],['H',30.007,120.006]
]
const pool=points.map(([poiId,latitude,longitude])=>({
 poiId,name:poiId,category:'park',latitude,longitude,
 distanceInMeters: Math.round((latitude-30)*111000),address:poiId+' street'
}))
const selected={durationMinutes:30,routeType:'out_and_back',environmentPreferences:['公园']}
beforeEach(()=>{
 jest.clearAllMocks()
 getCurrentLocation.mockResolvedValue(start)
 refreshProfile.mockResolvedValue(null)
 callCloudFunction.mockImplementation(async (name)=>{
  if(name==='mapProvider')return {poisByCategory:{park:pool}}
  if(name==='aiRoutePlanner')return {plan:{candidates:pool.slice(0,5)
   .map(p=>({waypoints:[{poiId:p.poiId}]}))}}
  throw Error('Unrecognized external boundary: '+name)
 })
 getWalkingSegment.mockImplementation(async (from,to)=>({
  success:true,
  durationSeconds:from.nodeType==='start'||to.nodeType==='start'?400:430,
  distanceMeters:500,
  polyline:[from,to].map(({latitude,longitude})=>({latitude,longitude}))
 }))
})
test('five too-short AI singletons are preserved; bounded correction rescues a valid pair without another AI call',async()=>{
 const result=await generateRoutes(selected)
 expect(result.status).toBe('success')
 expect(result.source).toBe('deterministic-correction')
 expect(result.routes).toHaveLength(1)
 expect(result.routes[0].recommendedWaypointIds).toHaveLength(2)
 expect(result.routes[0].durationSeconds).toBe(1660)
 const allowed=getAllowedDurationRange(30)
 expect(result.routes[0].durationSeconds).toBeGreaterThanOrEqual(allowed.minSeconds)
 expect(result.routes[0].durationSeconds).toBeLessThanOrEqual(allowed.maxSeconds)
 expect(callCloudFunction.mock.calls.filter(([name])=>name==='aiRoutePlanner')).toHaveLength(1)
 expect(getCurrentLocation).toHaveBeenCalledTimes(1)
 expect(callCloudFunction.mock.calls.filter(([name])=>name==='mapProvider')).toHaveLength(1)
 const c=result.waypointCandidateCache.getAllCandidates()
 expect(c).toHaveLength(5)
 expect(c.map(x=>x.waypointIds)).toEqual([['A'],['B'],['C'],['D'],['E']])
 expect(c.map(x=>x.status)).toEqual(['failed','failed','failed','failed','failed'])
 expect(new Set(c.map(x=>waypointSetKey(x.waypointIds))).size).toBe(5)
 for(let i=0;i<c.length;i++)for(let j=i+1;j<c.length;j++)
  expect(conflictsBySubset(c[i].waypointIds,c[j].waypointIds)).toBe(false)
 // Five original singletons each settle two directed radial segments (10);
 // correction can resolve up to 12 additional directed segments.
 expect(getWalkingSegment.mock.calls.length).toBeLessThanOrEqual(10 + 12)
 expect(result.routePlanningSession.getPlanningDiagnostics().segmentResolverCalls)
   .toBe(getWalkingSegment.mock.calls.length)
 expect(result.planningMetadata).toMatchObject({attemptCount:1,replanned:false,fallbackUsed:false})
})

test('a valid third AI singleton is never delayed or discarded by unreliable geometry pair estimates',async()=>{
 getWalkingSegment.mockImplementation(async (from,to)=>{
  const touchesC=from.nodeId==='C'||to.nodeId==='C'
  return {success:true,durationSeconds:touchesC?900:400,distanceMeters:500,
    polyline:[from,to].map(({latitude,longitude})=>({latitude,longitude}))}
 })
 const result=await generateRoutes(selected)
 expect(result.status).toBe('success')
 expect(result.source).toBe('ai')
 expect(result.routes[0].candidateWaypointIds).toEqual(['C'])
 expect(result.routes[0].durationSeconds).toBe(1800)
 expect(getWalkingSegment).toHaveBeenCalledTimes(6)
 expect(result.routePlanningSession.getPlanningDiagnostics().segmentResolverCalls).toBe(6)
 expect(result.waypointCandidateCache.getAllCandidates().map(x=>x.waypointIds))
   .toEqual([['A'],['B'],['C'],['D'],['E']])
 expect(result.waypointCandidateCache.getAllCandidates().map(x=>x.status))
   .toEqual(['failed','failed','success','unused','unused'])
 expect(callCloudFunction.mock.calls.filter(([name])=>name==='aiRoutePlanner')).toHaveLength(1)
})
