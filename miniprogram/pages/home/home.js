Page({
  navigateToPage(event) {
    const url = event.currentTarget.dataset.url

    wx.navigateTo({
      url
    })
  }
})