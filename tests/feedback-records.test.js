const { createFeedbackHandler } = require('../cloudfunctions/feedbackStore/handler');
const { createTestStore } = require('../cloudfunctions/mapProvider/test-store');
const crypto = require('crypto');
const valid = { walkId: 'walk-1', rating: 5, observedCrowdLevel: 'low', wouldRecommend: false, positiveTags: [], negativeTags: [], comment: ' hi ' };
let service, store;
beforeEach(() => {
  store = createTestStore();
  store.documents.set('walks/walk-1', { walkId: 'walk-1', routeId: 'route-1', status: 'completed', ownerKey: crypto.createHash('sha256').update('user').digest('hex') });
  const handle = createFeedbackHandler({ store, getOpenId: () => 'user' });
  global.wx = { cloud: { callFunction: jest.fn(async ({ data }) => ({ result: await handle(data) })) } };
  service = require('../miniprogram/services/feedback-records');
});
afterEach(() => { delete global.wx; });
test('client and deployable backend validators remain identical', () => {
  const fs = require('fs');
  expect(fs.readFileSync('miniprogram/utils/feedback-validation.js', 'utf8')).toBe(fs.readFileSync('cloudfunctions/feedbackStore/validation.js', 'utf8'));
});
test.each(['walkId','rating','observedCrowdLevel','wouldRecommend','positiveTags','negativeTags'])('validates %s before request', async key => {
  const input = { ...valid }; delete input[key];
  await expect(service.submitFeedback(input)).rejects.toThrow();
  expect(wx.cloud.callFunction).not.toHaveBeenCalled();
});
test('allowlists payload and supports get, submit and existing recovery', async () => {
  expect(await service.getFeedback(valid.walkId)).toBeNull();
  const saved = await service.submitFeedback({ ...valid, routeId: 'forged', ownerKey: 'forged', route: { polyline: [1] }, providerMeta: {}, gps: [] });
  expect(wx.cloud.callFunction.mock.calls.at(-1)[0]).toEqual({ name: 'feedbackStore', data: { action: 'submitFeedback', ...valid, comment: 'hi' } });
  expect(saved.created).toBe(true);
  expect(await service.getFeedback(valid.walkId)).toEqual(saved.feedback);
  expect(await service.submitFeedback({ ...valid, rating: 1 })).toEqual({ ...saved, created: false });
});
test.each([null, {}, { walkId: 'other' }, { rating: 9 }, { wouldRecommend: 'no' }, { positiveTags: ['forged'] }, { schemaVersion: 2 }, { createdAt: null }, { routeId: '../bad' }])('rejects malformed response %j', async change => {
  const saved = await service.submitFeedback(valid);
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, created: true, feedback: change === null ? null : change && Object.keys(change).length ? { ...saved.feedback, ...change } : {} } });
  await expect(service.submitFeedback(valid)).rejects.toThrow();
});
test('rejects invalid created flag and malformed get identity', async () => {
  const saved = await service.submitFeedback(valid);
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, feedback: saved.feedback, created: 'false' } });
  await expect(service.submitFeedback(valid)).rejects.toThrow();
  await expect(service.getFeedback('../bad')).rejects.toThrow();
});
