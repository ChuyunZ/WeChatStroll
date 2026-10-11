const { createTokens, hash, ownerOf, pointKey, fail } = require('./planning-token')
const { createQuota } = require('./quota')
function createPlanningSecurity({ store, env = process.env, now = Date.now }) {
  const tokens = createTokens(env.MAP_PLANNING_SECRET)
  const quota = createQuota({ store, now,
    offsetMinutes: env.MAP_QUOTA_OFFSET_MINUTES === undefined ? NaN : Number(env.MAP_QUOTA_OFFSET_MINUTES),
    activeFromMs: env.MAP_QUOTA_ACTIVE_FROM_MS === undefined ? NaN : Number(env.MAP_QUOTA_ACTIVE_FROM_MS),
    ttlMs: env.MAP_SESSION_TTL_MS === undefined ? undefined : Number(env.MAP_SESSION_TTL_MS) })
  function identity(event, context) {
    if (!event._mapDelegation) return ownerOf(context)
    // Reconstruct exactly the wrapper's business envelope. Platform-injected
    // metadata and caller identity fields are neither authority nor signed input.
    const payload = { action: event.action }
    for (const key of ['latitude', 'longitude', 'radius', 'start', 'destination', 'planningToken', 'requestId']) {
      if (event[key] !== undefined) payload[key] = event[key]
    }
    let delegated
    try { delegated = tokens.verify(event._mapDelegation) } catch (_) { throw fail('MAP_UNAUTHORIZED') }
    if (!delegated || delegated.kind !== 'forward' || !Number.isSafeInteger(delegated.expires) || delegated.expires <= now() || delegated.expires > now() + 70000 ||
        delegated.inputHash !== hash(JSON.stringify(payload)) || !/^[a-f0-9]{64}$/.test(delegated.owner)) {
      throw fail('MAP_UNAUTHORIZED')
    }
    // A direct caller cannot change owners by attaching another user's proof.
    if (context && context.OPENID && ownerOf(context) !== delegated.owner) throw fail('MAP_UNAUTHORIZED')
    return delegated.owner
  }
  function authorization(event, owner) {
    const auth = tokens.verify(event.planningToken)
    if (!auth || auth.kind !== 'planning' || auth.owner !== owner || !Array.isArray(auth.points) ||
        !auth.points.includes(auth.origin) || !Number.isSafeInteger(auth.day) ||
        !Number.isSafeInteger(auth.expires)) throw fail('MAP_SESSION_INVALID')
    if (auth.expires <= now()) throw fail('MAP_SESSION_EXPIRED')
    return { ...auth, scopeHash: hash(event.planningToken) }
  }
  return {
    async open(event, context) {
      const owner = identity(event, context)
      const auth = await quota.begin(owner, event.requestId, hash(JSON.stringify([
        owner, event.requestId, pointKey(event), event.radius === undefined ? null : event.radius
      ])))
      return { auth, admission: admission(auth, 'explore'), abort: () => quota.close(auth) }
    },
    async complete(auth, event, result) {
      if (!result.success) { await quota.close(auth); return result }
      const pois = Object.values(result.poisByCategory).flat()
      if (!pois.length) { await quota.close(auth); return result }
      const payload = { ...auth, kind: 'planning', origin: pointKey(event),
        points: [...new Set([pointKey(event), ...pois.map(pointKey)])].sort() }
      const planningToken = tokens.sign(payload)
      await quota.ready(auth, hash(planningToken))
      return { ...result, planningToken, planningExpiresAt: auth.expires }
    },
    async walking(event, context) {
      const owner = identity(event, context)
      const auth = authorization(event, owner)
      const from = pointKey(event.start), to = pointKey(event.destination)
      if (!auth.points.includes(from) || !auth.points.includes(to)) throw fail('MAP_SESSION_INVALID')
      await quota.claim(auth, event.requestId, hash(JSON.stringify([auth.sid, event.requestId, from, to])))
      return { admission: admission(auth, 'walking') }
    },
    async close(event, context) {
      await quota.close(authorization(event, identity(event, context)))
      return { success: true }
    },
    sweep: quota.sweep
  }
  function admission(auth, api) {
    return { prepare: () => quota.debit(auth, api), cancel: permit => quota.refund(auth, permit) }
  }
}
module.exports = { createPlanningSecurity }
