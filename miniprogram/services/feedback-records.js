const { callCloudFunction } = require('./cloud-function-client');
const { validId, fields } = require('../utils/feedback-validation');
async function request(action, input) {
  if (!validId(input.walkId)) throw new Error('Invalid walk identity.');
  const payload = action === 'submitFeedback' ? fields(input) : { walkId: input.walkId };
  const result = await callCloudFunction('feedbackStore', { action, ...payload }, {
    fallbackCode: 'FEEDBACK_STORE_FAILED', fallbackMessage: '暂时无法保存评价，请重试'
  });
  if (action === 'getFeedback' && result.feedback === null) return null;
  const record = result.feedback;
  if (!record || record.walkId !== input.walkId || !validId(record.routeId) || record.schemaVersion !== 1 ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
      (action === 'submitFeedback' && typeof result.created !== 'boolean')) throw new Error('Invalid feedback response.');
  const feedback = { ...fields(record), routeId: record.routeId, schemaVersion: 1, createdAt: record.createdAt };
  return action === 'getFeedback' ? feedback : { feedback, created: result.created };
}
module.exports = {
  getFeedback: walkId => request('getFeedback', { walkId }),
  submitFeedback: input => request('submitFeedback', input)
};
