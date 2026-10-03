const {
  getPoiSearchRadius
} = require('../miniprogram/services/poi-search-radius')

describe('poi-search-radius service', () => {
  test.each([
    15, 30, 60, 120, 355,
    undefined, null, NaN, Infinity, -Infinity, 0, -30, '30', {}, []
  ])('returns exactly 1000 meters for duration %p', durationMinutes => {
    expect(getPoiSearchRadius(durationMinutes)).toBe(1000)
  })

  test('returns exactly 1000 meters without an argument', () => {
    expect(getPoiSearchRadius()).toBe(1000)
  })
})
