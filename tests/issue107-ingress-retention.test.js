const { canDeleteQuotaRecord } = require('../scripts/issue107-quota-retention.cjs')
const {
  canDeleteIngressRecord, sweepIngressCandidates, INGRESS_RETENTION_MS, MAX_BATCH
} = require('../scripts/issue107-ingress-retention.cjs')
const { DAY } = require('../cloudfunctions/mapProvider/quota')

const owner = 'a'.repeat(64)
const other = 'b'.repeat(64)
const id = 'ingress_' + owner.slice(0, 24)
const nowMs = 1792500000000
const old = nowMs - INGRESS_RETENTION_MS - DAY
const calendar = { activeFromMs: 0, offsetMinutes: -60,
  latestDay: Math.floor((nowMs - 60 * 60000) / DAY) }

function record(overrides = {}) {
  return {
    ownerHash: owner, windowStartMs: old, updatedAtMs: old,
    counts: { nearbyPois: 5, walkingRoute: 12, quotaStatus: 2, closePlanning: 1 },
    leases: [], ...overrides
  }
}
const eligible = (data = record(), options = {}) =>
  canDeleteIngressRecord({ id, data, now: nowMs, ...options })

test('7-day conservative expiration and quota retention policy only allow inactive ingress', () => {
  expect(eligible()).toBe(true)
  const boundary = nowMs - INGRESS_RETENTION_MS - 60000
  expect(eligible(record({ windowStartMs: boundary, updatedAtMs: boundary }))).toBe(true)
  expect(eligible(record({ updatedAtMs: nowMs - INGRESS_RETENTION_MS + 1 }))).toBe(false)
  expect(eligible(record({ windowStartMs: nowMs, updatedAtMs: nowMs }))).toBe(false)
  expect(eligible(record(), { now: old })).toBe(false)
  expect(canDeleteQuotaRecord({ id, data: record(), calendar, now: nowMs })).toBe(true)
  expect(canDeleteQuotaRecord({ id, data: record(), calendar: null, now: nowMs })).toBe(false)
  expect(canDeleteQuotaRecord({ id, data: record(), calendar: {
    ...calendar, latestDay: calendar.latestDay + 1
  }, now: nowMs })).toBe(false)
  expect(canDeleteQuotaRecord({ id: 'day_1', calendar, now: nowMs })).toBe(true)
  expect(canDeleteQuotaRecord({ id: 'calendar', calendar, now: nowMs })).toBe(false)
})
test('active leases, expired leases still within cooldown and invalid lease entries fail closed', () => {
  const lease = { id: '1'.repeat(32), operation: 'walkingRoute', expiresAtMs: nowMs + 1 }
  expect(eligible(record({ leases: [lease] }))).toBe(false)
  expect(eligible(record({ leases: [{ ...lease,
    expiresAtMs: nowMs - INGRESS_RETENTION_MS + 1 }] }))).toBe(false)
  expect(eligible(record({ leases: [{ ...lease, expiresAtMs: old + 90000 }] }))).toBe(true)
  expect(eligible(record({ leases: [{ ...lease, operation: 'unknown', expiresAtMs: old }] }))).toBe(false)
  expect(eligible(record({ leases: [{ ...lease, id: 'broken', expiresAtMs: old }] }))).toBe(false)
  expect(eligible(record({ leases: [{ ...lease, expiresAtMs: NaN }] }))).toBe(false)
  expect(eligible(record({ leases: [{ ...lease, expiresAtMs: old }, {
    ...lease, expiresAtMs: old
  }] }))).toBe(false)
  expect(eligible(record({ leases: new Array(41).fill(null) }))).toBe(false)
})
test('only correct hashed IDs and fully validated documents are delete candidates', () => {
  for (const malformed of [
    null, [], { ...record(), ownerHash: other }, { ...record(), ownerHash: 'not-a-hash' },
    { ...record(), _id: 'day_1' }, { ...record(), updatedAtMs: nowMs + 1000 },
    { ...record(), updatedAtMs: -1 }, { ...record(), windowStartMs: -1 },
    { ...record(), updatedAtMs: old - 1 },
    { ...record(), counts: { ...record().counts, nearbyPois: -1 } },
    { ...record(), counts: { ...record().counts, walkingRoute: 0.5 } },
    { ...record(), counts: { ...record().counts, unexpected: 0 } },
    { ...record(), counts: {} }, { ...record(), leases: {} }
  ]) expect(eligible(malformed)).toBe(false)
  for (const badId of ['calendar', 'ingress_', 'ingress_' + owner.slice(0, 23),
    'ingress_' + other.slice(0, 24), 'ingress_' + owner.slice(0, 24) + 'a']) {
    expect(eligible(record(), { id: badId })).toBe(false)
  }
  expect(eligible(record(), { now: NaN })).toBe(false)
})

