Page({
  data: {
    latitude: '-',
    longitude: '-',
    loading: false,
    errorMessage: '',
    permissionDenied: false,
    showRetry: false
  },

  getLocation() {
    this.setData({
      loading: true,
      errorMessage: '',
      permissionDenied: false,
      showRetry: false
    })

    wx.getSetting({
      success: (res) => {
        const permission = res.authSetting['scope.userLocation']

        if (permission === true) {
          this.requestLocation()
        } else if (permission === false) {
          this.handlePermissionDenied()
        } else {
          wx.authorize({
            scope: 'scope.userLocation',

            success: () => {
              this.requestLocation()
            },

            fail: () => {
              this.handlePermissionDenied()
            }
          })
        }
      },

      fail: (err) => {
        console.log('getSetting failed:', err)

        this.setData({
          loading: false,
          errorMessage:
            'Unable to check location permission. Please try again.',
          showRetry: true
        })
      }
    })
  },

  requestLocation() {
    let requestTimedOut = false
  
    const timer = setTimeout(() => {
      requestTimedOut = true
  
      this.setData({
        loading: false,
        errorMessage:
          'Location request timed out. Please try again.',
        permissionDenied: false,
        showRetry: true
      })
    }, 10000)
  
    wx.getLocation({
      type: 'gcj02',
  
      success: (res) => {
        if (requestTimedOut) {
          return
        }
  
        clearTimeout(timer)
  
        console.log('Location:', res)
  
        this.setData({
          latitude: res.latitude,
          longitude: res.longitude,
          loading: false,
          errorMessage: '',
          permissionDenied: false,
          showRetry: false
        })
      },
  
      fail: (err) => {
        if (requestTimedOut) {
          return
        }
  
        clearTimeout(timer)
  
        console.log('getLocation failed:', err)
  
        this.setData({
          loading: false,
          errorMessage:
            'Unable to get your location. Please check your location services and try again.',
          permissionDenied: false,
          showRetry: true
        })
      }
    })
  },

  handlePermissionDenied() {
    this.setData({
      loading: false,
      errorMessage:
        'Location permission is required. Please enable it in Settings.',
      permissionDenied: true,
      showRetry: true
    })
  },

  openSettings() {
    wx.openSetting({
      success: (res) => {
        const permission = res.authSetting['scope.userLocation']

        if (permission === true) {
          this.getLocation()
        }
      }
    })
  }
})