const { randomBytes } = require('crypto')
const { transact } = require('./quota-store')
const { fail, hash } = require('./planning-token')
const DAY = 86400000
const LIMITS = { user: { explore: 9, walking: 270 }, global: { explore: 180, walking: 5400 } }
// One full day's physical capacity plus the same amount of unsent/queue-failed
// headroom. These creation budgets are NEVER refunded or reset by closing.
const CREATION_LIMITS = Object.fromEntries(Object.entries(LIMITS).map(([scope, apis]) =>
  [scope, Object.fromEntries(Object.entries(apis).map(([api, limit]) => [api, limit * 2]))]))
const emptyCreations = () => ({ requests: { explore: 0, walking: 0 }, attempts: { explore: 0, walking: 0 }, users: {} })
// A base session reserves both physical calls AND the documents needed to use
// them. Creation reservations are released on close/expiry, not on refund.
const baseCreationHold = () => ({
  requests: { explore: 0, walking: 90 },
  attempts: { explore: 3, walking: 90 }
})
// No arbitrary global buffer: protect every admitted base reservation, then
// extend one physical attempt at a time from genuinely unreserved capacity.
function createQuota({ store, now = Date.now, offsetMinutes, activeFromMs, ttlMs = 2 * 60 * 60 * 1000 }) {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840 ||
      !Number.isSafeInteger(activeFromMs) || activeFromMs < 0 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 60000 || ttlMs > 4 * 60 * 60 * 1000) throw fail('CONFIG_MISSING')
  const dayOf = time => Math.floor((time + offsetMinutes * 60000) / DAY)
  const endOf = day => (day + 1) * DAY - offsetMinutes * 60000
  function validRequest(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw fail('MAP_REQUEST_INVALID')
  }
  async function run(day, work) {
    return transact(store, async tx => {
      const time = now()
      if (time < activeFromMs) throw fail('MAP_QUOTA_NOT_READY')
      const calendar = await tx.get('calendar')
      if (!calendar || calendar.activeFromMs !== activeFromMs || calendar.offsetMinutes !== offsetMinutes ||
          !Number.isSafeInteger(calendar.latestDay)) throw fail('MAP_QUOTA_NOT_READY')
      const id = `day_${day}`
      let data = await tx.get(id)
      const initializing = !data
      if (!data) {
        // First activation day must be explicitly reconciled; only later days
        // can initialize empty. Never silently discard same-day historical use.
        if (day <= dayOf(activeFromMs) || day <= calendar.latestDay) throw fail('MAP_QUOTA_NOT_READY')
        data = { used: { explore: 0, walking: 0 }, users: {}, sessions: {}, creations: emptyCreations() }
      }
      const before = JSON.stringify(data)
      const state = JSON.parse(before)
      validateState(state)
      for (const [sid, session] of Object.entries(state.sessions)) {
        if (session.expires <= time) delete state.sessions[sid]
      }
      const result = await work(state, tx, time)
      validateState(state)
      // Keep the transactional read/conflict check, but do not turn an
      // idempotent close/refund/sweep into an unlimited ledger write endpoint.
      // Real expiry pruning and first-day initialization still persist.
      if (initializing || JSON.stringify(state) !== before) await tx.set(id, state)
      if (day > calendar.latestDay) await tx.set('calendar', { ...calendar, latestDay: day })
      return result
    })
  }
  function user(state, owner) {
    return state.users[owner] || (state.users[owner] = { explore: 0, walking: 0 })
  }
  function room(state, owner, api, amount) {
    const sessions = Object.values(state.sessions)
    const held = sessions.reduce((sum, s) => sum + s.remaining[api], 0)
    const ownHeld = sessions.filter(s => s.owner === owner).reduce((sum, s) => sum + s.remaining[api], 0)
    if (user(state, owner)[api] + ownHeld + amount > LIMITS.user[api]) throw fail('MAP_USER_QUOTA_EXHAUSTED')
    if (state.used[api] + held + amount > LIMITS.global[api]) throw fail('MAP_GLOBAL_QUOTA_EXHAUSTED')
  }
  function sessionOf(state, sid, owner, time, day) {
    const s = state.sessions[sid]
    if (!s || s.owner !== owner || s.expires <= time || day !== dayOf(time) || time >= endOf(day) - 1000) {
      throw fail('MAP_SESSION_EXPIRED')
    }
    return s
  }
  function creationRoom(state, owner, kind, api, amount = 1) {
    const c = state.creations
    const usedByOwner = c.users[owner] ? c.users[owner][kind][api] : 0
    let heldGlobal = 0
    let heldByOwner = 0
    for (const s of Object.values(state.sessions)) {
      const held = s.creationRemaining[kind][api]
      heldGlobal += held
      if (s.owner === owner) heldByOwner += held
    }
    if (usedByOwner + heldByOwner + amount > CREATION_LIMITS.user[api] ||
        c[kind][api] + heldGlobal + amount > CREATION_LIMITS.global[api]) {
      throw fail('MAP_REQUEST_LIMITED')
    }
  }
  function createRecord(state, owner, kind, api, session) {
    // Convert this session's atomic creation hold into an irreversible record.
    // Without a hold, compete only for genuinely unreserved capacity.
    if (session && session.creationRemaining[kind][api] > 0) session.creationRemaining[kind][api]--
    else creationRoom(state, owner, kind, api)
    const c = state.creations
    const u = c.users[owner] || (c.users[owner] = {
      requests: { explore: 0, walking: 0 }, attempts: { explore: 0, walking: 0 }
    })
    u[kind][api]++
    c[kind][api]++
  }
  return {
    async begin(owner, requestId, inputHash) {
      validRequest(requestId)
      const day = dayOf(now())
      const sid = randomBytes(24).toString('hex')
      return run(day, async (state, tx, time) => {
        if (day !== dayOf(time) || time >= endOf(day) - 60000) throw fail('MAP_SESSION_EXPIRED')
        const rid = `request_${hash(owner + ':' + requestId)}`
        if (await tx.get(rid)) throw fail('MAP_EXECUTION_UNKNOWN')
        room(state, owner, 'explore', 3)
        room(state, owner, 'walking', 90)
        creationRoom(state, owner, 'attempts', 'explore', 3)
        creationRoom(state, owner, 'attempts', 'walking', 90)
        creationRoom(state, owner, 'requests', 'walking', 90)
        createRecord(state, owner, 'requests', 'explore')
        const expires = Math.min(time + ttlMs, endOf(day) - 1000)
        state.sessions[sid] = { owner, expires, ready: false, remaining: { explore: 3, walking: 90 },
          creationRemaining: baseCreationHold() }
        await tx.set(rid, { day, inputHash, expires: endOf(day) + DAY })
        return { sid, day, expires, owner }
      })
    },
    ready(auth, scopeHash) {
      return run(auth.day, (state, tx, time) => {
        const s = sessionOf(state, auth.sid, auth.owner, time, auth.day)
        s.ready = true
        s.scopeHash = scopeHash
        s.remaining.explore = 0
        s.creationRemaining.attempts.explore = 0
      })
    },
    claim(auth, requestId, inputHash) {
      validRequest(requestId)
      return run(auth.day, async (state, tx, time) => {
        const s = sessionOf(state, auth.sid, auth.owner, time, auth.day)
        if (!s.ready || s.scopeHash !== auth.scopeHash) throw fail('MAP_SESSION_INVALID')
        const rid = `request_${hash(auth.owner + ':' + requestId)}`
        if (await tx.get(rid)) throw fail('MAP_EXECUTION_UNKNOWN')
        // Reject exhausted physical capacity before persisting a new identity.
        // Other in-flight claims may compete for capacity; debit is still final.
        if (!s.remaining.walking) room(state, auth.owner, 'walking', 1)
        if (!s.creationRemaining.attempts.walking) creationRoom(state, auth.owner, 'attempts', 'walking')
        createRecord(state, auth.owner, 'requests', 'walking', s)
        await tx.set(rid, { day: auth.day, inputHash, expires: endOf(auth.day) + DAY })
      })
    },
    async debit(auth, api) {
      const attemptId = randomBytes(24).toString('hex')
      return run(auth.day, async (state, tx, time) => {
        const s = sessionOf(state, auth.sid, auth.owner, time, auth.day)
        if (api === 'walking' && (!s.ready || s.scopeHash !== auth.scopeHash)) throw fail('MAP_SESSION_INVALID')
        if (!s.remaining[api]) {
          room(state, auth.owner, api, 1)
          s.remaining[api]++
        }
        s.remaining[api]--
        state.used[api]++
        user(state, auth.owner)[api]++
        createRecord(state, auth.owner, 'attempts', api, s)
        await tx.set(`attempt_${attemptId}`, { sid: auth.sid, owner: auth.owner, day: auth.day,
          api, refunded: false, expires: endOf(auth.day) + DAY })
        return { attemptId, startBefore: Math.min(s.expires, endOf(auth.day) - 1000) }
      })
    },
    // Only called by the limiter when it can prove HTTP was never invoked.
    refund(auth, permit) {
      return run(auth.day, async (state, tx, time) => {
        const id = `attempt_${permit.attemptId}`
        const receipt = await tx.get(id)
        if (!receipt || receipt.refunded || receipt.owner !== auth.owner || receipt.sid !== auth.sid) return
        state.used[receipt.api]--
        user(state, auth.owner)[receipt.api]--
        const s = state.sessions[auth.sid]
        if (s && s.expires > time) s.remaining[receipt.api]++
        await tx.set(id, { ...receipt, refunded: true })
      })
    },
    close(auth) {
      return run(auth.day, state => {
        const s = state.sessions[auth.sid]
        if (s && s.owner !== auth.owner) throw fail('MAP_SESSION_INVALID')
        delete state.sessions[auth.sid]
      })
    },
    sweep: () => run(dayOf(now()), () => undefined)
  }
}
function validateState(state) {
  const counts = value => value && ['explore', 'walking'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)
  const c = state.creations
  // Existing ledgers must be reconciled offline, never silently reset counters.
  if (!c || !c.users || Array.isArray(c.users) || !counts(c.requests) || !counts(c.attempts) ||
      !Object.entries(c.users).every(([owner, u]) => /^[a-f0-9]{64}$/.test(owner) && counts(u.requests) && counts(u.attempts))) {
    throw fail('MAP_QUOTA_UNAVAILABLE')
  }
  for (const kind of ['requests', 'attempts']) for (const api of ['explore', 'walking']) {
    if (c[kind][api] > CREATION_LIMITS.global[api] ||
        Object.values(c.users).some(u => u[kind][api] > CREATION_LIMITS.user[api]) ||
        Object.values(c.users).reduce((sum, u) => sum + u[kind][api], 0) !== c[kind][api]) throw fail('MAP_QUOTA_UNAVAILABLE')
  }
  if (!counts(state.used) || !state.users || Array.isArray(state.users) || !state.sessions || Array.isArray(state.sessions) ||
      !Object.entries(state.users).every(([owner, value]) => /^[a-f0-9]{64}$/.test(owner) && counts(value)) || !Object.values(state.sessions).every(s =>
        /^[a-f0-9]{64}$/.test(s.owner) && Number.isSafeInteger(s.expires) && counts(s.remaining) &&
        s.creationRemaining && counts(s.creationRemaining.requests) && counts(s.creationRemaining.attempts)))
    throw fail('MAP_QUOTA_UNAVAILABLE')
  // The same upper bounds protect both spent records and all live creation
  // holds. Never accept a ledger whose future promised receipts cannot fit.
  const sessions = Object.values(state.sessions)
  for (const kind of ['requests', 'attempts']) for (const api of ['explore', 'walking']) {
    const reserved = sessions.reduce((sum, s) => sum + s.creationRemaining[kind][api], 0)
    if (c[kind][api] + reserved > CREATION_LIMITS.global[api]) throw fail('MAP_QUOTA_UNAVAILABLE')
    for (const owner of new Set([...Object.keys(c.users), ...sessions.map(s => s.owner)])) {
      const spent = c.users[owner] ? c.users[owner][kind][api] : 0
      const held = sessions.filter(s => s.owner === owner)
        .reduce((sum, s) => sum + s.creationRemaining[kind][api], 0)
      if (spent + held > CREATION_LIMITS.user[api]) throw fail('MAP_QUOTA_UNAVAILABLE')
    }
  }
  for (const api of ['explore', 'walking']) {
    const sessions = Object.values(state.sessions)
    if (sessions.reduce((sum, s) => sum + s.remaining[api], state.used[api]) > LIMITS.global[api]) throw fail('MAP_QUOTA_UNAVAILABLE')
    for (const [owner, used] of Object.entries(state.users)) {
      if (sessions.filter(s => s.owner === owner).reduce((sum, s) => sum + s.remaining[api], used[api]) > LIMITS.user[api]) throw fail('MAP_QUOTA_UNAVAILABLE')
    }
  }
}
module.exports = { createQuota, LIMITS, CREATION_LIMITS, emptyCreations, DAY }
