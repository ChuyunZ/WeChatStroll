App({
  globalData: {
    currentPreferences: null
  },
  
  onLaunch() {
    console.log('WeChatStroll launched')

    if (!wx.cloud) {
      console.error('CloudBase is not supported by the current base library version')
      return
    }

    wx.cloud.init({
      env: 'cloud1-d0g0q6wm2e49d23d0',
      traceUser: true
    })

    console.log('CloudBase initialized')
  }
})