#!/usr/bin/env node
'use strict'
/*
 * Issue #91: deterministic, reproducible, OFFLINE correction microbenchmark.
 * Run inside the real repository (after applying Issue #91 changes):
 *   node tests/benchmarks/issue91_route_correction_benchmark.cjs
 * Or: WECHATSTROLL_ROOT=/path/to/WeChatStroll node issue91_route_correction_benchmark.cjs
 *
 * Loads the ACTUAL route-correction and route-graph modules from the selected
 * checkout. The Walking Segment provider and candidate builder are MOCKED.
 * No Tencent API request, no cloud/AI calls, and no production-latency claims.
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const ROOT = path.resolve(process.env.WECHATSTROLL_ROOT || process.cwd())
const { runBoundedRouteCorrections } = require(path.join(ROOT, 'miniprogram/services/route-correction.js'))
const { createStartNode, createDirectedEdgeKey, buildPrefetchEdgePairs,
  buildTraversalNodes, buildEdgePairs } = require(path.join(ROOT, 'miniprogram/services/route-graph.js'))
const { ROUTE_TYPES } = require(path.join(ROOT, 'miniprogram/constants/route-types.js'))
const { MAX_CORRECTION_CANDIDATES, MAX_CORRECTION_NEW_SEGMENTS } =
  require(path.join(ROOT, 'miniprogram/config/route-planning.js'))

const TARGET_SECONDS = 1800
const MIN_SECONDS = 1350
const MAX_SECONDS = 2250
const START = { latitude: 45.5, longitude: -73.6 }
const POIS = 'ABCDEFGH'.split('').map((poiId, i) => ({
  poiId, name: `POI ${poiId}`, latitude: 45.5 + i * 0.0007,
  longitude: -73.6 + i * 0.0005
}))
const BY_ID = new Map(POIS.map(p => [p.poiId, p]))
// One independently verified too-long singleton, seven too-short singletons.
const SINGLETON_SECONDS = { A: 2580, B: 900, C: 1000, D: 720,
  E: 1100, F: 900, G: 1000, H: 800 }
const KINDS = ['balanced', 'needle-in-haystack', 'directional', 'impossible', 'partly-cached']
const REPS = Math.max(1, Math.min(3000, Number(process.env.BENCHMARK_SCENARIOS || 250)))
const BUDGET = Number(process.env.BENCHMARK_SEGMENT_BUDGET || MAX_CORRECTION_NEW_SEGMENTS)
const CANDIDATES = Number(process.env.BENCHMARK_CANDIDATE_BUDGET || MAX_CORRECTION_CANDIDATES)

function rng(seed) { let x = seed >>> 0; return () => {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0
  return x / 4294967296
} }
function edgeKey(a, b) { return createDirectedEdgeKey(a, b) }
function waypoint(id) { return { ...BY_ID.get(id), nodeId: id, nodeType: 'waypoint' } }
function successCost(seconds) { return { success: true, durationSeconds: seconds, distanceMeters: seconds * 1.3 } }
function pctl(values, p) {
  if (!values.length) return null
  const copy = [...values].sort((a,b) => a-b)
  return copy[Math.min(copy.length - 1, Math.ceil(copy.length * p) - 1)]
}
function createScenario(kind, seed) {
  const random = rng(seed)
  const nodes = new Map(POIS.map(p => [p.poiId, waypoint(p.poiId)]))
  const start = createStartNode(START)
  const initial = new Map()
  const truth = new Map()
  for (const poi of POIS) {
    const node = nodes.get(poi.poiId)
    const seconds = SINGLETON_SECONDS[poi.poiId] / 2
    initial.set(edgeKey(start, node), successCost(seconds))
    initial.set(edgeKey(node, start), successCost(seconds))
  }
  for (const a of POIS) for (const b of POIS) if (a.poiId !== b.poiId) {
    let seconds
    if (kind === 'impossible') seconds = 1800 + Math.floor(random() * 500)
    else if (kind === 'needle-in-haystack') {
      // Every pair is impossible except ONE chosen adversarially below.
      seconds = 1600 + Math.floor(random() * 400)
    } else if (kind === 'directional') {
      seconds = 100 + Math.floor(random() * 1600)
    } else {
      seconds = 150 + Math.floor(random() * 1000)
    }
    truth.set(edgeKey(nodes.get(a.poiId), nodes.get(b.poiId)), successCost(seconds))
  }
  if (kind === 'needle-in-haystack') {
    const shortIds = POIS.slice(1).map(p => p.poiId)
    const pairs = []
    for (let i = 0; i < shortIds.length; i++)
      for (let j = i + 1; j < shortIds.length; j++) pairs.push([shortIds[i], shortIds[j]])
    const [a, b] = pairs[Math.floor(random() * pairs.length)]
    const ab = 315 + Math.floor(random() * 130)
    const ba = 315 + Math.floor(random() * 130)
    truth.set(edgeKey(nodes.get(a), nodes.get(b)), successCost(ab))
    truth.set(edgeKey(nodes.get(b), nodes.get(a)), successCost(ba))
  }
  if (kind === 'partly-cached') {
    // Mimics prior failed candidate exploration settling some cross-POI facts.
    for (const [key, fact] of truth) if (random() < 0.09) initial.set(key, fact)
  }
  const cache = new Map(initial)
  let mapRequests = 0
  let cacheHit = 0
  let correctionBuilds = 0
  const session = {
    getCachedSegmentCosts: () => [...cache].map(([edgeKey, fact]) => ({ edgeKey, ...fact })),
    getWaypointSearchData: ids => ({
      valid: ids.every(id => BY_ID.has(id)), start: START,
      routeType: ROUTE_TYPES.OUT_AND_BACK,
      waypoints: ids.map(id => BY_ID.get(id)).filter(Boolean)
    })
  }
  function segmentSeconds(a, b) {
    const fact = initial.get(edgeKey(a, b)) || truth.get(edgeKey(a, b))
    assert.ok(fact, `No mock fact for ${a.nodeId} → ${b.nodeId}`)
    return fact.durationSeconds
  }
  function routeDuration(ids) {
    const walk = buildTraversalNodes(start, ids.map(id => nodes.get(id)), ROUTE_TYPES.OUT_AND_BACK)
    return buildEdgePairs(walk).reduce((sum, [a,b]) => sum + segmentSeconds(a,b), 0)
  }
  function isValidPair(ids) {
    return routeDuration(ids) >= MIN_SECONDS && routeDuration(ids) <= MAX_SECONDS
  }
  const feasiblePairs = []
  for (let i = 0; i < POIS.length; i++) for (let j = i + 1; j < POIS.length; j++) {
    const a = POIS[i].poiId, b = POIS[j].poiId
    if (isValidPair([a,b]) || isValidPair([b,a])) feasiblePairs.push([a,b])
  }
  async function buildCandidateRoute({ candidate, candidateCache }) {
    correctionBuilds++
    assert.ok(candidateCache.markBuilding(candidate.candidateId))
    const ids = candidate.waypointIds
    const routeNodes = ids.map(id => nodes.get(id))
    for (const [a,b] of buildPrefetchEdgePairs(start, routeNodes, ROUTE_TYPES.OUT_AND_BACK)) {
      const key = edgeKey(a,b)
      if (cache.has(key)) { cacheHit++; continue }
      mapRequests++
      const fact = truth.get(key)
      assert.ok(fact, `Missing directional segment ${a.nodeId} → ${b.nodeId}`)
      cache.set(key, fact)
    }
    // For pairs this enumerates every feasible traversal order. We deliberately
    // do not simulate the full production optimization of 3/4 POIs here.
    const orders = [ids, [...ids].reverse()]
    const durations = orders.map(routeDuration)
    const validIndex = durations.findIndex(d => d >= MIN_SECONDS && d <= MAX_SECONDS)
    if (validIndex >= 0) {
      const route = { routeId: `mock-${ids.join('-')}`,
        durationSeconds: durations[validIndex], recommendedWaypointIds: orders[validIndex] }
      candidateCache.markSuccess(candidate.candidateId, route)
      return { success: true, route }
    }
    candidateCache.markFailed(candidate.candidateId)
    const actual = durations[0]
    return { success: false, error: 'ROUTE_VALIDATION_FAILED',
      reason: 'ROUTE_DURATION_OUT_OF_RANGE', actualDurationSeconds: actual,
      targetDurationSeconds: TARGET_SECONDS, minDurationSeconds: MIN_SECONDS,
      maxDurationSeconds: MAX_SECONDS }
  }
  return { session, buildCandidateRoute, feasiblePairs,
    getMetrics: () => ({ mapRequests, cacheHit, correctionBuilds }) }
}

async function runCase(kind, budget, candidateBudget) {
  const rows = []
  for (let i=0; i<REPS; i++) {
    const seed = 92087 + i * 1973 + KINDS.indexOf(kind) * 104729
    const s = createScenario(kind, seed)
    const before = performance.now()
    const result = await runBoundedRouteCorrections({
      session: s.session,
      verifiedWaypointPool: POIS,
      excludedWaypointSets: POIS.map(p => [p.poiId]), // all singletons exhausted
      requestedDurationMinutes: 30,
      allowPairFallback: true,
      buildCandidateRoute: s.buildCandidateRoute,
      maxCandidates: candidateBudget,
      maxNewSegmentCalls: budget
    })
    const cpuMs = performance.now() - before
    const m = s.getMetrics()
    // Safety claims that can be checked in this deterministic oracle.
    assert.ok(m.mapRequests <= budget, `Exceeded map-call budget: ${m.mapRequests}/${budget}`)
    assert.ok(m.correctionBuilds <= candidateBudget, 'Exceeded candidate budget')
    if (result.success) {
      assert.ok(result.route.durationSeconds >= MIN_SECONDS && result.route.durationSeconds <= MAX_SECONDS)
      assert.ok(result.route.recommendedWaypointIds.every(id => BY_ID.has(id)))
    }
    rows.push({ feasible: s.feasiblePairs.length > 0, success: result.success,
      ...m, cpuMs, attemptedCandidates: result.attemptedCandidates,
      feasiblePairCount: s.feasiblePairs.length })
  }
  const feasible = rows.filter(r => r.feasible)
  const succeeded = rows.filter(r => r.success)
  const missed = feasible.filter(r => !r.success)
  const falseSuccess = succeeded.filter(r => !r.feasible)
  assert.equal(falseSuccess.length, 0, 'Accepted a pair when exhaustive oracle found no valid pair')
  return {
    scenario: kind, instances: rows.length, oracleFeasible: feasible.length,
    success: succeeded.length, missedFeasible: missed.length,
    feasibleRecall: feasible.length ? +(succeeded.length / feasible.length).toFixed(3) : null,
    avgMapRequests: +(rows.reduce((n,r) => n + r.mapRequests,0)/rows.length).toFixed(2),
    p95MapRequests: pctl(rows.map(r=>r.mapRequests), .95),
    maxMapRequests: Math.max(...rows.map(r=>r.mapRequests)),
    avgCacheHits: +(rows.reduce((n,r) => n + r.cacheHit,0)/rows.length).toFixed(2),
    avgCorrections: +(rows.reduce((n,r) => n + r.correctionBuilds,0)/rows.length).toFixed(2),
    p95CpuMs: +pctl(rows.map(r=>r.cpuMs), .95).toFixed(3)
  }
}

async function main() {
  console.log(JSON.stringify({
    disclaimer: 'OFFLINE SYNTHETIC ORACLE. NO REAL TENCENT/AI LATENCY, FULL BUILDER OR E2E.',
    branchCheckout: ROOT, routeType: 'out_and_back', targetMinutes: 30,
    validDurationSeconds: [MIN_SECONDS, MAX_SECONDS], verifiedPois: POIS.length,
    exhaustedSingletons: POIS.length,
    correctionCandidateBudget: CANDIDATES, correctionNewSegmentBudget: BUDGET,
    sampleCountPerScenario: REPS,
    baselineBehavior: 'When new AI batches are empty and all previous singleton candidates were exhausted, pre-correction manual search cannot discover a new pair. No baseline Tencent costs are attributed to this post-exhaustion step.',
    comparison: await Promise.all(KINDS.map(kind => runCase(kind, BUDGET, CANDIDATES)))
  },null,2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
