const { buildProfile, SCORING } = require('./profile-builder');
const { validateProfile, POSITIVE_TAGS, NEGATIVE_TAGS } = require('./profile-schema');
const ownerKey = 'owner';
const time = '2026-10-07T00:00:00.000Z';
const walk = (change = {}) => ({ ownerKey, walkId: 'walk-1', status: 'completed', endTime: time,
  requestedDurationMinutes: 30, actualDurationSeconds: 2400,
  preferences: { environmentPreferences: ['公园', '水边', '街道', '商街'], crowdPreference: 'medium' }, ...change });
const feedback = (change = {}) => ({ ownerKey, walkId: 'walk-1', createdAt: time,
  rating: 3, wouldRecommend: false, observedCrowdLevel: 'medium', positiveTags: [], negativeTags: [], ...change });
const build = (walks = [walk()], records = []) => buildProfile({ walks, feedback: records, ownerKey, lastUpdatedAt: time });
test('empty, active, abandoned, invalid identity/time and foreign history produce null', () => {
  expect(build([])).toBeNull();
  for (const change of [{ status: 'active' }, { status: 'abandoned' }, { ownerKey: 'other' }, { walkId: '../bad' }, { endTime: null }]) {
    expect(build([walk(change)])).toBeNull();
  }
});
test('one completed walk creates a bounded versioned profile; later ended-early walk changes it', () => {
  const first = build();
  expect(validateProfile(first)).toBe(first);
  expect(first).toMatchObject({ evidenceWalkCount: 1, completedWalkCount: 1, endedEarlyWalkCount: 0, preferredDurationMinutes: 30 });
  const later = build([walk(), walk({ walkId: 'walk-2', status: 'ended_early', endTime: '2026-10-08T00:00:00Z', requestedDurationMinutes: 60 })]);
  expect(later).toMatchObject({ evidenceWalkCount: 2, completedWalkCount: 1, endedEarlyWalkCount: 1, preferredDurationMinutes: 45 });
  expect(later.source.fingerprint).not.toBe(first.source.fingerprint);
});
test('environment scores and explainability use only complete unique questionnaire rankings', () => {
  expect(build().environmentWeights).toEqual({ park: 1, water: 0.67, street: 0.33, shoppingStreet: 0 });
  const p = build([walk(), walk({ walkId: 'walk-2', preferences: { environmentPreferences: ['商街', '街道', '水边', '公园'] } })]);
  expect(p.environmentWeights).toEqual({ park: 0.5, water: 0.5, street: 0.5, shoppingStreet: 0.5 });
  expect(p.evidence.environment.park).toEqual({ firstChoiceCount: 1, topTwoCount: 1 });
  for (const ranking of [null, [], ['公园'], ['公园', '公园', '街道', '商街'], ['park', '水边', '街道', '商街']]) {
    expect(build([walk(), walk({ walkId: 'bad', preferences: { environmentPreferences: ranking } })]).environmentWeights).toEqual(build().environmentWeights);
  }
});
test.each([1, 5])('rating %i, recommendation and generic tags cannot change environment weights', rating => {
  expect(build(undefined, [feedback({ rating, wouldRecommend: true, positiveTags: ['nice_view', 'quiet'] })]).environmentWeights).toEqual(build().environmentWeights);
});
test.each([
  [['duration_good'], [], 35],
  [[], ['duration_too_long'], 25],
  [[], ['duration_too_short'], 45],
  [['duration_good'], ['duration_too_long'], 30],
  [[], ['duration_too_long', 'duration_too_short'], 30]
])('duration base plus feedback %j / %j gives %i', (positiveTags, negativeTags, expected) => {
  expect(build(undefined, [feedback({ positiveTags, negativeTags })]).preferredDurationMinutes).toBe(expected);
});
test.each([[15, 0, 'duration_too_long', 15], [120, 72000, 'duration_too_short', 120]])('duration targets clamp before averaging', (requestedDurationMinutes, actualDurationSeconds, tag, expected) => {
  expect(build([walk({ requestedDurationMinutes, actualDurationSeconds })], [feedback({ negativeTags: [tag] })]).preferredDurationMinutes).toBe(expected);
});
test('rounding is nearest five; missing evidence stays null; malformed actual does not invent adjustment', () => {
  expect(build([walk({ requestedDurationMinutes: 32.5 })]).preferredDurationMinutes).toBe(35);
  expect(build([walk({ requestedDurationMinutes: NaN, actualDurationSeconds: null, preferences: {} })])).toMatchObject({ preferredDurationMinutes: null, crowdPreferenceSignal: null });
  expect(build([walk({ actualDurationSeconds: '2400' })], [feedback({ positiveTags: ['duration_good'] })]).preferredDurationMinutes).toBe(30);
  expect(build([walk({ requestedDurationMinutes: null, preferences: { durationMinutes: 45 } })]).preferredDurationMinutes).toBe(45);
});
test('ended early actual time has no satisfaction meaning without explicit duration feedback', () => {
  const early = walk({ status: 'ended_early', actualDurationSeconds: 600 });
  expect(build([early]).preferredDurationMinutes).toBe(30);
  expect(build([early], [feedback({ negativeTags: ['duration_too_long'] })]).preferredDurationMinutes).toBe(20);
});
test.each([
  ['high', ['too_crowded'], [], 0], ['medium', ['too_crowded'], [], -0.6667],
  ['low', ['too_crowded'], [], -0.6667], ['low', ['too_quiet'], [], 0],
  ['medium', ['too_quiet'], [], 0.6667], ['high', ['too_quiet'], [], 0.6667],
  ['high', [], ['quiet'], -0.6667], ['high', ['too_crowded', 'too_quiet'], [], 0],
  ['high', ['too_quiet'], ['quiet'], 0], ['high', ['too_crowded'], ['quiet'], 0]
])('crowd %s %j %j yields %s', (observedCrowdLevel, negativeTags, positiveTags, expected) => {
  const p = build(undefined, [feedback({ observedCrowdLevel, negativeTags, positiveTags, rating: 5, wouldRecommend: true })]);
  expect(p.crowdPreferenceSignal).toBe(expected);
  negativeTags.forEach(tag => expect(p.evidence.negativeTagCounts[tag]).toBe(1));
});
test('questionnaire crowd is weak evidence; positive acceptance is weak; poor ratings do not invert', () => {
  expect(build([walk({ preferences: { crowdPreference: 'low' } })]).crowdPreferenceSignal).toBe(-1);
  expect(build(undefined, [feedback({ rating: 4, wouldRecommend: true, observedCrowdLevel: 'high' })]).crowdPreferenceSignal).toBe(0.5);
  expect(build(undefined, [feedback({ rating: 1, wouldRecommend: true, observedCrowdLevel: 'high' })]).crowdPreferenceSignal).toBe(0);
  expect(build(undefined, [feedback({ rating: 5, wouldRecommend: false, observedCrowdLevel: 'high' })]).crowdPreferenceSignal).toBe(0);
  expect(build(undefined, [feedback({ observedCrowdLevel: 'bad', negativeTags: ['too_crowded'] })]).crowdPreferenceSignal).toBe(0);
});
test('all explicit tags count once per walk, sorted by count then allowlist; contradictions retain counts', () => {
  const p = build([walk(), walk({ walkId: 'walk-2' })], [feedback({ positiveTags: [...POSITIVE_TAGS, 'quiet', 'unknown'], negativeTags: NEGATIVE_TAGS }),
    feedback({ walkId: 'walk-2', positiveTags: ['quiet'], negativeTags: ['pois_not_interesting'] })]);
  expect(p.likedTags).toEqual(['quiet', 'nice_view', 'comfortable_route', 'duration_good']);
  expect(p.dislikedTags).toEqual(['pois_not_interesting', ...NEGATIVE_TAGS.slice(0, -1)]);
  expect(p.evidence.positiveTagCounts.quiet).toBe(2);
  expect(validateProfile(p)).toBe(p);
});
test('comments/provider payload, foreign/unselected feedback do not affect output or fingerprint', () => {
  const baseline = build(undefined, [feedback()]);
  expect(build([walk({ polyline: ['secret'], gps: [1], providerMeta: {} })], [feedback({ comment: 'secret', route: {} }),
    feedback({ ownerKey: 'other', positiveTags: ['quiet'] }), feedback({ walkId: 'unknown' })])).toEqual(baseline);
  expect(JSON.stringify(baseline)).not.toMatch(/ownerKey|comment|polyline|gps|providerMeta/);
});
test('bounded latest history with walkId tie-break; duplicates and input order cannot change output', () => {
  const walks = Array.from({ length: 25 }, (_, i) => walk({ walkId: `walk-${String(i).padStart(2, '0')}`, endTime: new Date(Date.parse(time) + i * 1000).toISOString() }));
  const p = build(walks);
  expect(p.evidenceWalkCount).toBe(20);
  expect(p.evidence.environment.park.firstChoiceCount).toBe(20);
  expect(build([...walks].reverse())).toEqual(p);
  expect(build([...walks, ...walks])).toEqual(p);
  const tied = walks.map(w => ({ ...w, endTime: time }));
  expect(build(tied)).toEqual(build(tied.slice(0, 20)));
  const records = [feedback({ positiveTags: ['quiet'] }), feedback({ walkId: 'walk-2', negativeTags: ['too_quiet'] })];
  expect(build([walk(), walk({ walkId: 'walk-2' })], records)).toEqual(build([walk({ walkId: 'walk-2' }), walk()], records.reverse()));
  expect(SCORING.rankScores).toEqual([1, 0.67, 0.33, 0]);
});
module.exports = {};
