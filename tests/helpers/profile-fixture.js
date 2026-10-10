const { buildProfile } = require('../../cloudfunctions/preferenceProfileStore/profile-builder');
const time = '2026-10-09T00:30:00.000Z';
function preferenceProfile(count = 3, { walkChanges = {}, feedback = [] } = {}) {
  return buildProfile({ ownerKey: 'test-owner', lastUpdatedAt: time,
    walks: Array.from({ length: count }, (_, i) => ({ ownerKey: 'test-owner', walkId: `w-${i}`,
      status: 'completed', endTime: time, actualDurationSeconds: 1800, requestedDurationMinutes: 30,
      preferences: { environmentPreferences: ['公园', '水边', '街道', '商街'], crowdPreference: 'low' },
      ...(typeof walkChanges === 'function' ? walkChanges(i) : walkChanges) })),
    feedback: feedback.map((f, i) => ({ ownerKey: 'test-owner', walkId: `w-${i}`, createdAt: time,
      rating: 4, wouldRecommend: true, observedCrowdLevel: 'low', positiveTags: [], negativeTags: [], ...f }))
  });
}
function historyItem(i, overrides = {}) {
  return { walkId: `walk-${String(i).padStart(3, '0')}`, status: i % 2 ? 'ended_early' : 'completed',
    startTime: '2026-10-09T00:00:00.000Z', endTime: time, actualDurationSeconds: 1800,
    routeType: 'loop', requestedDurationMinutes: 45, trajectoryEnabled: false, trajectoryPartial: false,
    trajectoryEndTimeMs: Date.parse(time), rating: i % 2 ? 4 : null, ...overrides };
}
module.exports = { preferenceProfile, historyItem };
