const {
  parseAndValidateRoutePlan,
  parseAndValidateRoutePlanWithDiagnostics,
  validateRoutePlan
} = require('./routePlanContract')

// Synthetic labels only; no captured user/model payloads.
const pool = 'ABCDEFGHIJKL'.split('').map(poiId => ({ poiId }))
const candidate = (...ids) => ({ waypoints: ids.map(poiId => ({ poiId })) })
const analyze = candidates => parseAndValidateRoutePlanWithDiagnostics(
  JSON.stringify({ candidates }), pool)
const counts = diagnostics => Object.values(diagnostics.removedByReason).reduce((a, b) => a + b, 0)

test.each([
  ['null candidate', null, 'malformed_structure'],
  ['extra candidate field', { ...candidate('A'), text: 'PRIVATE' }, 'malformed_structure'],
  ['missing waypoints', {}, 'malformed_structure'],
  ['non-array waypoints', { waypoints: {} }, 'malformed_structure'],
  ['null waypoint', { waypoints: [null] }, 'malformed_structure'],
  ['extra waypoint field', { waypoints: [{ poiId: 'A', latitude: 12.345678 }] }, 'malformed_structure'],
  ['blank ID', candidate(' '), 'malformed_structure'],
  ['numeric ID', candidate(1), 'malformed_structure'],
  ['zero waypoints', candidate(), 'waypoint_count'],
  ['nine waypoints', candidate(...'ABCDEFGHI'), 'waypoint_count'],
  ['unknown POI', candidate('PRIVATE_UNKNOWN'), 'unverified_poi'],
  ['repeated trimmed ID', candidate('A', ' A '), 'repeated_id']
])('counts %s without discarding a valid sibling', (_, invalid, reason) => {
  const { result, diagnostics } = analyze([invalid, candidate('L')])
  expect(result).toEqual({ success: true, data: { candidates: [candidate('L')] } })
  expect(diagnostics).toMatchObject({ rawCandidateCount: 2, structurallyValidCount: 1,
    retainedCandidateCount: 1, removedCandidateCount: 1, planRejectionReason: null })
  expect(diagnostics.removedByReason[reason]).toBe(1)
  expect(counts(diagnostics)).toBe(1)
  expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|12\.345678/)
})

test('one primary reason per discarded candidate follows first failing check', () => {
  const { diagnostics } = analyze([candidate('A', 'A', 'UNKNOWN'), candidate('UNKNOWN', 'UNKNOWN')])
  expect(diagnostics.planRejectionReason).toBe('no_valid_candidates')
  expect(diagnostics.removedByReason.repeated_id).toBe(1)
  expect(diagnostics.removedByReason.unverified_poi).toBe(1)
  expect(counts(diagnostics)).toBe(2)
})

test('duplicate sets ignore visit order and trim IDs; partial overlap remains allowed', () => {
  const { result, diagnostics } = analyze([
    candidate('A', 'B'), candidate(' B ', ' A '), candidate('A', 'C')
  ])
  expect(result.data.candidates).toEqual([candidate('A', 'B'), candidate('A', 'C')])
  expect(diagnostics.removedByReason.duplicate_set).toBe(1)
  expect(diagnostics.removedByReason.subset_conflict).toBe(0)
  expect(counts(diagnostics)).toBe(1)
})

test.each([
  [candidate('A'), candidate('A', 'B')],
  [candidate('A', 'B'), candidate('A')],
  [candidate('A', 'B'), candidate('A', 'B', 'C')],
  [candidate('A', 'B', 'C'), candidate('A', 'B')]
])('strict containment in either direction consumes only one slot', (first, second) => {
  const { result, diagnostics } = analyze([first, second])
  expect(result.data.candidates).toEqual([first])
  expect(diagnostics.removedByReason.subset_conflict).toBe(1)
  expect(diagnostics.removedByReason.duplicate_set).toBe(0)
})

test('maximum compatible selection beats a greedy first-set policy', () => {
  const sets = [candidate('A', 'B', 'C'), candidate('A'), candidate('B'), candidate('C')]
  const { result, diagnostics } = analyze(sets)
  expect(result.data.candidates).toEqual(sets.slice(1))
  expect(diagnostics.removedByReason.subset_conflict).toBe(1)
})

test('rejected duplicates of a rejected superset are classified against retained sets', () => {
  const { result, diagnostics } = analyze([
    candidate('A', 'B'), candidate('B', 'A'), candidate('A'), candidate('B'), candidate('C')
  ])
  expect(result.data.candidates).toEqual([candidate('A'), candidate('B'), candidate('C')])
  expect(diagnostics.removedByReason.subset_conflict).toBe(2)
  expect(diagnostics.removedByReason.duplicate_set).toBe(0)
})

