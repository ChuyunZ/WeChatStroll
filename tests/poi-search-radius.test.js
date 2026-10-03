const {
  getPoiSearchRadius
} = require('../miniprogram/services/poi-search-radius')

describe('poi-search-radius service', () => {
  test.each([
    [15, 563],
    [20, 750],
    [25, 938],
    [30, 1000],
    [60, 1000],
    [120, 1000],
    [121, 1000],
    [355, 1000]
  ])('uses duration-aware radius for %p minutes without exceeding provider limits', (durationMinutes, radius) => {
    expect(getPoiSearchRadius(durationMinutes)).toBe(radius)
  })

  test.each([
    undefined, null, NaN, Infinity, -Infinity, 0, -30, '30', {}, []
  ])('uses the safe 1000 m default for invalid duration %p', durationMinutes => {
    expect(getPoiSearchRadius(durationMinutes)).toBe(1000)
  })

  test('clamps positive subminimum durations to the 15-minute product minimum', () => {
    expect(getPoiSearchRadius(1)).toBe(563)
    expect(getPoiSearchRadius(14)).toBe(563)
  })
})
