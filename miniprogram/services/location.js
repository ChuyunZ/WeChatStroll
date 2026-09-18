const {
  createCodedError
} = require('../utils/errors')

const LOCATION_SCOPE = 'scope.userLocation'
const DEFAULT_TIMEOUT = 10000

const ERROR_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  LOCATION_TIMEOUT: 'LOCATION_TIMEOUT',
  LOCATION_FAILED: 'LOCATION_FAILED'
}

function getLocationPermission() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success: (res) => {
        resolve(res.authSetting[LOCATION_SCOPE])
      },

      fail: (err) => {
        reject(
          createCodedError(
            ERROR_CODES.LOCATION_FAILED,
            'Unable to check location permission.',
            err
          )
        )
      }
    })
  })
}

function requestLocationPermission() {
  return new Promise((resolve, reject) => {
    wx.authorize({
      scope: LOCATION_SCOPE,

      success: () => {
        resolve()
      },

      fail: (err) => {
        wx.getSetting({
          success: (res) => {
            const permission = res.authSetting[LOCATION_SCOPE]

            if (permission === false) {
              reject(
                createCodedError(
                  ERROR_CODES.PERMISSION_DENIED,
                  'Location permission was denied.',
                  err
                )
              )

              return
            }

            reject(
              createCodedError(
                ERROR_CODES.LOCATION_FAILED,
                'Unable to request location permission.',
                err
              )
            )
          },

          fail: () => {
            reject(
              createCodedError(
                ERROR_CODES.LOCATION_FAILED,
                'Unable to request location permission.',
                err
              )
            )
          }
        })
      }
    })
  })
}

async function ensureLocationPermission() {
  const permission = await getLocationPermission()

  if (permission === true) {
    return
  }

  if (permission === false) {
    throw createCodedError(
      ERROR_CODES.PERMISSION_DENIED,
      'Location permission was denied.'
    )
  }

  await requestLocationPermission()
}

function requestCurrentLocation(timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let finished = false

    const timer = setTimeout(() => {
      if (finished) {
        return
      }

      finished = true

      reject(
        createCodedError(
          ERROR_CODES.LOCATION_TIMEOUT,
          'Location request timed out.'
        )
      )
    }, timeout)

    wx.getLocation({
      type: 'gcj02',

      success: (res) => {
        if (finished) {
          return
        }

        finished = true
        clearTimeout(timer)

        resolve({
          latitude: res.latitude,
          longitude: res.longitude
        })
      },

      fail: (err) => {
        if (finished) {
          return
        }

        finished = true
        clearTimeout(timer)

        reject(
          createCodedError(
            ERROR_CODES.LOCATION_FAILED,
            'Unable to get current location.',
            err
          )
        )
      }
    })
  })
}

async function getCurrentLocation(options = {}) {
  const timeout =
  Number.isFinite(options.timeout) && options.timeout > 0
    ? options.timeout
    : DEFAULT_TIMEOUT

  await ensureLocationPermission()

  return requestCurrentLocation(timeout)
}

function openLocationSettings() {
  return new Promise((resolve, reject) => {
    wx.openSetting({
      success: (res) => {
        resolve({
          authorized: res.authSetting[LOCATION_SCOPE] === true
        })
      },

      fail: (err) => {
        reject(
          createCodedError(
            ERROR_CODES.LOCATION_FAILED,
            'Unable to open Settings.',
            err
          )
        )
      }
    })
  })
}

module.exports = {
  getCurrentLocation,
  openLocationSettings,
  ERROR_CODES
}
