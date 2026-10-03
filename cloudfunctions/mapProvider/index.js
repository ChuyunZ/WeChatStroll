const cloud = require('wx-server-sdk')
const axios = require('axios')
const { loadLimits } = require('./config')
const { createCloudBaseStore } = require('./cloudbase-store')
const { createLimiter } = require('./limiter')
const { createProvider } = require('./provider')
const { createNearbyHandler } = require('./nearby-pois')
const { createWalkingHandler } = require('./walking')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async event => {
  const operation = event && event.action
  if (operation !== 'nearbyPois' && operation !== 'walkingRoute') {
    return { success: false, error: { code: 'INVALID_ACTION', message: 'Unsupported provider operation' } }
  }
  const apiKey = process.env.TENCENT_MAPS_API_KEY
  if (!apiKey) return { success: false, error: { code: 'CONFIG_MISSING', message: 'Map API key is not configured' } }
  const log = record => console.info('[Map Provider]', record)
  try {
    const limits = loadLimits()
    const store = createCloudBaseStore(cloud.database({ throwOnNotFound: false }))
    const limiter = createLimiter({ store, ...limits, log })
    const provider = createProvider({ limiter, limits, log,
      request: (url, options) => axios.get(url, options) })
    const createHandler = operation === 'walkingRoute' ? createWalkingHandler : createNearbyHandler
    return await createHandler({ apiKey, request: provider(operation) })(event)
  } catch (_) {
    log({ event: 'gateway_unavailable', operation })
    return { success: false, error: {
      code: 'PROVIDER_GATEWAY_FAILED', message: 'Provider service is temporarily unavailable'
    } }
  }
}
