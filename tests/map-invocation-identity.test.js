// Instance reuse regression: never authenticate through process.env/getWXContext.
const handlers = [
  require('../cloudfunctions/mapProvider/invocation-identity'),
  require('../cloudfunctions/getNearbyPois/invocation-identity'),
  require('../cloudfunctions/getWalkingRoute/invocation-identity')
]
const names = ['mapProvider', 'getNearbyPois', 'getWalkingRoute']
test.each(handlers.map((handler, index) => [names[index], handler]))(
  '%s extracts only per-invocation Mini Program identity', (_name, { currentWXIdentity }) => {
    const originalOpenid = process.env.WX_OPENID
    const originalAppid = process.env.WX_APPID
    try {
      process.env.WX_OPENID = 'stale-victim'
      process.env.WX_APPID = 'stale-app'
      expect(currentWXIdentity({ environment: JSON.stringify({
        WX_APPID: 'app-one', WX_OPENID: 'user-one'
      }) })).toEqual({ APPID: 'app-one', OPENID: 'user-one' })
      expect(currentWXIdentity({ environment: JSON.stringify({
        WX_APPID: 'app-one', WX_OPENID: 'user-two'
      }) })).toEqual({ APPID: 'app-one', OPENID: 'user-two' })
      expect(currentWXIdentity({ environ: 'TRIGGER_SRC=wx;WX_APPID=app-one;WX_OPENID=user-three' }))
        .toEqual({ APPID: 'app-one', OPENID: 'user-three' })
      expect(currentWXIdentity({ environ: { WX_APPID: 'app-one', WX_OPENID: 'user-four' } }))
        .toEqual({ APPID: 'app-one', OPENID: 'user-four' })
      for (const ctx of [undefined, {}, { environment: '{}' }, { environ: 'TRIGGER_SRC=server' },
        { environment: 'not-json' }, { environment: '[]' },
        { environment: JSON.stringify({ WX_APPID: 'app-one' }) },
        { environ: 'WX_APPID=app-one;WX_OPENID=user-one;WX_OPENID=other' },
        { environment: JSON.stringify({ WX_APPID: 'app-one', WX_OPENID: ' ' }) }]) {
        expect(() => currentWXIdentity(ctx)).toThrow(expect.objectContaining({ code: 'MAP_UNAUTHORIZED' }))
      }
    } finally {
      if (originalOpenid === undefined) delete process.env.WX_OPENID
      else process.env.WX_OPENID = originalOpenid
      if (originalAppid === undefined) delete process.env.WX_APPID
      else process.env.WX_APPID = originalAppid
    }
  }
)
test('all independently deployed map identity helpers remain identical', () => {
  const fs = require('fs')
  const path = require('path')
  const source = dir => fs.readFileSync(path.join(__dirname, '../cloudfunctions/', dir, 'invocation-identity.js'), 'utf8')
  expect(source('mapProvider')).toBe(source('getNearbyPois'))
  expect(source('mapProvider')).toBe(source('getWalkingRoute'))
})
