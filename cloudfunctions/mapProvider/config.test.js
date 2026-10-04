const fs = require('fs')
const path = require('path')
const { loadLimits } = require('./config')

test('defaults use verified Tencent pacing for Explore and walking', () => {
  expect(loadLimits({})).toEqual({
    walkingRoute: { scope: 'tencent:walking', minIntervalMs: 200, maxQueueWaitMs: 12000,
      maxProviderAttempts: 2, cooldownBaseMs: 3000 },
    nearbyPois: { scope: 'tencent:poi-explore', minIntervalMs: 200, maxQueueWaitMs: 12000,
      maxProviderAttempts: 2, cooldownBaseMs: 3000 },
    keyMinIntervalMs: 0, clockGuardMs: 100, leaseStartWindowMs: 10000,
    leasePollMs: 100, bookkeepingWaitMs: 5000, requestTimeoutMs: 10000,
    transactionMaxAttempts: 6, transactionJitterMs: 40
  })
})

test.each([
  ['TENCENT_MAPS_WALKING_MIN_INTERVAL_MS', 1, 60000],
  ['TENCENT_MAPS_WALKING_MAX_QUEUE_WAIT_MS', 1, 60000],
  ['TENCENT_MAPS_WALKING_MAX_ATTEMPTS', 1, 4],
  ['TENCENT_MAPS_WALKING_COOLDOWN_MS', 1, 60000],
  ['TENCENT_MAPS_POI_MIN_INTERVAL_MS', 1, 60000],
  ['TENCENT_MAPS_POI_MAX_QUEUE_WAIT_MS', 1, 60000],
  ['TENCENT_MAPS_POI_MAX_ATTEMPTS', 1, 4],
  ['TENCENT_MAPS_POI_COOLDOWN_MS', 1, 60000],
  ['TENCENT_MAPS_KEY_MIN_INTERVAL_MS', 0, 60000],
  ['TENCENT_MAPS_CLOCK_GUARD_MS', 0, 5000],
  ['TENCENT_MAPS_LEASE_START_WINDOW_MS', 1000, 60000],
  ['TENCENT_MAPS_REQUEST_TIMEOUT_MS', 1, 60000]
])('%s validates its complete configured range', (key, min, max) => {
  for (const value of [min, max]) expect(() => loadLimits({ [key]: String(value) })).not.toThrow()
  for (const value of [min - 1, max + 1, 1.5, NaN, Infinity, 'invalid']) {
    expect(() => loadLimits({ [key]: String(value) })).toThrow('Invalid provider configuration')
  }
})

test('Tencent config overrides defaults without reading AMap configuration', () => {
  const limits = loadLimits({ TENCENT_MAPS_POI_MIN_INTERVAL_MS: '2500', AMAP_POI_MIN_INTERVAL_MS: '1' })
  expect(limits.nearbyPois.minIntervalMs).toBe(2500)
})

test('deployment is self-contained, dependencies match lockfile, limiter/store are unchanged copies', () => {
  const pkg = require('./package.json')
  const lock = require('./package-lock.json')
  expect(pkg.dependencies).toEqual({ 'wx-server-sdk': '4.0.2', axios: '1.20.0' })
  expect(lock.name).toBe(pkg.name)
  expect(lock.packages[''].name).toBe(pkg.name)
  expect(lock.packages[''].dependencies).toEqual(pkg.dependencies)
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    expect(lock.packages[`node_modules/${name}`].version).toBe(version)
  }
  for (const file of ['limiter.js', 'cloudbase-store.js']) {
    expect(fs.readFileSync(path.join(__dirname, file), 'utf8'))
      .toBe(fs.readFileSync(path.join(__dirname, '../amapProvider', file), 'utf8'))
  }
  for (const file of ['index.js', 'provider.js', 'limiter.js', 'cloudbase-store.js', 'errors.js', 'config.js', 'nearby-pois.js', 'walking.js', 'signing.js']) {
    expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).not.toMatch(/require\(['"]\.\.\//)
  }
})
