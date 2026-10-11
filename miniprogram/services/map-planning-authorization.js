// Credentials belong to the discovery result in memory, never a POI, Route,
// Walk snapshot, page data or AI prompt. A closure binds each resolver separately.
const discoveries = new WeakMap()
const sessions = new WeakMap()
let sequence = 0
function requestId() {
  sequence++
  return `map_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2)}_request`
}
function rememberDiscovery(grouped, result) {
  discoveries.set(grouped, credential(result.planningToken))
  return grouped
}
function resolverFor(grouped) {
  const record = discoveries.get(grouped)
  return (from, to) => {
    if (record && record.released) throw cancelled()
    return require('./walking-segment').getWalkingSegment(from, to, record && record.token)
  }
}
function bindSession(session, grouped) {
  const record = discoveries.get(grouped)
  if (record) sessions.set(session, record)
  return session
}
function credential(token) { return token ? { token, released: false, closing: null } : null }
const cancelled = () => Object.assign(new Error('Planning cancelled'), { code: 'ROUTE_GENERATION_CANCELLED' })
function release(record) {
  if (!record) return Promise.resolve()
  record.released = true
  if (!record.closing) record.closing = (async () => {
    // Closing is idempotent server-side, including a lost acknowledgement.
    // One bounded retry; duplicate local closes share this same promise.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await require('./cloud-function-client').callCloudFunction('mapProvider', {
          action: 'closePlanning', planningToken: record.token
        })
        return
      } catch (error) {
        if (error && error.code === 'MAP_SESSION_EXPIRED') return
      }
    }
    // Offline/crashed clients still rely on server expiry; no retry loop/timer.
  })()
  return record.closing
}
const releaseSession = session => release(session && sessions.get(session))
function createPlanningRun() {
  const owned = new Set()
  let stopped = false
  const run = {
    check() { if (stopped) throw cancelled() },
    capture(grouped, result) {
      const record = credential(result && result.planningToken)
      if (record) {
        owned.add(record)
        if (grouped && typeof grouped === 'object') discoveries.set(grouped, record)
        if (stopped) release(record)
      }
      run.check()
    },
    detach(session) { owned.delete(session && sessions.get(session)) },
    cancel() {
      stopped = true
      return Promise.all([...owned].map(release))
    },
    async execute(work) {
      let retained = false
      try {
        run.check()
        const result = await work()
        run.check()
        retained = !!(result && result.status === 'success' && result.routePlanningSession)
        return result
      } finally {
        // Never make a failed generation wait for an unavailable close service.
        if (!retained) run.cancel()
      }
    }
  }
  return run
}
module.exports = { requestId, rememberDiscovery, resolverFor, bindSession, releaseSession, createPlanningRun }
