const locationService = require(
  '../miniprogram/services/location'
)

const {
  getCurrentLocation,
  openLocationSettings,
  ERROR_CODES
} = locationService

const LOCATION_SCOPE = 'scope.userLocation'

function createWxMock(options = {}) {
  const permission =
    Object.prototype.hasOwnProperty.call(
      options,
      'permission'
    )
      ? options.permission
      : true

  const location =
    options.location || {
      latitude: 23.129158,
      longitude: 113.264939
    }

  return {
    getSetting: jest.fn(({ success }) => {
      success({
        authSetting: {
          [LOCATION_SCOPE]: permission
        }
      })
    }),

    authorize: jest.fn(({ success }) => {
      success()
    }),

    getLocation: jest.fn(({ success }) => {
      success(location)
    }),

    openSetting: jest.fn(({ success }) => {
      success({
        authSetting: {
          [LOCATION_SCOPE]: permission
        }
      })
    })
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()

  global.wx = createWxMock()
})

afterEach(() => {
  jest.useRealTimers()
  delete global.wx
})

describe('location service', () => {
  test(
    'returns the current gcj02 location when permission is already granted',
    async () => {
      const result =
        await getCurrentLocation()

      expect(
        wx.getSetting
      ).toHaveBeenCalledTimes(1)

      expect(
        wx.authorize
      ).not.toHaveBeenCalled()

      expect(
        wx.getLocation
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gcj02',
          success: expect.any(Function),
          fail: expect.any(Function)
        })
      )

      expect(result).toEqual({
        latitude: 23.129158,
        longitude: 113.264939
      })
    }
  )

  test(
    'requests permission when location permission has not been decided yet',
    async () => {
      global.wx = createWxMock({
        permission: undefined
      })

      const result =
        await getCurrentLocation()

      expect(
        wx.authorize
      ).toHaveBeenCalledWith({
        scope: LOCATION_SCOPE,
        success: expect.any(Function),
        fail: expect.any(Function)
      })

      expect(
        wx.getLocation
      ).toHaveBeenCalledTimes(1)

      expect(result).toEqual({
        latitude: 23.129158,
        longitude: 113.264939
      })
    }
  )

  test(
    'rejects immediately when location permission was previously denied',
    async () => {
      global.wx = createWxMock({
        permission: false
      })

      await expect(
        getCurrentLocation()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.PERMISSION_DENIED,

        message:
          'Location permission was denied.'
      })

      expect(
        wx.authorize
      ).not.toHaveBeenCalled()

      expect(
        wx.getLocation
      ).not.toHaveBeenCalled()
    }
  )

  test(
    'distinguishes an explicit authorization denial from a generic authorization failure',
    async () => {
      const authorizationError =
        new Error(
          'authorize failed'
        )

      global.wx = createWxMock({
        permission: undefined
      })

      wx.authorize.mockImplementation(
        ({ fail }) => {
          fail(authorizationError)
        }
      )

      wx.getSetting
        .mockImplementationOnce(
          ({ success }) => {
            success({
              authSetting: {}
            })
          }
        )
        .mockImplementationOnce(
          ({ success }) => {
            success({
              authSetting: {
                [LOCATION_SCOPE]:
                  false
              }
            })
          }
        )

      await expect(
        getCurrentLocation()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.PERMISSION_DENIED,

        message:
          'Location permission was denied.',

        originalError:
          authorizationError
      })

      expect(
        wx.getLocation
      ).not.toHaveBeenCalled()
    }
  )

  test(
    'returns LOCATION_FAILED when authorization fails without an explicit denial',
    async () => {
      const authorizationError =
        new Error(
          'authorize failed'
        )

      global.wx = createWxMock({
        permission: undefined
      })

      wx.authorize.mockImplementation(
        ({ fail }) => {
          fail(authorizationError)
        }
      )

      wx.getSetting
        .mockImplementationOnce(
          ({ success }) => {
            success({
              authSetting: {}
            })
          }
        )
        .mockImplementationOnce(
          ({ success }) => {
            success({
              authSetting: {}
            })
          }
        )

      await expect(
        getCurrentLocation()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.LOCATION_FAILED,

        message:
          'Unable to request location permission.',

        originalError:
          authorizationError
      })

      expect(
        wx.getLocation
      ).not.toHaveBeenCalled()
    }
  )

  test(
    'returns LOCATION_FAILED when checking permission fails',
    async () => {
      const settingsError =
        new Error(
          'getSetting failed'
        )

      wx.getSetting.mockImplementation(
        ({ fail }) => {
          fail(settingsError)
        }
      )

      await expect(
        getCurrentLocation()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.LOCATION_FAILED,

        message:
          'Unable to check location permission.',

        originalError:
          settingsError
      })

      expect(
        wx.getLocation
      ).not.toHaveBeenCalled()
    }
  )

  test(
    'returns LOCATION_FAILED when wx.getLocation fails',
    async () => {
      const locationError =
        new Error(
          'location unavailable'
        )

      wx.getLocation.mockImplementation(
        ({ fail }) => {
          fail(locationError)
        }
      )

      await expect(
        getCurrentLocation()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.LOCATION_FAILED,

        message:
          'Unable to get current location.',

        originalError:
          locationError
      })
    }
  )

  test(
    'times out using the caller-provided timeout when wx.getLocation never settles',
    async () => {
      jest.useFakeTimers()

      wx.getLocation.mockImplementation(
        () => {}
      )

      const locationPromise =
        getCurrentLocation({
          timeout: 25
        })

      const rejection =
        expect(
          locationPromise
        ).rejects.toMatchObject({
          code:
            ERROR_CODES.LOCATION_TIMEOUT,

          message:
            'Location request timed out.'
        })

      await Promise.resolve()

      await jest
        .advanceTimersByTimeAsync(25)

      await rejection
    }
  )

  test(
    'openLocationSettings reports whether permission is enabled',
    async () => {
      const authorizedResult =
        await openLocationSettings()

      expect(
        authorizedResult
      ).toEqual({
        authorized: true
      })

      wx.openSetting.mockImplementation(
        ({ success }) => {
          success({
            authSetting: {
              [LOCATION_SCOPE]:
                false
            }
          })
        }
      )

      const deniedResult =
        await openLocationSettings()

      expect(
        deniedResult
      ).toEqual({
        authorized: false
      })
    }
  )

  test(
    'openLocationSettings returns LOCATION_FAILED when Settings cannot be opened',
    async () => {
      const settingsError =
        new Error(
          'openSetting failed'
        )

      wx.openSetting.mockImplementation(
        ({ fail }) => {
          fail(settingsError)
        }
      )

      await expect(
        openLocationSettings()
      ).rejects.toMatchObject({
        code:
          ERROR_CODES.LOCATION_FAILED,

        message:
          'Unable to open Settings.',

        originalError:
          settingsError
      })
    }
  )
})