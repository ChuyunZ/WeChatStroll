const crypto = require('crypto');
const { createProfileHandler } = require('./handler');
const { PUBLIC_FIELDS } = require('./profile-schema');
const ownerKey = crypto.createHash('sha256').update('user').digest('hex');
const time = '2026-10-07T00:00:00.000Z';
function fixture({ random = () => 0 } = {}) {
  let record = null;
  const history = { walks: [{ ownerKey, walkId: 'walk-1', status: 'completed', endTime: time, requestedDurationMinutes: 30 }], feedback: [] };
  const store = {
    getProfile: jest.fn(async () => record), loadHistory: jest.fn(async () => JSON.parse(JSON.stringify(history))),
    compareAndSet: jest.fn(async (owner, expected, profile) => {
      if ((record ? record.revision : 0) !== expected) return { retry: true };
      if (profile && (!record || record.source.fingerprint !== profile.source.fingerprint)) record = { ownerKey: owner, revision: expected + 1, ...profile };
      return { retry: false, record };
    })
  };
  const sleep = jest.fn(async () => {});
  const logUnexpectedFields = jest.fn();
  const handle = createProfileHandler({
    store, getOpenId: () => 'user', now: () => Date.parse(time), sleep, random, logUnexpectedFields
  });
  return { handle, store, history, sleep, logUnexpectedFields };
}
test('authentication uses server context; get and empty refresh return null safely', async () => {
  const f = fixture();
  expect(await f.handle({ action: 'getProfile' })).toEqual({ success: true, profile: null });
  f.history.walks = [];
  expect(await f.handle({ action: 'refreshProfile' })).toEqual({ success: true, profile: null });
  expect(f.store.getProfile).toHaveBeenCalledWith(ownerKey);
  const unauthenticated = createProfileHandler({ store: f.store, getOpenId: () => '' });
  expect((await unauthenticated({ action: 'refreshProfile', OPENID: 'user' })).error.code).toBe('UNAUTHENTICATED');
});
test('ignores CloudBase-injected userInfo and still derives identity from server context', async () => {
  const f = fixture();
  expect(await f.handle({ action: 'getProfile', userInfo: { openId: 'forged', appId: 'forged' } }))
    .toEqual({ success: true, profile: null });
  expect(f.store.getProfile).toHaveBeenCalledWith(ownerKey);
});
test.each(['ownerKey', 'walkIds', 'feedback', 'weights', 'profile', 'history', 'OPENID'])('rejects client %s computation/identity inputs', async key => {
  const f = fixture();
  expect((await f.handle({ action: 'refreshProfile', [key]: 'forged' })).error.code).toBe('INVALID_INPUT');
  expect(f.logUnexpectedFields).toHaveBeenCalledWith([key]);
  expect(f.store.loadHistory).not.toHaveBeenCalled();
});
test('invalid action is safe', async () => {
  expect((await fixture().handle(null)).error.code).toBe('INVALID_ACTION');
});
test('refresh writes exact public schema, get excludes owner/revision, repeated refresh is idempotent', async () => {
  const f = fixture();
  f.history.walks.push({ ...f.history.walks[0], ownerKey: 'other', walkId: 'foreign' });
  f.history.feedback.push({ walkId: 'walk-1', ownerKey: 'other', createdAt: time, positiveTags: ['quiet'] });
  const first = await f.handle({ action: 'refreshProfile' });
  expect(first.success).toBe(true);
  expect(first.profile).toMatchObject({ evidenceWalkCount: 1, feedbackCount: 0 });
  expect(Object.keys(first.profile).sort()).toEqual([...PUBLIC_FIELDS].sort());
  expect(Object.keys(f.store.compareAndSet.mock.calls[0][2]).sort()).toEqual([...PUBLIC_FIELDS].sort());
  expect(await f.handle({ action: 'getProfile' })).toEqual(first);
  expect(await f.handle({ action: 'refreshProfile' })).toEqual(first);
  expect((await f.store.getProfile()).revision).toBe(1);
});
test.each(['getProfile', 'loadHistory', 'compareAndSet'])('database %s failure is normalized with no details', async method => {
  const f = fixture();
  f.store[method].mockRejectedValue(new Error('secret database payload'));
  const result = await f.handle({ action: 'refreshProfile' });
  expect(result.error.code).toBe('PREFERENCE_PROFILE_STORE_FAILED');
  expect(JSON.stringify(result)).not.toContain('secret');
});
test('stale refresh loses CAS, reloads feedback even when latest timestamp is unchanged, and cannot regress profile', async () => {
  const f = fixture();
  f.history.walks.push({ ...f.history.walks[0], walkId: 'walk-2' });
  f.history.feedback.push({ ownerKey, walkId: 'walk-2', createdAt: time, positiveTags: ['quiet'] });
  let release, ready;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const originalLoad = f.store.loadHistory.getMockImplementation();
  f.store.loadHistory.mockImplementationOnce(async () => {
    const old = await originalLoad(); ready(); await blocked; return old;
  });
  const stale = f.handle({ action: 'refreshProfile' });
  await started;
  f.history.feedback.push({ ownerKey, walkId: 'walk-1', createdAt: time, negativeTags: ['too_crowded'], observedCrowdLevel: 'medium' });
  const newer = await f.handle({ action: 'refreshProfile' });
  release();
  expect(await stale).toEqual(newer);
  expect(newer.profile.feedbackCount).toBe(2);
  expect(f.store.loadHistory).toHaveBeenCalledTimes(3);
  expect((await f.store.getProfile()).revision).toBe(1);
});
test('conflicts re-read full history; retry budget is bounded and jittered', async () => {
  const random = jest.fn(() => 0.5);
  const f = fixture({ random });
  f.store.compareAndSet.mockRejectedValue({ code: 'DATABASE_TRANSACTION_CONFLICT' });
  expect((await f.handle({ action: 'refreshProfile' })).error.code).toBe('PREFERENCE_PROFILE_STORE_FAILED');
  expect(f.store.loadHistory).toHaveBeenCalledTimes(4);
  expect(f.sleep.mock.calls.map(([ms]) => ms)).toEqual([15, 30, 60]);
  expect(random).toHaveBeenCalledTimes(3);
});
test('corrupt stored owner or profile fails closed', async () => {
  const f = fixture();
  await f.handle({ action: 'refreshProfile' });
  const saved = await f.store.getProfile();
  f.store.getProfile.mockResolvedValue({ ...saved, ownerKey: 'other' });
  expect((await f.handle({ action: 'getProfile' })).success).toBe(false);
  f.store.getProfile.mockResolvedValue({ ...saved, evidence: { gps: [1] } });
  expect((await f.handle({ action: 'getProfile' })).success).toBe(false);
});
test('internal empty tombstones are returned only as null', async () => {
  const f = fixture();
  f.store.getProfile.mockResolvedValue({ ownerKey, revision: 4, profile: null });
  expect(await f.handle({ action: 'getProfile' })).toEqual({ success: true, profile: null });
});
