// Offline only. Emits a reviewable seed, never connects to CloudBase.
const fs = require('node:fs')
const { LIMITS, DAY } = require('../cloudfunctions/mapProvider/quota')
function buildSeed({ date, offsetMinutes, used, users = {}, userUsageComplete = false }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) throw new Error('Explicit date and confirmed reset offset required')
  const midnight = Date.parse(date + 'T00:00:00.000Z')
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new Error('Invalid date')
  const valid = values => values && ['explore', 'walking'].every(api => Number.isSafeInteger(values[api]) && values[api] >= 0)
  if (!valid(used) || !users || Array.isArray(users) || !Object.entries(users).every(([owner, values]) => /^[a-f0-9]{64}$/.test(owner) && valid(values))) throw new Error('Invalid reconciled counters')
  if (!userUsageComplete) throw new Error('Confirm complete user reconciliation, or an empty fresh day with all other callers stopped')
  for (const api of ['explore', 'walking']) {
    if (Object.values(users).reduce((sum, value) => sum + value[api], 0) > used[api]) throw new Error('User usage exceeds global usage')
  }
  // If historical use already exceeds a protection ceiling, saturate it: no
  // further admission is possible. Do not store raw identities or locations.
  const clamp = (value, limits) => Object.fromEntries(['explore', 'walking'].map(api => [api, Math.min(value[api], limits[api])]))
  return { collection: 'map_planning_quotas', documentId: `day_${midnight / DAY}`,
    activeFromMs: midnight - offsetMinutes * 60000,
    calendar: { activeFromMs: midnight - offsetMinutes * 60000, offsetMinutes, latestDay: midnight / DAY },
    data: { used: clamp(used, LIMITS.global),
      users: Object.fromEntries(Object.entries(users).map(([owner, value]) => [owner, clamp(value, LIMITS.user)])), sessions: {} } }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/issue107-quota-seed.cjs reviewed-input.json')
    process.stdout.write(JSON.stringify(buildSeed(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2) + '\n')
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
module.exports = { buildSeed }