function createAdminStore(initial = record(), onCommit) {
  const documents = new Map([[id, initial]])
  let version = 0
  const transact = async work => {
    const snapshotVersion = version
    let removed = false
    const outcome = await work({
      async get(key) {
        if (key !== id) throw Error('unexpected document')
        return documents.get(key) || null
      },
      async delete(key) {
        if (key !== id) throw Error('unexpected deletion')
        removed = true
      }
    })
    if (onCommit) await onCommit({ documents, version: () => { version++ } })
    if (version !== snapshotVersion) throw new Error('transaction conflict')
    if (removed) { documents.delete(id); version++ }
    return outcome
  }
  return { documents, transact }
}

test('operator cleanup defaults to dry-run without deleting candidate', async () => {
  const store = createAdminStore()
  const report = await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs })
  expect(report).toEqual({ scanned: 1, eligible: 1, deleted: 0,
    skipped: 0, failed: 0, dryRun: true })
  expect(store.documents.has(id)).toBe(true)
  expect(JSON.stringify(report)).not.toContain(owner)
})
test('actual cleanup requires explicit approval and makes a fresh transactional read', async () => {
  const store = createAdminStore()
  await expect(sweepIngressCandidates({ candidateIds: [id], transact: store.transact,
    now: () => nowMs, dryRun: false })).rejects.toThrow(/approval/)
  expect(store.documents.has(id)).toBe(true)
  const report = await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs, dryRun: false,
    approval: 'DELETE_EXPIRED_INGRESS' })
  expect(report.deleted).toBe(1)
  expect(report.failed).toBe(0)
  expect(store.documents.has(id)).toBe(false)
  const repeat = await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs, dryRun: false,
    approval: 'DELETE_EXPIRED_INGRESS' })
  expect(repeat.deleted).toBe(0)
  expect(repeat.skipped).toBe(1)
})
test('race with a renewed user admission conflicts at commit: never delete the new record', async () => {
  let mutated = false
  const store = createAdminStore(record(), async ({ documents, version }) => {
    if (!mutated) {
      mutated = true
      documents.set(id, record({ updatedAtMs: nowMs, windowStartMs: nowMs,
        leases: [{ id: 'c'.repeat(32), operation: 'quotaStatus', expiresAtMs: nowMs + 90000 }] }))
      version()
    }
  })
  const outcome = await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs, dryRun: false,
    approval: 'DELETE_EXPIRED_INGRESS' })
  expect(outcome).toMatchObject({ scanned: 1, deleted: 0, failed: 1 })
  expect(store.documents.has(id)).toBe(true)
  expect(store.documents.get(id).leases).toHaveLength(1)
  const repeat = await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs, dryRun: false,
    approval: 'DELETE_EXPIRED_INGRESS' })
  expect(repeat).toMatchObject({ deleted: 0, skipped: 1 })
})
test('never prune active users, foreign docs, oversized batches or repeat IDs', async () => {
  const store = createAdminStore(record({ updatedAtMs: nowMs }))
  expect((await sweepIngressCandidates({ candidateIds: [id],
    transact: store.transact, now: () => nowMs, dryRun: false,
    approval: 'DELETE_EXPIRED_INGRESS' })).skipped).toBe(1)
  for (const ids of [[id, id], ['day_1'], Array(MAX_BATCH + 1).fill(id)]) {
    await expect(sweepIngressCandidates({ candidateIds: ids,
      transact: store.transact, now: () => nowMs })).rejects.toThrow(/batch/)
  }
  expect(store.documents.has(id)).toBe(true)
})
test('unknown admin transaction error is not reported as a successful deletion', async () => {
  const report = await sweepIngressCandidates({ candidateIds: [id],
    transact: async work => {
      await work({ get: async () => record(), delete: async () => {} })
      throw new Error('commit outcome unknown')
    }, now: () => nowMs, dryRun: false, approval: 'DELETE_EXPIRED_INGRESS' })
  expect(report).toMatchObject({ deleted: 0, failed: 1 })
})
