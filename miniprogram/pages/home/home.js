const activeWalkSessionService = require('../../services/active-walk-session');

Page({
  onLoad() {
    this._homeVisible = false;
    this._homeDisposed = false;
    this._goPreferenceBusy = false;
    this._goPreferenceEpoch = 0;
  },

  onShow() {
    this._homeVisible = true;
  },

  onHide() {
    this._homeVisible = false;
    this._goPreferenceEpoch += 1;
    this._goPreferenceBusy = false;
  },

  onUnload() {
    this._homeDisposed = true;
    this._homeVisible = false;
    this._goPreferenceEpoch += 1;
    this._goPreferenceBusy = false;
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  async goPreference() {
    if (this._homeDisposed || !this._homeVisible || this._goPreferenceBusy) return;

    this._goPreferenceBusy = true;
    const epoch = ++this._goPreferenceEpoch;
    const isCurrent = () =>
      !this._homeDisposed && this._homeVisible && this._goPreferenceEpoch === epoch;

    try {
      // Reconcile with CloudBase before allowing a new questionnaire/route.
      // On a cold launch, a saved active walk must take priority.
      const session = await activeWalkSessionService.reconcileActiveWalk();
      if (!isCurrent()) return;

      const url = session
        ? `/pages/walking/walking?routeId=${encodeURIComponent(session.routeId)}`
        : '/pages/preferences/preferences';

      await new Promise((resolve, reject) => {
        wx.navigateTo({ url, success: resolve, fail: reject });
      });
    } catch (error) {
      if (!isCurrent()) return;

      let title = '暂时无法检查散步状态，请重试';
      if (error && error.code === 'WALK_ROUTE_UNAVAILABLE') {
        title = '原路线数据缺失，暂时无法恢复散步';
      } else if (error && error.code === 'WALK_ABANDONED') {
        title = '上次散步已超时关闭，请重试';
      }
      wx.showToast({ title, icon: 'none' });
    } finally {
      if (this._goPreferenceEpoch === epoch) this._goPreferenceBusy = false;
    }
  }
});
