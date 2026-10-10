const { profileInsights } = require('../miniprogram/utils/profile-insights');
const { historyCard, durationText } = require('../miniprogram/utils/profile-history');
const { preferenceProfile, historyItem } = require('./helpers/profile-fixture');
test('null profile remains empty; one walk keeps weak wording and questionnaire evidence without feedback', () => {
  expect(profileInsights(null)).toBeNull();
  const model = profileInsights(preferenceProfile(1));
  expect(model.environment).toContain('没有明显');
  expect(model.duration).toContain('仅有 1 次');
  expect(model.crowd).toContain('没有明确');
  expect(model.feedbackHint).toContain('问卷选择也会');
  expect(model.positiveTags).toEqual([]);
  expect(model.evidenceText).toBe('1 次有效散步 · 0 次评价');
});
test.each([1, 2, 3])('environment minimum sample threshold %i', n => {
  const model = profileInsights(preferenceProfile(n));
  expect(model.environment.includes('经常优先选择公园')).toBe(n >= 3);
  if (n >= 3) expect(model.environmentEvidence).toBe('3 次排在第一位，3 次排在前两位。');
});
test.each([0.1499, 0.15, 0.1501])('environment margin boundary %s', gap => {
  const p = preferenceProfile();
  p.environmentWeights = { park: 0.8, water: 0.8 - gap, street: 0.2, shoppingStreet: 0.1 };
  expect(profileInsights(p).environment.includes('经常')).toBe(gap >= 0.15);
});
test.each([1, 2])('at least two first choices are needed: %i', firstChoiceCount => {
  const p = preferenceProfile();
  p.evidence.environment.park.firstChoiceCount = firstChoiceCount;
  expect(profileInsights(p).environment.includes('经常')).toBe(firstChoiceCount >= 2);
});
test('tied first-choice counts or tied weights do not imply a preference', () => {
  const p = preferenceProfile(4);
  p.evidence.environment.park.firstChoiceCount = 2;
  p.evidence.environment.water.firstChoiceCount = 2;
  expect(profileInsights(p).environment).toContain('没有明显');
  p.evidence.environment.water.firstChoiceCount = 0;
  p.environmentWeights.water = p.environmentWeights.park;
  expect(profileInsights(p).environment).toContain('没有明显');
});
test('sparse rankings do not turn a few first choices into a frequent preference over a large window', () => {
  const p = preferenceProfile(20);
  p.evidence.environment.park.firstChoiceCount = 9;
  expect(profileInsights(p).environment).toContain('没有明显');
  p.evidence.environment.park.firstChoiceCount = 10;
  expect(profileInsights(p).environment).toContain('经常优先选择');
});
test.each([
  ['公园', '公园'], ['水边', '水边'], ['街道', '街道'], ['商街', '商街']
])('environment label %s describes questionnaire intent', (first, label) => {
  const model = profileInsights(preferenceProfile(3, { walkChanges: { preferences: {
    environmentPreferences: [first, ...['公园', '水边', '街道', '商街'].filter(x => x !== first)]
  } } }));
  expect(model.environment).toBe(`你在问卷中经常优先选择${label}。`);
});
test('duration uses the server-adjusted preference and displays explicit feedback counts', () => {
  const p = preferenceProfile(3, { feedback: [{ negativeTags: ['duration_too_long'] }] });
  expect(p.preferredDurationMinutes).toBe(25);
  const model = profileInsights(p);
  expect(model.duration).toContain('约为 25 分钟');
  expect(model.durationEvidence).toContain('“时间太长” 1 次');
  const empty = preferenceProfile(3, { walkChanges: { requestedDurationMinutes: null, preferences: {} } });
  expect(profileInsights(empty).duration).toContain('还没有足够');
});
test.each([-1, -0.35, -0.3499, 0, 0.3499, 0.35, 1, null])('crowd signal threshold and direction: %s', signal => {
  const negative = signal !== null && signal < 0;
  const p = preferenceProfile(3, { feedback: [0, 1].map(() => negative ? { positiveTags: ['quiet'] } : { negativeTags: ['too_quiet'] }) });
  p.crowdPreferenceSignal = signal;
  const message = profileInsights(p).crowd;
  if (signal !== null && signal <= -0.35) expect(message).toContain('人少一些');
  else if (signal !== null && signal >= 0.35) expect(message).toContain('热闹一些');
  else expect(message).toContain('没有明确');
});
test('crowd needs repeated explicit evidence, enough walks and no opposing feedback', () => {
  expect(profileInsights(preferenceProfile(20)).crowd).toContain('没有明确');
  expect(profileInsights(preferenceProfile(3, { feedback: [{ positiveTags: ['quiet'] }] })).crowd).toContain('没有明确');
  expect(profileInsights(preferenceProfile(2, { feedback: [{ positiveTags: ['quiet'] }, { positiveTags: ['quiet'] }] })).crowd).toContain('没有明确');
  const conflict = preferenceProfile(3, { feedback: [{ positiveTags: ['quiet'] }, { positiveTags: ['quiet'] }, { negativeTags: ['too_quiet'] }] });
  expect(profileInsights(conflict).crowd).toContain('没有明确');
  expect(profileInsights(conflict).crowdEvidence).toContain('不同方向');
  // One feedback may contain both tags; two aggregate counts do not prove two independent observations.
  expect(profileInsights(preferenceProfile(3, { feedback: [{ positiveTags: ['quiet'], negativeTags: ['too_crowded'] }] })).crowd).toContain('没有明确');
});
test('crowd must agree with the explicit feedback direction', () => {
  const p = preferenceProfile(3, { feedback: [{ positiveTags: ['quiet'] }, { positiveTags: ['quiet'] }] });
  p.crowdPreferenceSignal = 1;
  expect(profileInsights(p).crowd).toContain('没有明确');
});
test('feedback tags retain exact counts, conservative single mentions and Chinese mappings', () => {
  const p = preferenceProfile(3, { feedback: [
    { positiveTags: ['nice_view', 'quiet', 'comfortable_route', 'duration_good'], negativeTags: ['too_crowded', 'too_quiet', 'distance_too_long', 'distance_too_short', 'duration_too_long', 'duration_too_short', 'route_hard_to_walk', 'pois_not_interesting'] },
    { positiveTags: ['nice_view'] }
  ] });
  const model = profileInsights(p);
  expect(model.positiveTags[0].text).toBe('风景不错 · 提到 2 次');
  expect(model.positiveTags[1].text).toBe('安静 · 曾提到 1 次');
  expect(model.negativeTags.map(t => t.label)).toEqual(['太拥挤', '太安静', '距离太长', '距离太短', '时间太长', '时间太短', '不太好走', '途经地点没意思']);
  expect(JSON.stringify([...model.positiveTags, ...model.negativeTags])).not.toContain('经常');
});
test('window counts never represent lifetime totals and output contains only presentation fields', () => {
  const p = preferenceProfile(31);
  const before = JSON.stringify(p);
  const model = profileInsights(p);
  expect(model.evidenceText).toBe('20 次有效散步 · 0 次评价');
  expect(model.scopeText).toContain('不代表全部历史');
  expect(JSON.stringify(model)).not.toMatch(/ownerKey|OpenID|fingerprint|newestWalk|路线预测|最适合|去过最多|医学/);
  expect(JSON.stringify(p)).toBe(before);
  expect(() => profileInsights({ ...p, ownerKey: 'private' })).toThrow();
});
test.each([[0, '0 秒'], [59, '59 秒'], [60, '1 分钟'], [61, '1 分钟 1 秒'], [3661, '1 小时 1 分钟 1 秒']])('actual duration %i has no rounding fabrication', (seconds, expected) => {
  expect(durationText(seconds)).toBe(expected);
});
test.each([['loop', '环线散步'], ['out_and_back', '往返散步'], ['point_to_point', '单程散步']])('history renders metadata only: %s', (routeType, text) => {
  const item = historyItem(1, { routeType });
  const model = historyCard(item);
  const local = new Date(item.startTime);
  expect(model.dateText).toContain(`${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日`);
  expect(model).toMatchObject({ routeText: text, plannedText: '计划 45 分钟', actualText: '实际经过 30 分钟', statusText: '提前结束', ratingText: '评分 4 / 5' });
  expect(historyCard(historyItem(0))).toMatchObject({ statusText: '已完成', ratingText: '尚未评价' });
  expect(JSON.stringify(model)).not.toMatch(/GPS|公里|ownerKey|OpenID|polyline|trajectory/);
});