test.each([
  ['subset conflicts', [candidate('A'), candidate('A', 'B'), candidate('C'), candidate('C', 'D'), candidate('E')],
    { subset_conflict: 2 }],
  ['invalid candidates', [candidate('A'), candidate('B'), candidate('C'), candidate('UNKNOWN'), candidate('D', 'D')],
    { unverified_poi: 1, repeated_id: 1 }]
])('five-to-three alone cannot identify the cause: %s', (_, sets, reasons) => {
  const { result, diagnostics } = analyze(sets)
  expect(result.data.candidates).toHaveLength(3)
  expect(diagnostics).toMatchObject({ rawCandidateCount: 5, retainedCandidateCount: 3,
    removedCandidateCount: 2, removedByReason: reasons })
  expect(counts(diagnostics)).toBe(2)
})

test('compatible mixed five-slot example retains every set in its original order', () => {
  const sets = [candidate('A', 'B'), candidate('A', 'C'), candidate('B', 'C'), candidate('D'), candidate('E')]
  const { result, diagnostics } = analyze(sets)
  expect(result.data.candidates).toEqual(sets)
  expect(diagnostics).toMatchObject({ rawCandidateCount: 5, structurallyValidCount: 5,
    retainedCandidateCount: 5, structurallyValidMultiPoiCount: 3, retainedMultiPoiCount: 3,
    removedCandidateCount: 0 })
  expect(counts(diagnostics)).toBe(0)
})

test.each([
  ['not json PRIVATE', pool, 'invalid_json', null],
  ['null', pool, 'malformed_plan', null],
  [JSON.stringify({ candidates: [], secret: 'PRIVATE' }), pool, 'malformed_plan', 0],
  [JSON.stringify({ candidates: Array(6).fill(candidate('A')) }), pool, 'candidate_count', 6],
  [JSON.stringify({ candidates: [candidate('A')] }), null, 'invalid_poi_pool', 1],
  [JSON.stringify({ candidates: [candidate('UNKNOWN')] }), pool, 'no_valid_candidates', 1]
])('whole-plan errors remain distinct from a legitimate empty batch (%#)', (raw, pois, reason, rawCount) => {
  const { result, diagnostics } = parseAndValidateRoutePlanWithDiagnostics(raw, pois)
  expect(result).toEqual({ success: false, error: 'INVALID_AI_ROUTE_PLAN' })
  expect(parseAndValidateRoutePlan(raw, pois)).toEqual(result)
  expect(diagnostics.planRejectionReason).toBe(reason)
  expect(diagnostics.rawCandidateCount).toBe(rawCount)
  expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE')
})

test('empty response is successful, and diagnostics do not accumulate across requests', () => {
  analyze([candidate('UNKNOWN')])
  const { result, diagnostics } = analyze([])
  expect(result).toEqual({ success: true, data: { candidates: [] } })
  expect(diagnostics).toMatchObject({ rawCandidateCount: 0, retainedCandidateCount: 0,
    removedCandidateCount: 0, planRejectionReason: null })
  expect(counts(diagnostics)).toBe(0)
})

test('all 2,401 ordered four-slot batches over three synthetic POIs match an independent maximum-size oracle', () => {
  // Bit masks independently model set containment, including equal sets.
  const conflicts = (a, b) => (a & b) === a || (a & b) === b
  for (let code = 0; code < 7 ** 4; code++) {
    let remaining = code
    const masks = Array.from({ length: 4 }, () => {
      const mask = remaining % 7 + 1
      remaining = Math.floor(remaining / 7)
      return mask
    })
    let maximum = 0
    for (let selection = 0; selection < 16; selection++) {
      const selected = masks.filter((_, i) => selection & (1 << i))
      if (selected.every((a, i) => selected.slice(i + 1).every(b => !conflicts(a, b)))) {
        maximum = Math.max(maximum, selected.length)
      }
    }
    const sets = masks.map(mask => candidate(...'ABC'.split('').filter((_, i) => mask & (1 << i))))
    const { result, diagnostics } = analyze(sets)
    expect(result.data.candidates).toHaveLength(maximum)
    expect(result).toEqual(validateRoutePlan({ candidates: sets }, pool))
    expect(counts(diagnostics)).toBe(4 - maximum)
    const retained = result.data.candidates.map(c =>
      c.waypoints.reduce((mask, w) => mask | (1 << 'ABC'.indexOf(w.poiId)), 0))
    expect(retained.every((a, i) => retained.slice(i + 1).every(b => !conflicts(a, b)))).toBe(true)
  }
})
