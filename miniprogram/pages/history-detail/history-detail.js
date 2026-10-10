const walkRecords = require('../../services/walk-records');
const feedbackRecords = require('../../services/feedback-records');
const historyTrace = require('../../services/history-trace');
const { validId } = require('../../utils/feedback-validation');
const { validateTraceResponse } = require('../../utils/history-trace-schema');
const { walkView, feedbackView } = require('../../utils/history-detail');
const { traceMap } = require('../../utils/history-trace-map');

Page({
  data: { walkState: 'loading', feedbackState: 'loading', gpsState: 'idle', walk: null, feedback: null, map: null, tracePartial: false },
  onLoad(options = {}) {
    this._walkId = validId(options.walkId) ? options.walkId : null;
    this._active = false; this._disposed = false; this._versions = { walk: 0, feedback: 0, gps: 0 }; this._busy = {};
    if (!this._walkId) this.setData({ walkState: 'unavailable', feedbackState: 'empty', gpsState: 'disabled' });
  },
  onShow() {
    if (this._disposed || this._active) return;
    this._active = true;
    if (!this._walkId) return;
    if (this.data.gpsState === 'loading') this.setData({ gpsState: 'idle' });
    return Promise.all([
      this.data.walkState === 'loading' ? this.loadWalk() : null,
      this.data.feedbackState === 'loading' ? this.loadFeedback() : null
    ]);
  },
  onHide() {
    this._active = false;
    Object.keys(this._versions).forEach(key => this._versions[key]++);
    this._busy = {};
  },
  onUnload() {
    this.onHide(); this._disposed = true; this._walkId = null;
    // Release native-map payload references without setData on an unloaded page.
    this.data.map = null; this.data.feedback = null; this.data.walk = null;
    const channel = typeof this.getOpenerEventChannel === 'function' ? this.getOpenerEventChannel() : null;
    if (channel && typeof channel.emit === 'function') channel.emit('historyDetailClosed');
  },
  current(key, version, id) { return this._active && !this._disposed && this._versions[key] === version && this._walkId === id; },
  async loadArea(key, work, success, failure) {
    if (!this._active || this._disposed || !this._walkId || this._busy[key]) return;
    const id = this._walkId, version = ++this._versions[key];
    this._busy[key] = true;
    this.setData({ [`${key}State`]: 'loading' });
    try {
      const value = await work(id);
      if (this.current(key, version, id)) this.setData(success(value, id));
    } catch (error) {
      if (this.current(key, version, id)) this.setData(failure(error));
    } finally {
      if (this.current(key, version, id)) this._busy[key] = false;
    }
  },
  loadWalk() {
    return this.loadArea('walk', id => walkRecords.getWalk(id), (record, id) => {
      if (record === null) return { walkState: 'unavailable', walk: null, gpsState: 'disabled' };
      const walk = walkView(record, id);
      return { walkState: 'ready', walk, gpsState: walk.trajectoryEnabled ? 'idle' : 'disabled' };
    }, error => ({ walkState: error && error.code === 'WALK_NOT_FOUND' ? 'unavailable' : 'error', walk: null }));
  },
  loadFeedback() {
    return this.loadArea('feedback', id => feedbackRecords.getFeedback(id), (record, id) => {
      const feedback = feedbackView(record, id);
      return { feedbackState: feedback ? 'ready' : 'empty', feedback };
    }, () => ({ feedbackState: 'error', feedback: null }));
  },
  retryWalk() { if (this.data.walkState === 'error') return this.loadWalk(); },
  retryFeedback() { if (this.data.feedbackState === 'error') return this.loadFeedback(); },
  loadTrace() {
    if (this.data.walkState !== 'ready' || !this.data.walk.trajectoryEnabled || !['idle', 'empty', 'error'].includes(this.data.gpsState)) return;
    return this.loadArea('gps', walkId => historyTrace.searchWalkTrace({ walkId }), value => {
      const trace = validateTraceResponse({ success: true, trace: value });
      const map = traceMap(trace.points);
      return { gpsState: map.total ? 'ready' : 'empty', map: map.total ? map : null, tracePartial: trace.partial };
    }, () => ({ gpsState: 'error', map: null, tracePartial: false }));
  }
});
