Page({
  data: {
    loading: false,
    status: 'idle',
    message: '',
    timestamp: '',
    errorMessage: ''
  },

  async callHealthCheck() {
    this.setData({
      loading: true,
      status: 'idle',
      message: '',
      timestamp: '',
      errorMessage: ''
    })

    try {
      const response = await wx.cloud.callFunction({
        name: 'cloudHealthCheck'
      })

      console.log('cloudHealthCheck response:', response)

      const result = response.result

      if (!result || result.success !== true) {
        throw new Error('Unexpected response from cloudHealthCheck')
      }

      this.setData({
        status: 'success',
        message: result.message,
        timestamp: result.timestamp
      })
    } catch (error) {
      console.error('cloudHealthCheck failed:', error)

      this.setData({
        status: 'error',
        errorMessage: error.errMsg || error.message || 'Unknown error'
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  }
})