#!/usr/bin/env node
'use strict'

// Prepare only the existing temporary CloudBase A/B function, without deployment or AI calls.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const BASELINE = '72f8155087b86e95ddeff5795cf85a2a9b14f2c4'
const TREATMENT = '3f0134a67cdfd9df7b01f6a28c215f72724c600b'
const SOURCE_DIR = 'cloudfunctions/aiRoutePlanner/'
const DEST_DIR = 'cloudfunctions/aiRoutePlannerIssue91AB'

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search)
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error('Expected exactly one ' + label + ' anchor; production source changed')
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length)
}

function buildTemporaryIndex(production) {
  // Git on Windows may check out CRLF; anchors intentionally use canonical LF.
  production = production.replace(/\r\n/g, '\n')
  let source = replaceExactlyOnce(
    production,
    'const { buildRoutePlanningPrompt } = require("./routePlanningPrompt")',
    'const { buildRoutePlanningPrompt } = require("./routePlanningPrompt")\n' +
      'const { buildRoutePlanningPrompt: buildBaselinePrompt } = require("./routePlanningPromptBaseline")',
    'prompt import'
  )
  source = replaceExactlyOnce(
    source,
    'exports.main = async (event) => {\n',
    'exports.main = async (event) => {\n' +
      '  if (event && event.__issue91DiagnosticProbe === true) {\n' +
      '    return { success: true, diagnosticVersion: 2, aiCalls: 0,\n' +
      "      treatmentCommit: '3f0134a' }\n" +
      '  }\n',
    'function entry'
  )
  source = replaceExactlyOnce(
    source,
    '  const promptResult =\n    buildRoutePlanningPrompt({',
    '  const variant = normalizedEvent.promptVariant\n' +
      '  if (variant !== "baseline" && variant !== "treatment") {\n' +
      '    return { success: false, error: "INVALID_PROMPT_VARIANT" }\n' +
      '  }\n' +
      '  const promptBuilder = variant === "baseline" ? buildBaselinePrompt : buildRoutePlanningPrompt\n' +
      '  const promptResult =\n    promptBuilder({',
    'prompt selection'
  )
  source = replaceExactlyOnce(
    source,
    '    plan: planResult.data\n  }',
    '    plan: planResult.data,\n' +
      '    abVariant: variant,\n' +
      '    abDiagnostics: diagnostics\n  }',
    'diagnostics return'
  )
  return source
}

function gitShow(root, sha, filename) {
  try {
    return execFileSync('git', ['show', sha + ':' + SOURCE_DIR + filename], {
      cwd: root, encoding: 'utf8', maxBuffer: 6 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw new Error('Cannot read ' + sha.slice(0, 7) + ':' + filename +
      '. Run git fetch origin develop fix/issue-91-correction-benchmark first.')
  }
}

function run() {
  const root = path.resolve(__dirname, '..')
  const destination = path.join(root, DEST_DIR)
  if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory() ||
      fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error('Expected existing non-symlink temporary A/B directory: ' + DEST_DIR)
  }
  const names = ['index.js', 'routePlanningPrompt.js', 'routePlanningPromptBaseline.js',
    'routePlanContract.js', 'aiClient.js', 'config.js', 'package.json', 'package-lock.json']

  const staged = {}
  for (const filename of names) {
    const target = path.join(destination, filename)
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Refusing symlink target: ' + filename)
    }
    staged[filename] = filename === 'routePlanningPromptBaseline.js'
      ? gitShow(root, BASELINE, 'routePlanningPrompt.js')
      : filename === 'index.js'
        ? buildTemporaryIndex(gitShow(root, TREATMENT, filename))
        : gitShow(root, TREATMENT, filename)
  }

  if (!staged['routePlanningPrompt.js'].includes('BATCH CONSTRUCTION AND SILENT SELF-CHECK') ||
      staged['routePlanningPromptBaseline.js'].includes('BATCH CONSTRUCTION AND SILENT SELF-CHECK') ||
      !staged['routePlanContract.js'].includes('parseAndValidateRoutePlanWithDiagnostics')) {
    throw new Error('Pinned baseline/treatment/contract mismatch; refusing to write')
  }

  for (const filename of names) {
    if (filename.endsWith('.json')) JSON.parse(staged[filename])
    if (filename.endsWith('.js')) {
      const checkPath = path.join(os.tmpdir(), 'issue91-check-' + process.pid + '-' + filename)
      try {
        fs.writeFileSync(checkPath, staged[filename])
        execFileSync('node', ['--check', checkPath], { stdio: 'pipe' })
      } finally {
        if (fs.existsSync(checkPath)) fs.unlinkSync(checkPath)
      }
    }
  }

  // Keep a recoverable local backup outside cloudfunctions so it is not deployed.
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'issue91-ab-backup-'))
  for (const filename of names) {
    const previous = path.join(destination, filename)
    if (fs.existsSync(previous)) fs.copyFileSync(previous, path.join(backup, filename))
  }
  for (const filename of names) {
    fs.writeFileSync(path.join(destination, filename), staged[filename])
  }
  console.log('Prepared local-only ' + DEST_DIR)
  console.log('Baseline ' + BASELINE.slice(0, 7) + ' / treatment ' + TREATMENT.slice(0, 7))
  console.log('Probe version 2, then inspect result.abDiagnostics.removedByReason')
  console.log('Backup: ' + backup)
  console.log('No cloud deployment, model calls, or tracked source edits were performed.')
}

if (require.main === module) {
  try { run() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { buildTemporaryIndex, replaceExactlyOnce, BASELINE, TREATMENT }
