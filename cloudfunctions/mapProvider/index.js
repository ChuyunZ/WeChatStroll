const cloud = require('wx-server-sdk')
const axios = require('axios')
const { loadLimits } = require('./config')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { createNearbyHandler } = require('./nearby-pois')
const { createWalkingHandler } = require('./walking')
const { addTencentSignature } = require('./signing')
const { createPlanningSecurity } = require('./planning-session')
const { createQuotaStore } = require('./quota-store')
const { isProviderCode } = require('./errors')
const { pointKey } = require('./planning-token')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async event => {
  const operation = event && event.action
  if (!['nearbyPois', 'walkingRoute', 'closePlanning', 'quotaStatus'].includes(operation)) {
    return { success: false, error: { code: 'INVALID_ACTION', message: 'Unsupported provider operation' } }
  }
  const apiKey = process.env.TENCENT_MAPS_API_KEY
  const secretKey = process.env.TENCENT_MAPS_SECRET_KEY
  // Releasing a signed session only needs its owner and quota ledger, not
  // Tencent API credentials. Keep these checks for provider traffic only.
  if (operation !== 'closePlanning' && (!apiKey || !secretKey)) {
    return { success: false, error: { code: 'CONFIG_MISSING', message: 'Map API credentials are not configured' } }
  }
  const log = record => console.info('[Map Provider]', record)
  let authorization
  try {
    if (operation === 'nearbyPois') pointKey(event)
    if (operation === 'walkingRoute') { pointKey(event.start); pointKey(event.destination) }
    const db = cloud.database({ throwOnNotFound: false })
    const security = createPlanningSecurity({ store: createQuotaStore(db, { log }) })
    const context = cloud.getWXContext()
    if (operation === 'closePlanning') return await security.close(event, context)
    if (operation === 'quotaStatus') return await security.quotaStatus(context)
    const limits = loadLimits()
    authorization = operation === 'nearbyPois'
      ? await security.open(event, context) : await security.walking(event, context)
    const store = createCloudBaseStore(db)
    const limiter = createLimiter({ store, ...limits, log })
    const provider = createProvider({ limiter, limits, log, admission: authorization.admission,
      quotaOffsetMinutes: security.quotaOffsetMinutes,
      request: (url, options) => axios.get(url, addTencentSignature(url, options, secretKey)) })
    const createHandler = operation === 'walkingRoute' ? createWalkingHandler : createNearbyHandler
    const result = await createHandler({ apiKey, request: provider(operation) })(event)
    return operation === 'nearbyPois' ? await security.complete(authorization.auth, event, result) : result
  } catch (error) {
    // No client received this discovery token. An exceptional handler/ready
    // failure must release its holds; unknown DB outcomes remain fail-closed.
    if (operation === 'nearbyPois' && authorization && authorization.abort) {
      try { await authorization.abort() }
      catch (_) { log({ event: 'discovery_cleanup_unavailable' }) }
    }
    log({ event: 'gateway_unavailable', operation })
    return { success: false, error: {
      code: isProviderCode(error.code) || ['CONFIG_MISSING', 'INVALID_COORDINATES'].includes(error.code)
        ? error.code : 'PROVIDER_GATEWAY_FAILED', message: 'Provider service is temporarily unavailable'
    } }
  }
}
