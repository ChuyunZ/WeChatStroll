const locationService = require('../../services/location')

Page({
  data: {
    latitude: '-',
    longitude: '-',
    loading: false,
    errorMessage: '',
    permissionDenied: false,
    showRetry: false
  },

  async getLocation() {
    this.setData({
      loading: true,
      errorMessage: '',
      permissionDenied: false,
      showRetry: false
    })

    try {
      const location = await locationService.getCurrentLocation()

      console.log('Location:', location)

      this.setData({
        latitude: location.latitude,
        longitude: location.longitude,
        loading: false,
        errorMessage: '',
        permissionDenied: false,
        showRetry: false
      })
    } catch (error) {
      console.log('Location error:', error)

      this.handleLocationError(error)
    }
  },

handleLocationError(error) {
  if (
    error.code ===
    locationService.ERROR_CODES.PERMISSION_DENIED
  ) {
    this.setData({
      loading: false,
      errorMessage:
        'Location permission is required. Please enable it in Settings.',
      permissionDenied: true,
      showRetry: true
    })

    return
  }

  if (
    error.code ===
    locationService.ERROR_CODES.LOCATION_TIMEOUT
  ) {
    this.setData({
      loading: false,
      errorMessage:
        'Location request timed out. Please try again.',
      permissionDenied: false,
      showRetry: true
    })

    return
  }

  if (
    error.code ===
    locationService.ERROR_CODES.LOCATION_FAILED
  ) {
    this.setData({
      loading: false,
      errorMessage:
        'Unable to get your location. Please try again.',
      permissionDenied: false,
      showRetry: true
    })

    return
  }

  this.setData({
    loading: false,
    errorMessage:
      'Something went wrong. Please try again.',
    permissionDenied: false,
    showRetry: true
  })
},

  async openSettings() {
    try {
      const result =
        await locationService.openLocationSettings()

      if (result.authorized) {
        this.getLocation()
      }
    } catch (error) {
      console.log('openSettings failed:', error)

      this.setData({
        errorMessage:
          'Unable to open Settings. Please try again.',
        showRetry: true
      })
    }
  }
})