// Admin-only, scheduled CloudBase scanner. This module has NO trigger or
// credentials of its own; the operator must separately deny client invocation.
const { sweepIngressCandidates, MAX_BATCH } = require('./retention')
const COLLECTION = 'map_planning_quotas'
const CONTROL_ID = 'retention_control'
const MIN_RUN_INTERVAL_MS = 20 * 60 * 60 * 1000
const MAX_PAGES = 4
const FIRST_ID = 'ingress_'
const AFTER_LAST_ID = 'ingress`'
const ID_RE = /^ingress_[a-f0-9]{24}$/

function checkControl(data, time) {
  if (!data) return { cursor: null, lastStartedMs: null }
  if (typeof data !== 'object' || Array.isArray(data) ||
      (data._id !== undefined && data._id !== CONTROL_ID) ||
      (data.cursor !== null && (typeof data.cursor !== 'string' || !ID_RE.test(data.cursor))) ||
      !Number.isSafeInteger(data.lastStartedMs) || data.lastStartedMs < 0 ||
      data.lastStartedMs > time) throw new Error('Invalid cleanup control ledger')
  return { cursor: data.cursor, lastStartedMs: data.lastStartedMs }
}
function verifyClock(time) {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid server clock')
}
async function transaction(db, work) {
  const tx = await db.startTransaction()
  try {
    const doc = id => tx.collection(COLLECTION).doc(id)
    const result = await work({
      get: async id => {
        const response = await doc(id).get()
        return response && response.data ? response.data : null
      },
      set: async (id, data) => doc(id).set({ data }),
      delete: async id => doc(id).delete()
    })
    await tx.commit()
    return result
  } catch (error) {
    try { await tx.rollback() } catch (_) { /* outcome unknown: retry later */ }
    throw error
  }
}

async function reserveDailyRun(db, time) {
  return transaction(db, async tx => {
    const state = checkControl(await tx.get(CONTROL_ID), time)
    if (state.lastStartedMs !== null &&
        time - state.lastStartedMs < MIN_RUN_INTERVAL_MS) {
      return { skip: true }
    }
    await tx.set(CONTROL_ID, { cursor: state.cursor, lastStartedMs: time })
    return { skip: false, cursor: state.cursor }
  })
}
async function saveCursor(db, time, cursor) {
  await transaction(db, async tx => {
    const state = checkControl(await tx.get(CONTROL_ID), time)
    // Fail closed if another administrator changed the cursor or run epoch.
    if (state.lastStartedMs !== time) throw new Error('Cleanup run replaced')
    await tx.set(CONTROL_ID, { cursor, lastStartedMs: time })
  })
}
async function listNextPage(db, cursor) {
  const command = db.command
  if (!command || typeof command.gte !== 'function' || typeof command.gt !== 'function' ||
      typeof command.lt !== 'function') throw new Error('Missing database query support')
  const min = cursor ? command.gt(cursor) : command.gte(FIRST_ID)
  const filter = min.and(command.lt(AFTER_LAST_ID))
  const result = await db.collection(COLLECTION)
    .where({ _id: filter }).orderBy('_id', 'asc').limit(MAX_BATCH).get()
  if (!result || !Array.isArray(result.data) || result.data.length > MAX_BATCH) {
    throw new Error('Invalid paginated result')
  }
  let previous = cursor || ''
  for (const item of result.data) {
    if (!item || typeof item._id !== 'string' ||
        item._id <= previous || item._id < FIRST_ID || item._id >= AFTER_LAST_ID) {
      throw new Error('Invalid or unsorted database scan')
    }
    previous = item._id
  }
  return result.data.map(item => item._id)
}

async function runCleanup({ db, now = Date.now, mode = 'dry-run' }) {
  if (!db || typeof db.startTransaction !== 'function' || typeof now !== 'function' ||
      !['dry-run', 'delete'].includes(mode)) throw new Error('Invalid cleanup configuration')
  const time = now()
  verifyClock(time)
  const claim = await reserveDailyRun(db, time)
  if (claim.skip) return { success: true, skipped: true, reason: 'recent_run' }
  const summary = { success: true, dryRun: mode === 'dry-run', scanned: 0, eligible: 0,
    deleted: 0, skipped: 0, failed: 0, pages: 0, cycleComplete: false }
  let cursor = claim.cursor
  for (let page = 0; page < MAX_PAGES; page++) {
    const ids = await listNextPage(db, cursor)
    // The range can include unknown/foreign documents; never delete them.
    const valid = ids.filter(id => ID_RE.test(id))
    const report = await sweepIngressCandidates({
      candidateIds: valid, now, dryRun: mode !== 'delete',
      approval: mode === 'delete' ? 'DELETE_EXPIRED_INGRESS' : undefined,
      transact: work => transaction(db, work)
    })
    summary.pages++
    summary.scanned += ids.length
    summary.eligible += report.eligible
    summary.deleted += report.deleted
    summary.skipped += (ids.length - valid.length) + report.skipped
    summary.failed += report.failed
    if (ids.length < MAX_BATCH) {
      cursor = null
      summary.cycleComplete = true
      break
    }
    cursor = ids[ids.length - 1]
  }
  // Save scan progress only after processing, and fail closed on checkpoint
  // failure. A fresh invocation cannot start for another 20 hours.
  await saveCursor(db, time, cursor)
  return summary
}
module.exports = { runCleanup, listNextPage, transaction, CONTROL_ID,
  MIN_RUN_INTERVAL_MS, MAX_PAGES }
