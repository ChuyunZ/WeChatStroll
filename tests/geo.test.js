const {
  isValidGeoPoint,
  copyGeoPoint,
  areGeoPointsEqual
} = require(
  '../miniprogram/utils/geo'
)

describe('geo utils', () => {
  describe('isValidGeoPoint', () => {
    test(
      'accepts a valid latitude and longitude',
      () => {
        expect(
          isValidGeoPoint({
            latitude: 31.2304,
            longitude: 121.4737
          })
        ).toBe(true)
      }
    )

    test(
      'accepts coordinates on valid range boundaries',
      () => {
        expect(
          isValidGeoPoint({
            latitude: -90,
            longitude: -180
          })
        ).toBe(true)

        expect(
          isValidGeoPoint({
            latitude: 90,
            longitude: 180
          })
        ).toBe(true)
      }
    )

    test.each([
      null,
      undefined,
      [],
      '31.23,121.47',
      123
    ])(
      'rejects a non-object GeoPoint: %p',
      (point) => {
        expect(
          isValidGeoPoint(point)
        ).toBe(false)
      }
    )

    test.each([
      {
        latitude: '31.2304',
        longitude: 121.4737
      },
      {
        latitude: 31.2304,
        longitude: '121.4737'
      },
      {
        latitude: NaN,
        longitude: 121.4737
      },
      {
        latitude: Infinity,
        longitude: 121.4737
      },
      {
        latitude: 31.2304,
        longitude: -Infinity
      }
    ])(
      'rejects invalid coordinate values: %p',
      (point) => {
        expect(
          isValidGeoPoint(point)
        ).toBe(false)
      }
    )

    test.each([
      {
        latitude: 90.000001,
        longitude: 121.4737
      },
      {
        latitude: -90.000001,
        longitude: 121.4737
      },
      {
        latitude: 31.2304,
        longitude: 180.000001
      },
      {
        latitude: 31.2304,
        longitude: -180.000001
      }
    ])(
      'rejects coordinates outside geographic bounds: %p',
      (point) => {
        expect(
          isValidGeoPoint(point)
        ).toBe(false)
      }
    )
  })

  describe('copyGeoPoint', () => {
    test(
      'creates a new object containing only coordinates',
      () => {
        const original = {
          latitude: 31.2304,
          longitude: 121.4737,
          name: '测试地点'
        }

        const copy =
          copyGeoPoint(original)

        expect(copy).toEqual({
          latitude: 31.2304,
          longitude: 121.4737
        })

        expect(copy).not.toBe(original)
      }
    )

    test(
      'does not mutate the original point',
      () => {
        const original = {
          latitude: 31.2304,
          longitude: 121.4737
        }

        const copy =
          copyGeoPoint(original)

        copy.latitude = 30

        expect(
          original.latitude
        ).toBe(31.2304)
      }
    )
  })

  describe('areGeoPointsEqual', () => {
    test(
      'treats very small coordinate differences as the same point',
      () => {
        expect(
          areGeoPointsEqual(
            {
              latitude: 31.2304,
              longitude: 121.4737
            },
            {
              latitude: 31.2304005,
              longitude: 121.4737005
            }
          )
        ).toBe(true)
      }
    )

    test(
      'treats larger coordinate differences as different points',
      () => {
        expect(
          areGeoPointsEqual(
            {
              latitude: 31.2304,
              longitude: 121.4737
            },
            {
              latitude: 31.230402,
              longitude: 121.473702
            }
          )
        ).toBe(false)
      }
    )

    test(
      'returns false when either point is invalid',
      () => {
        expect(
          areGeoPointsEqual(
            {
              latitude: 31.2304,
              longitude: 121.4737
            },
            null
          )
        ).toBe(false)

        expect(
          areGeoPointsEqual(
            {
              latitude: NaN,
              longitude: 121.4737
            },
            {
              latitude: 31.2304,
              longitude: 121.4737
            }
          )
        ).toBe(false)
      }
    )
  })
})