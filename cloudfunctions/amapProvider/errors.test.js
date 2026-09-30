const { createWalkingHandler } = require('./walking')
const { createNearbyHandler } = require('./nearby-pois')

test.each(['AMAP_RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])(
  'both handlers preserve %s without exposing internal errors or retrying', async code => {
    for (const [factory, event] of [
      [createWalkingHandler, { start: { latitude: 30, longitude: 120 }, destination: { latitude: 31, longitude: 121 } }],
      [createNearbyHandler, { latitude: 30, longitude: 120 }]
    ]) {
      const request = jest.fn().mockRejectedValue(Object.assign(new Error('private database details'), { code }))
      const result = await factory({ apiKey: 'private-key', request })(event)
      expect(result).toMatchObject({ success: false, error: { code } })
      expect(request).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })
