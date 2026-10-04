const { createHash } = require('crypto')
const { URL } = require('url')

function rawParameterValue(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  throw new Error('Unsupported Tencent signing parameter')
}

function addTencentSignature(url, options = {}, secretKey) {
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new Error('Tencent signing secret is missing')
  }

  const params = options.params || {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Tencent signing parameters are invalid')
  }

  const entries = Object.entries(params)
    .filter(([name, value]) => name !== 'sig' && value !== undefined && value !== null)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

  const query = entries
    .map(([name, value]) => `${name}=${rawParameterValue(value)}`)
    .join('&')

  const pathname = new URL(url).pathname
  const signature = createHash('md5')
    .update(`${pathname}?${query}${secretKey}`, 'utf8')
    .digest('hex')

  return {
    ...options,
    params: {
      ...params,
      sig: signature
    }
  }
}

module.exports = { addTencentSignature }
