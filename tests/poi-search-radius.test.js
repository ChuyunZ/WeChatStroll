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
        getPoiSearchRadius(60)
      ).toBe(2250)
    }
  )

  test(
    'shorter duration produces a smaller radius than longer duration',
    () => {
      const shortRadius =
        getPoiSearchRadius(30)

      const mediumRadius =
        getPoiSearchRadius(45)

      const longRadius =
        getPoiSearchRadius(60)

      expect(shortRadius)
        .toBeLessThan(mediumRadius)

      expect(mediumRadius)
        .toBeLessThan(longRadius)
    }
  )

  test(
    'supports duration values outside common presets',
    () => {
      const shorterRadius =
        getPoiSearchRadius(30)

      const nonPresetRadius =
        getPoiSearchRadius(35)

      const longerRadius =
        getPoiSearchRadius(40)

      expect(nonPresetRadius)
        .toBeGreaterThan(shorterRadius)

      expect(nonPresetRadius)
        .toBeLessThan(longerRadius)
    }
  )

  test(
    'supports the maximum questionnaire duration within the allowed radius',
    () => {
      const normalRadius =
        getPoiSearchRadius(60)

      const maximumQuestionnaireRadius =
        getPoiSearchRadius(355)

      expect(
        maximumQuestionnaireRadius
      ).toBeGreaterThan(normalRadius)

      expect(
        maximumQuestionnaireRadius
      ).toBeLessThanOrEqual(15000)
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