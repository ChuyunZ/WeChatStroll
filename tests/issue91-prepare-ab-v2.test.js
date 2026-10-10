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
