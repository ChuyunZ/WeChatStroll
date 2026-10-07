const crypto = require('crypto');
const { createFeedbackHandler } = require('./handler');
const { createTestStore } = require('../mapProvider/test-store');
const valid = { action: 'submitFeedback', walkId: 'walk-1', rating: 4, observedCrowdLevel: 'medium', wouldRecommend: false, positiveTags: ['nice_view'], negativeTags: ['too_crowded'], comment: '  good  ' };
function fixture(status = 'completed') {
  const store = createTestStore();
  const walk = { walkId: 'walk-1', routeId: 'authoritative-route', status, ownerKey: crypto.createHash('sha256').update('user').digest('hex') };
  store.documents.set('walks/walk-1', walk);
  const handler = user => createFeedbackHandler({ store, getOpenId: () => user, now: () => 1791280800000, sleep: async () => {} });
  return { store, walk, handler, call: handler('user') };
}
test('authentication and supported action required', async () => {
  const f = fixture();
  expect((await f.handler('')(valid)).error.code).toBe('UNAUTHENTICATED');
  expect((await f.call({ action: 'delete' })).error.code).toBe('INVALID_ACTION');
});
test.each([
  ['walkId', '../bad'], ['walkId', ''], ['rating', 0], ['rating', 6], ['rating', 1.5], ['rating', '4'],
  ['observedCrowdLevel', 'quiet'], ['wouldRecommend', 'false'], ['wouldRecommend', null],
  ['positiveTags', ['too_crowded']], ['negativeTags', ['quiet']], ['positiveTags', ['quiet', 'quiet']],
  ['negativeTags', ['too_quiet', 'too_quiet']], ['positiveTags', 'quiet'], ['negativeTags', null],
  ['comment', 'a'.repeat(501)], ['comment', {}]
])('rejects invalid %s %j', async (key, value) => {
  const f = fixture();
  expect((await f.call({ ...valid, [key]: value })).error.code).toBe('INVALID_INPUT');
  expect(f.store.documents.size).toBe(1);
});
test.each(['active', 'abandoned'])('rejects %s without changing walk', async status => {
  const f = fixture(status);
  expect((await f.call(valid)).error.code).toBe('FEEDBACK_NOT_ALLOWED');
  expect(f.store.documents.get('walks/walk-1')).toEqual(f.walk);
  expect(f.store.documents.size).toBe(1);
});
test.each(['completed', 'ended_early'])('allows %s and stores exact safe schema', async status => {
  const f = fixture(status);
  const response = await f.call({ ...valid, routeId: 'forged', ownerKey: 'forged', openid: 'forged', route: {}, polyline: [], pois: [], providerMeta: {}, gps: [], rawResponse: {} });
  expect(response).toMatchObject({ success: true, created: true, feedback: { routeId: f.walk.routeId, comment: 'good', wouldRecommend: false } });
  expect(response.feedback).not.toHaveProperty('ownerKey');
  expect(f.store.documents.get('feedback/walk-1')).toEqual({ ...response.feedback, ownerKey: f.walk.ownerKey });
  expect(Object.keys(response.feedback).sort()).toEqual(['walkId','routeId','rating','observedCrowdLevel','wouldRecommend','positiveTags','negativeTags','comment','schemaVersion','createdAt'].sort());
  expect(f.store.documents.get('walks/walk-1')).toEqual(f.walk);
});
test.each(['getFeedback', 'submitFeedback'])('%s does not reveal another user walk', async action => {
  const f = fixture();
  const other = await f.handler('other')({ ...valid, action });
  expect(other).toEqual(await f.call({ ...valid, action, walkId: 'missing' }));
  expect(other.error.code).toBe('WALK_NOT_FOUND');
});
test.each([undefined, null, '', '  '])('normalizes empty comment %j', async comment => {
  expect((await fixture().call({ ...valid, comment })).feedback.comment).toBeNull();
});
test('reads null or existing record; duplicate values never overwrite', async () => {
  const f = fixture(); const get = { action: 'getFeedback', walkId: valid.walkId };
  expect(await f.call(get)).toEqual({ success: true, feedback: null });
  const first = await f.call(valid);
  expect(await f.call({ ...valid, rating: 1 })).toEqual({ ...first, created: false });
  expect((await f.call(get)).feedback).toEqual(first.feedback);
});
test('concurrent independent handlers create one record after conflict retry', async () => {
  const f = fixture();
  const responses = await Promise.all([f.call(valid), f.handler('user')({ ...valid, rating: 1 })]);
  expect(responses.map(r => r.created).sort()).toEqual([false, true]);
  expect(responses[0].feedback).toEqual(responses[1].feedback);
  expect(f.store.conflicts).toBeGreaterThan(0);
  expect(f.store.documents.size).toBe(2);
});
test('response loss retry returns original feedback successfully', async () => {
  const f = fixture();
  f.store.afterCommit = () => { f.store.afterCommit = null; throw new Error('lost response'); };
  expect((await f.call(valid)).success).toBe(false);
  expect(await f.call({ ...valid, rating: 1 })).toMatchObject({ success: true, created: false, feedback: { rating: 4 } });
  expect(f.store.documents.size).toBe(2);
});
test('database errors are normalized, conflicts bounded, walk untouched', async () => {
  const f = fixture();
  f.store.forcedConflicts = 10;
  expect((await f.call(valid)).error.code).toBe('FEEDBACK_STORE_FAILED');
  expect(f.store.transactions).toBe(4);
  f.store.failure = new Error('secret database details');
  expect(await f.call(valid)).toEqual({ success: false, error: { code: 'FEEDBACK_STORE_FAILED', message: 'Feedback storage is temporarily unavailable.' } });
  expect(f.store.documents.size).toBe(1);
});
