const { validateProfile, ENVIRONMENTS } = require('./preference-profile-schema');
const ENVIRONMENT_LABELS = { park: '公园', water: '水边', street: '街道', shoppingStreet: '商街' };
const TAG_LABELS = {
  nice_view: '风景不错', quiet: '安静', comfortable_route: '路线舒服', duration_good: '时长合适',
  too_crowded: '太拥挤', too_quiet: '太安静', distance_too_long: '距离太长', distance_too_short: '距离太短',
  duration_too_long: '时间太长', duration_too_short: '时间太短', route_hard_to_walk: '不太好走', pois_not_interesting: '途经地点没意思'
};
// Conservative presentation rules, not statistical significance or new AI inference.
const MIN_WALKS = 3;
const MIN_FIRST_CHOICES = 2;
const ENVIRONMENT_MARGIN = 0.15;
const CROWD_THRESHOLD = 0.35;
function feedbackTags(tags, counts) {
  return tags.map(key => ({ key, label: TAG_LABELS[key], count: counts[key],
    text: `${TAG_LABELS[key]} · ${counts[key] === 1 ? '曾提到 1 次' : `提到 ${counts[key]} 次`}` }));
}
function profileInsights(profile) {
  if (profile === null) return null;
  const p = validateProfile(profile);
  const ranked = [...ENVIRONMENTS].sort((a, b) => p.environmentWeights[b] - p.environmentWeights[a]);
  const first = ranked[0], runnerUp = ranked[1];
  const firstCount = p.evidence.environment[first].firstChoiceCount;
  const clearEnvironment = p.evidenceWalkCount >= MIN_WALKS && firstCount >= MIN_FIRST_CHOICES &&
    firstCount * 2 >= p.evidenceWalkCount &&
    firstCount > Math.max(...ranked.slice(1).map(key => p.evidence.environment[key].firstChoiceCount)) &&
    Math.round(p.environmentWeights[first] * 10000) - Math.round(p.environmentWeights[runnerUp] * 10000) >= ENVIRONMENT_MARGIN * 10000;
  const environment = clearEnvironment
    ? `你在问卷中经常优先选择${ENVIRONMENT_LABELS[first]}。`
    : '目前还没有明显的环境偏好。';
  const environmentEvidence = clearEnvironment
    ? `${firstCount} 次排在第一位，${p.evidence.environment[first].topTwoCount} 次排在前两位。`
    : '多一些问卷选择，才能更清楚地看出倾向。';
  const d = p.evidence.duration;
  const durationEvidence = [
    d.durationGoodCount ? `“时长合适” ${d.durationGoodCount} 次` : '',
    d.tooLongCount ? `“时间太长” ${d.tooLongCount} 次` : '',
    d.tooShortCount ? `“时间太短” ${d.tooShortCount} 次` : ''
  ].filter(Boolean).join('，');
  const duration = p.preferredDurationMinutes === null ? '还没有足够的时长选择记录。'
    : p.evidenceWalkCount < MIN_WALKS
      ? `目前仅有 ${p.evidenceWalkCount} 次散步样本，时长倾向暂约 ${p.preferredDurationMinutes} 分钟。`
      : `根据过去的散步记录，你的时长倾向约为 ${p.preferredDurationMinutes} 分钟。`;
  const c = p.evidence.crowd;
  const negativeEvidence = Math.max(c.tooCrowdedCount, c.quietPositiveCount); // Overlap is unknown; never sum them.
  const contradictory = c.tooQuietCount > 0 && negativeEvidence > 0;
  let crowd = '目前还没有明确的人流倾向。';
  if (p.evidenceWalkCount >= MIN_WALKS && !contradictory && p.crowdPreferenceSignal !== null) {
    if (p.crowdPreferenceSignal <= -CROWD_THRESHOLD && negativeEvidence >= 2) crowd = '过去的选择和反馈显示，你可能更倾向人少一些的环境。';
    if (p.crowdPreferenceSignal >= CROWD_THRESHOLD && c.tooQuietCount >= 2) crowd = '过去的选择和反馈显示，你可能更倾向热闹一些的环境。';
  }
  return {
    environment, environmentEvidence, duration,
    durationEvidence: durationEvidence ? `曾给出的反馈：${durationEvidence}。时长仅为历史倾向。`
      : p.preferredDurationMinutes === null ? '继续记录计划时长，会让这里更丰富。' : '来源于历史问卷选择；尚无明确的时长反馈。',
    crowd, crowdEvidence: contradictory ? '反馈中同时出现不同方向的体验，暂不作明确判断。' : '仅表示个人倾向，不代表当前路线的实际人流。',
    positiveTags: feedbackTags(p.likedTags, p.evidence.positiveTagCounts),
    negativeTags: feedbackTags(p.dislikedTags, p.evidence.negativeTagCounts),
    feedbackHint: p.feedbackCount === 0 ? '还没有评价，问卷选择也会帮助我们了解你。' : '以下体验来自你的明确评价。',
    evidenceText: `${p.evidenceWalkCount} 次有效散步 · ${p.feedbackCount} 次评价`,
    scopeText: '基于最近最多 20 次有效散步及对应反馈，不代表全部历史记录。'
  };
}
module.exports = { profileInsights };
