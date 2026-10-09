#!/usr/bin/env node
'use strict'
/*
 * OFFLINE initial-batch quality replay, synthetic directed walking provider.
 * Compares unchanged 5 AI singletons with geometry-only hybrid selection.
 * Not Tencent latency and not real model output. No network requests.
 */
const assert=require('node:assert/strict')
const {rankInitialCandidates,conflictsBySubset}=require('../../miniprogram/services/initial-candidate-quality')
const {createStartNode,buildTraversalNodes,buildEdgePairs,createDirectedEdgeKey,buildPrefetchEdgePairs}=require('../../miniprogram/services/route-graph')
const {straightLineMeters}=require('../../miniprogram/services/route-correction-estimator')
const {getAllowedDurationRange}=require('../../miniprogram/services/route-validation')
const start={latitude:30,longitude:120}
const TARGET=30
const range=getAllowedDurationRange(TARGET)
const N=Number(process.env.INITIAL_BENCH_REPS||250)
assert.ok(Number.isInteger(N)&&N>0&&N<=3000)
function rng(seed){let x=seed>>>0;return ()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296}}
function makeScenario(kind,seed){
 const random=rng(seed)
 const short=kind==='short-singletons'
 const pois=Array.from({length:8},(_,i)=>{
  const angle=random()*2*Math.PI
  const radius=(short?180:kind==='mixed'?280:750)+random()*(short?340:kind==='mixed'?550:180)
  const latitude=start.latitude+Math.cos(angle)*radius/111100
  const longitude=start.longitude+Math.sin(angle)*radius/(111100*Math.cos(start.latitude*Math.PI/180))
  return {poiId:String.fromCharCode(65+i),name:'POI '+i,category:'park',
   latitude,longitude,distanceInMeters:Math.round(radius)}
 })
 const byId=new Map(pois.map(p=>[p.poiId,{...p,nodeId:p.poiId,nodeType:'waypoint'}]))
 const startNode=createStartNode(start)
 const nodes=new Map([['START',startNode],...byId])
 const trueDurations=new Map()
 for(const a of nodes.values())for(const b of nodes.values()){
  if(a.nodeId===b.nodeId)continue
  const distance=straightLineMeters(a,b)
  const factor=short?1.0+random()*0.55:kind==='mixed'?1.0+random()*0.8:1.05+random()*0.65
  const duration=Math.max(1,distance/1.4*factor)
  trueDurations.set(createDirectedEdgeKey(a,b),duration)
 }
 return {pois,nodes,startNode,trueDurations}
}
function replay(candidates,scenario){
 const cached=new Set(),done=[]
 let accepted=false,successfulIndex=-1,requestCount=0
 for(let i=0;i<candidates.length;i++){
  const waypointIds=candidates[i].waypoints.map(p=>p.poiId)
  const waypoints=waypointIds.map(id=>scenario.nodes.get(id))
  for(const [a,b] of buildPrefetchEdgePairs(scenario.startNode,waypoints,'out_and_back')){
   const key=createDirectedEdgeKey(a,b)
   if(!cached.has(key)){cached.add(key);requestCount++}
  }
  // Build all <= 2-point visit orders as the existing exact optimizer does.
  const orders=[waypoints, ...(waypoints.length===2?[[waypoints[1],waypoints[0]]]:[])]
  const durations=orders.map(order=>buildEdgePairs(
   buildTraversalNodes(scenario.startNode,order,'out_and_back')
  ).reduce((acc,[a,b])=>acc+scenario.trueDurations.get(createDirectedEdgeKey(a,b)),0))
  const valid=durations.some(t=>t>=range.minSeconds&&t<=range.maxSeconds)
  done.push(valid)
  if(valid){accepted=true;successfulIndex=i;break}
 }
 return {accepted,successfulIndex,requestCount}
}
const kinds=['short-singletons','mixed','long-singletons']
let reports=[]
for(const kind of kinds){
 const totals={oldSuccess:0,newSuccess:0,oldRequests:0,newRequests:0,oldFirstIndex:0,newFirstIndex:0,addedPairs:0}
 for(let n=0;n<N;n++){
  const scenario=makeScenario(kind,1000+10007*n)
  const ai=scenario.pois.slice(0,5).map(p=>({waypoints:[{poiId:p.poiId}]}))
  const modified=rankInitialCandidates({candidates:ai,verifiedWaypointPool:scenario.pois,
   location:start,preferences:{durationMinutes:TARGET,routeType:'out_and_back',
     environmentPreferences:['公园']}})
  assert.equal(modified.candidates.length,5)
  assert.ok(modified.supplementalPairCount<=2)
  for(let i=0;i<modified.candidates.length;i++)
   for(let j=i+1;j<modified.candidates.length;j++)
    assert.equal(conflictsBySubset(
     modified.candidates[i].waypoints.map(p=>p.poiId),
     modified.candidates[j].waypoints.map(p=>p.poiId)),false)
  const a=replay(ai,scenario),b=replay(modified.candidates,scenario)
  totals.oldSuccess+=Number(a.accepted)
  totals.newSuccess+=Number(b.accepted)
  totals.oldRequests+=a.requestCount
  totals.newRequests+=b.requestCount
  totals.oldFirstIndex+=a.accepted?a.successfulIndex+1:6
  totals.newFirstIndex+=b.accepted?b.successfulIndex+1:6
  totals.addedPairs+=modified.supplementalPairCount
 }
 reports.push({
  kind,fixtures:N,
  oldFirstBatchSuccess:totals.oldSuccess,
  hybridFirstBatchSuccess:totals.newSuccess,
  meanAttemptedCandidatesOld:Number((totals.oldFirstIndex/N).toFixed(2)),
  meanAttemptedCandidatesHybrid:Number((totals.newFirstIndex/N).toFixed(2)),
  meanNewMockSegmentsOld:Number((totals.oldRequests/N).toFixed(2)),
  meanNewMockSegmentsHybrid:Number((totals.newRequests/N).toFixed(2)),
  meanSupplementalPairs:Number((totals.addedPairs/N).toFixed(2))
 })
}
console.log(JSON.stringify({disclaimer:'OFFLINE SYNTHETIC; real Tencent latency and AI quality unknown',reports},null,2))
