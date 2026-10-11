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
  discoveries.set(grouped, result.planningToken)
  return grouped
}
function resolverFor(grouped) {
  const token = discoveries.get(grouped)
  return (from, to) => require('./walking-segment').getWalkingSegment(from, to, token)
}
function bindSession(session, grouped) {
  const token = discoveries.get(grouped)
  if (token) sessions.set(session, token)
  return session
}
async function releaseSession(session) {
  const token = session && sessions.get(session)
  if (!token) return
  sessions.delete(session)
  try {
    await require('./cloud-function-client').callCloudFunction('mapProvider', {
      action: 'closePlanning', planningToken: token
    })
  } catch (_) { /* best effort; server expiry always reclaims unused capacity */ }
}
module.exports = { requestId, rememberDiscovery, resolverFor, bindSession, releaseSession }
