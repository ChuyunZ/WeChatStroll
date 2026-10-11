'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { buildTemporaryIndex, replaceExactlyOnce, BASELINE, TREATMENT } =
  require('../scripts/issue91-prepare-ab-v2')

const production = fs.readFileSync(
  path.join(__dirname, '../cloudfunctions/aiRoutePlanner/index.js'), 'utf8'
)

test('temporary A/B index preserves production behavior and adds diagnostics', () => {
  const result = buildTemporaryIndex(production)
  expect(() => new vm.Script(result)).not.toThrow()
  expect(result).toContain('buildBaselinePrompt')
  expect(result).toContain('parseAndValidateRoutePlanWithDiagnostics')
  expect(result).toContain('abDiagnostics: diagnostics')
  expect(result).toContain('abVariant: variant')
  expect(result).toContain('diagnosticVersion: 2')
  expect(result).toContain('aiCalls: 0')
  expect(result).toContain('variant === "baseline" ? buildBaselinePrompt : buildRoutePlanningPrompt')
  expect(result).toContain('if (!planResult.success) return planResult')
  expect(result).toContain('return normalizeErrorResponse(result)')
  expect(result).not.toContain('wx.cloud.callFunction')
  expect(BASELINE).toMatch(/^[a-f0-9]{40}$/)
  expect(TREATMENT).toMatch(/^[a-f0-9]{40}$/)
})

test('fails closed if code anchors change', () => {
  expect(() => buildTemporaryIndex('exports.main = async (event) => {}')).toThrow(/exactly one/)
  expect(() => replaceExactlyOnce('abc abc', 'abc', 'x', 'example')).toThrow(/exactly one/)
})

test('LF and CRLF checkouts produce identical executable temporary functions', () => {
  const lf = production.replace(/\r\n/g, '\n')
  expect(buildTemporaryIndex(lf.replace(/\n/g, '\r\n'))).toBe(buildTemporaryIndex(lf))
})


test('generated temporary function selects the pinned prompt and returns aggregate diagnostics', async () => {
  const requests = jest.fn().mockResolvedValue({ success: true, data: { text: 'synthetic-json' } })
  const oldPrompt = jest.fn().mockReturnValue({ success: true, data: { prompt: 'previous-treatment' } })
  const newPrompt = jest.fn().mockReturnValue({ success: true, data: { prompt: 'new-self-check' } })
  const diagnostics = {
    schemaVersion: 1,
    rawCandidateCount: 5,
    structurallyValidCount: 5,
    retainedCandidateCount: 3,
    removedCandidateCount: 2,
    removedByReason: { subset_conflict: 2 }
  }
  const parse = jest.fn().mockReturnValue({
    result: { success: true, data: { candidates: [{ waypoints: [{ poiId: 'synthetic-A' }] }] } },
    diagnostics
  })
  const cloud = {
    init: jest.fn(),
    DYNAMIC_CURRENT_ENV: 'test',
    ai: jest.fn(() => ({ createModel: jest.fn(() => ({})) }))
  }
  const logs = { log: jest.fn(), error: jest.fn(), warn: jest.fn() }
  const exported = {}
  const dependency = name => {
    if (name === 'wx-server-sdk') return cloud
    if (name === './aiClient') return { createAiClient: () => ({ request: requests }) }
    if (name === './routePlanningPrompt') return { buildRoutePlanningPrompt: newPrompt }
    if (name === './routePlanningPromptBaseline') return { buildRoutePlanningPrompt: oldPrompt }
    if (name === './routePlanContract') {
      return { parseAndValidateRoutePlanWithDiagnostics: parse }
    }
    throw new Error('Unexpected dependency ' + name)
  }
  vm.runInNewContext(buildTemporaryIndex(production), {
    exports: exported, require: dependency, console: logs
  })
  const health = await exported.main({ __issue91DiagnosticProbe: true })
  expect(health).toMatchObject({ success: true, diagnosticVersion: 2, aiCalls: 0,
    treatmentCommit: '3f0134a' })
  expect(cloud.ai).not.toHaveBeenCalled()
  expect(requests).not.toHaveBeenCalled()

  const prior = await exported.main({ promptVariant: 'baseline' })
  const current = await exported.main({ promptVariant: 'treatment' })
  expect(requests.mock.calls.map(args => args[0])).toEqual([
    'previous-treatment', 'new-self-check'
  ])
  expect(oldPrompt).toHaveBeenCalledTimes(1)
  expect(newPrompt).toHaveBeenCalledTimes(1)
  expect(parse).toHaveBeenCalledTimes(2)
  expect(cloud.ai).toHaveBeenCalledTimes(1)
  expect(prior).toMatchObject({ success: true, abVariant: 'baseline', abDiagnostics: diagnostics })
  expect(current).toMatchObject({ success: true, abVariant: 'treatment', abDiagnostics: diagnostics })
  expect(prior.plan.candidates).toHaveLength(1)
  expect(logs.log).toHaveBeenCalledTimes(2)
  expect(logs.log.mock.calls.map(args => args[0])).toEqual([
    '[AI Route Planner] Contract summary:', '[AI Route Planner] Contract summary:'
  ])
})
