// Optimistic transactional fake: separate clients share only this backing state.
// There is deliberately no in-process acquisition lock or serialized work queue.
function createTestStore({ beforeCommit, afterCommit } = {}) {
  const documents = new Map()
  const versions = new Map()
  const store = {
    documents,
    conflicts: 0,
    forcedConflicts: 0,
    transactions: 0,
    failure: null,
    beforeCommit,
    afterCommit,
    async transaction(work) {
      store.transactions++
      if (store.failure) throw store.failure
      const snapshot = new Map([...documents].map(([id, data]) => [id, { ...data }]))
      const snapshotVersions = new Map(versions)
      const read = new Set()
      const writes = new Map()
      const result = await work({
        async get(id) { read.add(id); return snapshot.get(id) || null },
        async set(id, data) { writes.set(id, { ...data }) }
      })
      // Model real transactions whose reads/writes or commit acknowledgement are
      // slow. Check versions AFTER the delay, as another worker may commit first.
      if (store.beforeCommit) await store.beforeCommit({ writes, result })
      if (store.forcedConflicts > 0 || [...read].some(id => versions.get(id) !== snapshotVersions.get(id))) {
        store.forcedConflicts = Math.max(0, store.forcedConflicts - 1)
        store.conflicts++
        throw Object.assign(new Error('database transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' })
      }
      for (const [id, data] of writes) {
        documents.set(id, data)
        versions.set(id, (versions.get(id) || 0) + 1)
      }
      if (store.afterCommit) await store.afterCommit({ writes, result })
      return result
    }
  }
  return store
}

module.exports = { createTestStore }
