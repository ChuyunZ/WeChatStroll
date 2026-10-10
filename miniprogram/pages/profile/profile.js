const walkRecords = require('../../services/walk-records');
const preferenceRecords = require('../../services/preference-profile-records');
const { profileInsights } = require('../../utils/profile-insights');
const { historyCard } = require('../../utils/profile-history');

Page({
  data: {
    historyState: 'loading', profileState: 'loading', totals: null, insights: null,
    visibleHistory: [], expanded: false, canExpand: false, hasMore: false,
    moreState: 'idle', moreError: ''
  },
  onLoad() {
    this._active = false;
    this._disposed = false;
    this._historyVersion = 0;
    this._profileVersion = 0;
    this._history = [];
  },
  onShow() {
    if (this._disposed || this._active) return;
    this._active = true;
    return Promise.all([this.loadHistory(), this.loadProfile()]);
  },
  onHide() { this.invalidateRequests(); },
  onUnload() {
    this.invalidateRequests();
    this._disposed = true;
    this._history = [];
    this._nextCursor = null;
  },
  invalidateRequests() {
    this._active = false;
    this._historyVersion++;
    this._profileVersion++;
    this._historyBusy = false;
    this._profileBusy = false;
    this._moreBusy = false;
  },
  currentHistory(version) { return this._active && !this._disposed && this._historyVersion === version; },
  currentProfile(version) { return this._active && !this._disposed && this._profileVersion === version; },
  async loadHistory() {
    if (!this._active || this._disposed || this._historyBusy) return;
    this._historyBusy = true;
    const version = ++this._historyVersion;
    this._moreBusy = false;
    this._history = [];
    this._nextCursor = null;
    this.setData({ historyState: 'loading', totals: null, visibleHistory: [], expanded: false,
      canExpand: false, hasMore: false, moreState: 'idle', moreError: '' });
    try {
      const result = await walkRecords.listHistory({ limit: 10, cursor: null });
      if (!this.currentHistory(version)) return;
      this._history = result.items.map(historyCard);
      this._nextCursor = result.nextCursor;
      this.setData({ historyState: this._history.length ? 'ready' : 'empty', totals: result.totals });
      this.renderHistory();
    } catch (_) {
      if (this.currentHistory(version)) this.setData({ historyState: 'error' });
    } finally {
      if (this.currentHistory(version)) this._historyBusy = false;
    }
  },
  async loadProfile() {
    if (!this._active || this._disposed || this._profileBusy) return;
    this._profileBusy = true;
    const version = ++this._profileVersion;
    this.setData({ profileState: 'loading', insights: null });
    try {
      const profile = await preferenceRecords.refreshProfile();
      if (!this.currentProfile(version)) return;
      const insights = profileInsights(profile);
      this.setData({ profileState: insights ? 'ready' : 'empty', insights });
    } catch (_) {
      if (this.currentProfile(version)) this.setData({ profileState: 'error' });
    } finally {
      if (this.currentProfile(version)) this._profileBusy = false;
    }
  },
  renderHistory() {
    this.setData({ visibleHistory: this.data.expanded ? this._history : this._history.slice(0, 3),
      canExpand: this._history.length > 3 || Boolean(this._nextCursor), hasMore: Boolean(this._nextCursor) });
  },
  toggleHistory() {
    if (!this._active || this.data.historyState !== 'ready' || !this.data.canExpand) return;
    this.setData({ expanded: !this.data.expanded });
    this.renderHistory();
  },
  async loadMore() {
    if (!this._active || this._disposed || this._historyBusy || this._moreBusy ||
        this.data.historyState !== 'ready' || !this.data.expanded || !this._nextCursor || this.data.moreState === 'invalid') return;
    this._moreBusy = true;
    const version = this._historyVersion;
    const cursor = this._nextCursor;
    this.setData({ moreState: 'loading', moreError: '' });
    try {
      const result = await walkRecords.listHistory({ limit: 10, cursor });
      if (!this.currentHistory(version)) return;
      const seen = new Set(this._history.map(item => item.walkId));
      const additions = result.items.filter(item => {
        if (seen.has(item.walkId)) return false;
        seen.add(item.walkId);
        return true;
      }).map(historyCard);
      this._history = [...this._history, ...additions];
      this._nextCursor = result.nextCursor;
      this.setData({ moreState: 'idle' });
      this.renderHistory(); // Continuation totals are null; retain first-page totals.
    } catch (error) {
      if (!this.currentHistory(version)) return;
      const invalid = error && error.code === 'INVALID_HISTORY_CURSOR';
      this.setData({ moreState: invalid ? 'invalid' : 'error', moreError: invalid
        ? '历史记录可能发生了变化，请重新加载。' : '更多散步记录暂时无法加载，请重试。' });
    } finally {
      if (this.currentHistory(version)) this._moreBusy = false;
    }
  },
  retryHistory() { if (this.data.historyState === 'error') return this.loadHistory(); },
  retryProfile() { if (this.data.profileState === 'error') return this.loadProfile(); },
  reloadHistory() { if (this.data.moreState === 'invalid') return this.loadHistory(); }
});
