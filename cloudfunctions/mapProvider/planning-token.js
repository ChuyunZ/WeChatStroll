const crypto = require('crypto')
const fail = code => Object.assign(new Error(code), { code })
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const ownerOf = context => {
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID.trim() ||
      typeof context.APPID !== 'string' || !context.APPID.trim()) throw fail('MAP_UNAUTHORIZED')
  return hash(JSON.stringify([context.APPID, context.OPENID]))
}
function createTokens(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw fail('CONFIG_MISSING')
  const mac = body => crypto.createHmac('sha256', secret).update(body).digest('hex')
  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return body + '.' + mac(body)
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 16000) throw fail('MAP_SESSION_INVALID')
      const [body, signature, extra] = token.split('.')
      if (extra || !body || !/^[a-f0-9]{64}$/.test(signature || '') ||
          !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mac(body)))) throw fail('MAP_SESSION_INVALID')
      try { return JSON.parse(Buffer.from(body, 'base64url').toString()) }
      catch (_) { throw fail('MAP_SESSION_INVALID') }
    }
  }
}
function pointKey(point) {
  if (!point || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) throw fail('INVALID_COORDINATES')
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`
}
module.exports = { createTokens, hash, ownerOf, pointKey, fail }
