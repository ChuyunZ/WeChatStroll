const cloud = require('wx-server-sdk')
const axios = require('axios')
const { loadLimits } = require('./config')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { createWalkingHandler } = require('./walking')
const { createNearbyHandler } = require('./nearby-pois')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async event => {
  const operation = event && event.action
  if (operation !== 'walkingRoute' && operation !== 'nearbyPois') {
    return { success: false, error: { code: 'INVALID_ACTION', message: 'Unsupported provider operation' } }
  }
  try {
    const limits = loadLimits()
    const log = record => console.info('[AMap Provider]', record)
    const store = createCloudBaseStore(cloud.database({ throwOnNotFound: false }))
    const limiter = createLimiter({ store, ...limits, log })
    const provider = createProvider({ limiter, limits, log,
      request: (url, options) => axios.get(url, options) })
    const createHandler = operation === 'walkingRoute' ? createWalkingHandler : createNearbyHandler
    return await createHandler({ apiKey: process.env.AMAP_API_KEY,
      request: provider(operation) })(event)
  } catch (_) {
    console.info('[AMap Provider]', { event: 'gateway_unavailable', operation })
    return { success: false, error: {
      code: 'PROVIDER_GATEWAY_FAILED', message: 'Provider service is temporarily unavailable'
    } }
  }
}
