Page({
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },
  goPreference() {
    wx.navigateTo({
      url: '/pages/preferences/preferences'
    })
  }
})
