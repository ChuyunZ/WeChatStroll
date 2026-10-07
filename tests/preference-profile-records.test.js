const fs = require('fs');
const service = require('../miniprogram/services/preference-profile-records');
const { buildProfile } = require('../cloudfunctions/preferenceProfileStore/profile-builder');
const time = '2026-10-07T00:00:00.000Z';
const profile = () => buildProfile({ ownerKey: 'owner', lastUpdatedAt: time,
  walks: [{ ownerKey: 'owner', walkId: 'walk-1', endTime: time, status: 'completed' }] });
beforeEach(() => { global.wx = { cloud: { callFunction: jest.fn().mockResolvedValue({ result: { success: true, profile: null } }) } }; });
afterEach(() => { delete global.wx; });
test('deployable server and Mini Program schema validators stay identical', () => {
  expect(fs.readFileSync('cloudfunctions/preferenceProfileStore/profile-schema.js', 'utf8'))
    .toBe(fs.readFileSync('miniprogram/utils/preference-profile-schema.js', 'utf8'));
});
test.each(['getProfile', 'refreshProfile'])('%s sends action only, safely accepts null and validated profile', async action => {
  expect(await service[action]({ ownerKey: 'forged', history: [1], weights: {} })).toBeNull();
  expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'preferenceProfileStore', data: { action } });
  const p = profile();
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, profile: p } });
  expect(await service[action]()).toEqual(p);
});
test.each([
  p => undefined, p => ({}), p => ({ ...p, ownerKey: 'forged' }), p => ({ ...p, revision: 1 }),
  p => ({ ...p, schemaVersion: 2 }), p => ({ ...p, environmentWeights: { ...p.environmentWeights, park: 2 } }),
  p => ({ ...p, preferredDurationMinutes: 31 }), p => ({ ...p, crowdPreferenceSignal: NaN }),
  p => ({ ...p, evidenceWalkCount: 21 }), p => ({ ...p, completedWalkCount: 0 }),
  p => ({ ...p, likedTags: ['quiet'] }), p => ({ ...p, dislikedTags: ['unknown'] }),
  p => ({ ...p, evidence: null }), p => ({ ...p, evidence: { ...p.evidence, gps: [] } }),
  p => ({ ...p, source: { ...p.source, historyLimit: 21 } }), p => ({ ...p, source: { ...p.source, fingerprint: 'bad' } }),
  p => ({ ...p, lastUpdatedAt: 'bad' }), p => ({ ...p, environmentWeights: { ...p.environmentWeights, polyline: [] } }),
  p => ({ ...p, evidence: { ...p.evidence, positiveTagCounts: { ...p.evidence.positiveTagCounts, quiet: -1 } } })
])('rejects malformed success profile %#', async mutate => {
  wx.cloud.callFunction.mockResolvedValue({ result: { success: true, profile: mutate(profile()) } });
  await expect(service.getProfile()).rejects.toThrow();
});
test('normalizes network failure and rejects unsuccessful envelope', async () => {
  wx.cloud.callFunction.mockRejectedValue(new Error('network'));
  await expect(service.refreshProfile()).rejects.toMatchObject({ code: 'PREFERENCE_PROFILE_STORE_FAILED' });
  wx.cloud.callFunction.mockResolvedValue({ result: { success: false } });
  await expect(service.getProfile()).rejects.toThrow();
});
