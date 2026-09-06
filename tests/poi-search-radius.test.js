const {
  getPoiSearchRadius
} = require(
  '../miniprogram/services/poi-search-radius'
)

describe('poi-search-radius service', () => {
  test(
    'calculates radius from walking duration',
    () => {
      expect(
        getPoiSearchRadius(30)
      ).toBe(1125)

      expect(
        getPoiSearchRadius(45)
      ).toBe(1688)

      expect(
        getPoiSearchRadius(60)
      ).toBe(2250)
    }
  )

  test(
    'shorter duration produces a smaller radius than longer duration',
    () => {
      const shorterRadius =
        getPoiSearchRadius(20)

      const longerRadius =
        getPoiSearchRadius(40)

      expect(shorterRadius)
        .toBeLessThan(longerRadius)
    }
  )

  test(
    'supports duration values outside common presets',
    () => {
      expect(
        getPoiSearchRadius(35)
      ).toBe(1313)
    }
  )

  test(
    'supports the maximum questionnaire duration',
    () => {
      expect(
        getPoiSearchRadius(355)
      ).toBe(13313)
    }
  )

  test(
    'enforces the minimum search radius',
    () => {
      expect(
        getPoiSearchRadius(1)
      ).toBe(200)
    }
  )

  test(
    'enforces the maximum search radius',
    () => {
      expect(
        getPoiSearchRadius(1000)
      ).toBe(15000)
    }
  )

  test.each([
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    0,
    -30,
    '30'
  ])(
    'falls back to the default radius for invalid duration: %p',
    (durationMinutes) => {
      expect(
        getPoiSearchRadius(durationMinutes)
      ).toBe(3000)
    }
  )
})