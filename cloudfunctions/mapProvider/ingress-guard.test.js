const { createTestStore } = require('./test-store')
const { createIngressGuard, POLICIES, WINDOW_MS, LEASE_MS } = require('./ingress-guard')

const alice = 'a'.repeat(64)
const bob = 'b'.repeat(64)
function harness() {
  const store = createTestStore()
  const deniedCache = new Map()
  let time = 120000
  let sequence = 0
  const create = () => createIngressGuard({ store, now: () => time,
    nonce: () => (++sequence).toString(16).padStart(32, '0'), deniedCache })
  return { store, create, step: ms => { time += ms }, now: () => time }
}
test('uses authoritative shared storage across independent gateway instances', async () => {
  const { store, create } = harness()
  const one = create(), two = create()
  for (let i = 0; i < POLICIES.nearbyPois.perMinute; i++) {
    const release = await (i % 2 ? one : two).acquire(alice, 'nearbyPois')
    await release()
  }
  await expect(two.acquire(alice, 'nearbyPois'))
    .rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  // One user's discovery exhaustion must not block another user or closing.
  await (await one.acquire(bob, 'nearbyPois'))()
  await (await one.acquire(alice, 'closePlanning'))()
  const record = [...store.documents.entries()].find(([k]) => k.startsWith('ingress_'))
  expect(record[0].length).toBeLessThanOrEqual(32)
  expect(record[1].ownerHash).toBe(alice)
  expect(record[1].counts.nearbyPois).toBe(POLICIES.nearbyPois.perMinute)
  expect(JSON.stringify([...store.documents])).not.toContain('latitude')
})
test('separate close/status allowance survives provider throttling', async () => {
  const { create } = harness()
  const g = create()
  for (let i = 0; i < POLICIES.nearbyPois.perMinute; i++) {
    await (await g.acquire(alice, 'nearbyPois'))()
  }
  await expect(g.acquire(alice, 'nearbyPois'))
    .rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  await (await g.acquire(alice, 'quotaStatus'))()
  await (await g.acquire(alice, 'closePlanning'))()
})
test('concurrency slots release and stale leaked leases expire conservatively', async () => {
  const { create, step, store } = harness()
  const g = create()
  const releases = []
  for (let i = 0; i < POLICIES.nearbyPois.concurrent; i++) {
    releases.push(await g.acquire(alice, 'nearbyPois'))
  }
  await expect(g.acquire(alice, 'nearbyPois'))
    .rejects.toMatchObject({ code: 'MAP_REQUEST_LIMITED' })
  await releases[0]()
  await (await g.acquire(alice, 'nearbyPois'))()
  for (const release of releases) await release()
  // Full counts remain charged after release. Lease expiration only frees the
  // concurrent slot; it never creates additional minute allowance.
  expect([...store.documents.values()][0].counts.nearbyPois).toBe(4)
  step(WINDOW_MS + LEASE_MS)
  await (await g.acquire(alice, 'nearbyPois'))()
  expect([...store.documents.values()][0].counts.nearbyPois).toBe(1)
})
test('invalid owner and malformed storage fail closed before any provider work', async () => {
  const { create, store } = harness()
  const g = create()
  await expect(g.acquire('forged-user', 'walkingRoute'))
    .rejects.toMatchObject({ code: 'MAP_UNAUTHORIZED' })
  await expect(g.acquire(alice, 'nonexistent'))
    .rejects.toMatchObject({ code: 'MAP_REQUEST_INVALID' })
  const id = 'ingress_' + alice.slice(0, 24)
  store.documents.set(id, {
    ownerHash: bob, windowStartMs: 120000, updatedAtMs: 120000,
    counts: { nearbyPois: 0, walkingRoute: 0, quotaStatus: 0, closePlanning: 0 },
    leases: []
  })
  await expect(g.acquire(alice, 'quotaStatus'))
    .rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
})
test('failed release cannot refund rate count or revoke successful response', async () => {
  const { create, store } = harness()
  const release = await create().acquire(alice, 'walkingRoute')
  store.failure = new Error('private database failed')
  await expect(release()).resolves.toBeUndefined()
  store.failure = null
  const id = 'ingress_' + alice.slice(0, 24)
  expect(store.documents.get(id).counts.walkingRoute).toBe(1)
  expect(store.documents.get(id).leases).toHaveLength(1)
})
