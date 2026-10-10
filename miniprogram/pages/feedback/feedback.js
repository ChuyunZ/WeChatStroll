const records = require('../../services/feedback-records');
const sessions = require('../../services/active-walk-session');
const { validId, fields, POSITIVE_TAGS, NEGATIVE_TAGS } = require('../../utils/feedback-validation');
const options = (values, labels) => values.map((value, index) => ({ value, label: labels[index], selected: false }));
Page({
  data: {
    state: 'loading', error: '', summary: '', submitting: false, skipping: false, canSubmit: false, canSkip: false,
    rating: null, observedCrowdLevel: '', wouldRecommend: null, comment: '', positiveTags: [], negativeTags: [],
    ratings: [1, 2, 3, 4, 5],
    crowds: options(['low', 'medium', 'high'], ['人少', '适中', '人多']),
    positiveOptions: options(POSITIVE_TAGS, ['风景不错', '很安静', '路线舒服', '时长刚好']),
    negativeOptions: options(NEGATIVE_TAGS, ['太拥挤', '太安静', '距离太长', '距离太短', '时间太长', '时间太短', '不太好走', '途经地点没意思'])
  },
  onLoad(query = {}) { this._walkId = query.walkId; return this.loadFeedback(); },
  async loadFeedback() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ state: 'loading', error: '', canSkip: false });
    let pending = null;
    try {
      if (!validId(this._walkId)) { this.setData({ state: 'empty' }); return; }
      pending = sessions.getPendingWalkResult();
      if (pending && pending.walkId !== this._walkId) { this.setData({ state: 'empty' }); return; }
      const existing = await records.getFeedback(this._walkId);
      if (existing) { this.showSuccess(); return; }
      if (!pending) { this.setData({ state: 'empty' }); return; }
      this.setData({ state: 'form', canSkip: true, summary: `${pending.completionStatus === 'completed' ? '已完成散步' : '提前结束'} · ${Math.floor(pending.actualDurationSeconds / 60)} 分钟` });
    } catch (_) {
      this.setData({
        state: 'error',
        error: '暂时无法读取评价，请重试。散步记录已保留。',
        canSkip: Boolean(pending && pending.walkId === this._walkId)
      });
    } finally { this._loading = false; }
  },
  editable() { return this.data.state === 'form' && !this.data.submitting && !this.data.skipping; },
  updateForm(change) {
    this.setData(change);
    let canSubmit = false;
    try { fields({ ...this.data, walkId: this._walkId }); canSubmit = true; } catch (_) { /* incomplete form */ }
    this.setData({ canSubmit, error: '' });
  },
  selectRating(event) { if (this.editable()) this.updateForm({ rating: Number(event.currentTarget.dataset.value) }); },
  selectCrowd(event) { if (this.editable()) this.updateForm({ observedCrowdLevel: event.currentTarget.dataset.value }); },
  selectRecommend(event) { if (this.editable()) this.updateForm({ wouldRecommend: event.currentTarget.dataset.value === 'yes' }); },
  toggleTag(event) {
    if (!this.editable()) return;
    const { group, value } = event.currentTarget.dataset;
    if (!['positive', 'negative'].includes(group)) return;
    const key = `${group}Tags`, optionKey = `${group}Options`;
    if (!this.data[optionKey].some(item => item.value === value)) return;
    const tags = this.data[key].includes(value) ? this.data[key].filter(tag => tag !== value) : [...this.data[key], value];
    this.updateForm({ [key]: tags, [optionKey]: this.data[optionKey].map(item => ({ ...item, selected: tags.includes(item.value) })) });
  },
  onComment(event) { if (this.editable()) this.updateForm({ comment: event.detail.value.slice(0, 500) }); },
  showSuccess() {
    // Local cleanup failure cannot undo a confirmed cloud save; next load recovers it.
    try { sessions.clearPendingWalkResult(this._walkId); } catch (_) { /* recover on next load */ }
    this.setData({ state: 'success', error: '', canSkip: false });
  },
  async submitFeedback() {
    if (!this.editable()) return;
    let payload;
    try { payload = fields({ ...this.data, walkId: this._walkId }); }
    catch (_) { this.setData({ error: '请填写评分、实际人流和是否推荐。' }); return; }
    this.setData({ submitting: true, error: '' });
    try { await records.submitFeedback(payload); this.showSuccess(); }
    catch (_) { this.setData({ error: '保存失败，请点击提交重试。已填写的内容和散步记录均已保留。' }); }
    finally { this.setData({ submitting: false }); }
  },
  skipFeedback() {
    if (
      !this.data.canSkip ||
      !['form', 'error'].includes(this.data.state) ||
      this.data.submitting ||
      this.data.skipping
    ) return;
    this.setData({ skipping: true });
    wx.showModal({ title: '跳过本次评价？', content: this.data.comment.trim()
      ? '跳过后，本次评价和未保存的散步日志都会丢失；散步记录仍会保留。'
      : '本次散步记录仍会保留，但这次评价不会保存。',
      success: result => {
        if (!result.confirm) return;
        try {
          if (!sessions.clearPendingWalkResult(this._walkId)) {
            this.setData({ error: '待评价的散步已发生变化，请重新进入评价。', canSkip: false });
            return;
          }
          this.setData({ canSkip: false });
          this.returnHome();
        } catch (_) { this.setData({ error: '暂时无法跳过，请重试。' }); }
      },
      complete: () => this.setData({ skipping: false })
    });
  },
  returnHome() { wx.reLaunch({ url: '/pages/home/home' }); }
});
