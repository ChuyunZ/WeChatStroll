const crypto = require('crypto');
const { transact } = require('./store');
const { validId, fields } = require('./validation');
const messages = {
  UNAUTHENTICATED: 'Unable to identify the current user.',
  INVALID_ACTION: 'Unsupported feedback operation.',
  INVALID_INPUT: 'Invalid feedback metadata.',
  WALK_NOT_FOUND: 'Walk not found.',
  FEEDBACK_NOT_ALLOWED: 'Feedback requires a completed or ended-early walk.',
  FEEDBACK_STORE_FAILED: 'Feedback storage is temporarily unavailable.'
};
function fail(code) { throw Object.assign(new Error(messages[code]), { code }); }
function publicFailure(error) {
  const code = Object.hasOwn(messages, error && error.code) ? error.code : 'FEEDBACK_STORE_FAILED';
  return { success: false, error: { code, message: messages[code] } };
}
function publicFeedback(record) {
  return record ? { ...fields(record), routeId: record.routeId, schemaVersion: record.schemaVersion, createdAt: record.createdAt } : null;
}
function createFeedbackHandler({ store, getOpenId, now = Date.now, sleep }) {
  return async (event = {}) => {
    try {
      const openid = getOpenId();
      if (typeof openid !== 'string' || !openid.trim()) fail('UNAUTHENTICATED');
      const ownerKey = crypto.createHash('sha256').update(openid).digest('hex');
      if (!event || !['getFeedback', 'submitFeedback'].includes(event.action)) fail('INVALID_ACTION');
      if (!validId(event.walkId)) fail('INVALID_INPUT');
      let payload;
      if (event.action === 'submitFeedback') {
        try { payload = fields(event); } catch (_) { fail('INVALID_INPUT'); }
      }
      return await transact(store, async tx => {
        const walk = await tx.get(`walks/${event.walkId}`);
        if (!walk || walk.ownerKey !== ownerKey) fail('WALK_NOT_FOUND');
        if (payload && !['completed', 'ended_early'].includes(walk.status)) fail('FEEDBACK_NOT_ALLOWED');
        const path = `feedback/${event.walkId}`;
        const existing = await tx.get(path);
        if (existing && existing.ownerKey !== ownerKey) fail('WALK_NOT_FOUND');
        if (!payload) return { success: true, feedback: publicFeedback(existing) };
        if (existing) return { success: true, feedback: publicFeedback(existing), created: false };
        const record = { ...payload, ownerKey, routeId: walk.routeId, schemaVersion: 1, createdAt: new Date(now()).toISOString() };
        await tx.set(path, record);
        return { success: true, feedback: publicFeedback(record), created: true };
      }, sleep);
    } catch (error) { return publicFailure(error); }
  };
}
module.exports = { createFeedbackHandler, publicFailure };
