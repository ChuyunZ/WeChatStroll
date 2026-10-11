const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
function delegatedEvent(event, action) {
  const context = cloud.getWXContext()
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID.trim() ||
      typeof context.APPID !== 'string' || !context.APPID.trim()) {
    throw Object.assign(new Error('Authentication required'), { code: 'MAP_UNAUTHORIZED' })
  }
  const secret = process.env.MAP_PLANNING_SECRET
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw Object.assign(new Error('Configuration missing'), { code: 'CONFIG_MISSING' })
  }
  // Ignore all caller identity/delegation fields. Forward only known business fields.
  const data = { action }
  for (const key of ['latitude', 'longitude', 'radius', 'start', 'destination', 'planningToken', 'requestId']) {
    if (event && event[key] !== undefined) data[key] = event[key]
  }
  if (!data.requestId) data.requestId = crypto.randomBytes(24).toString('hex')
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  const body = Buffer.from(JSON.stringify({ kind: 'forward',
    owner: hash(JSON.stringify([context.APPID, context.OPENID])),
    inputHash: hash(JSON.stringify(data)), expires: Date.now() + 65000
  })).toString('base64url')
  data._mapDelegation = body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  return data
}
module.exports = { delegatedEvent }
