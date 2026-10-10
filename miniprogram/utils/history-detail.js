const { historyItem, ITEM_KEYS } = require('./history-schema');
const { historyCard, durationText } = require('./profile-history');
const { fields } = require('./feedback-validation');
const TAG_LABELS = {
  nice_view: '风景不错', quiet: '很安静', comfortable_route: '路线舒服', duration_good: '时长刚好',
  too_crowded: '太拥挤', too_quiet: '太安静', distance_too_long: '距离太长', distance_too_short: '距离太短',
  duration_too_long: '时间太长', duration_too_short: '时间太短', route_hard_to_walk: '不太好走', pois_not_interesting: '途经地点没意思'
};
function walkView(walk, walkId) {
  if (!walk || walk.walkId !== walkId || walk.schemaVersion !== 1 || walk.completionStatus !== walk.status) throw new Error('Invalid walk.');
  const item = historyItem(Object.fromEntries(ITEM_KEYS.map(key => [key, key === 'rating' ? null : walk[key]])));
  return { ...historyCard(item), elapsedText: durationText(item.actualDurationSeconds),
    trajectoryEnabled: item.trajectoryEnabled, lateCleanup: item.trajectoryEndTimeMs > Date.parse(item.endTime),
    recordedPartial: item.trajectoryPartial };
}
function feedbackView(record, walkId) {
  if (record === null) return null;
  if (!record || record.walkId !== walkId) throw new Error('Invalid feedback.');
  const value = fields(record);
  const labels = tags => tags.map(tag => ({ key: tag, text: TAG_LABELS[tag] }));
  return { ratingText: `${value.rating} / 5`, crowdText: { low: '人少', medium: '适中', high: '人多' }[value.observedCrowdLevel],
    recommendText: value.wouldRecommend ? '会' : '不会', positiveTags: labels(value.positiveTags),
    negativeTags: labels(value.negativeTags), comment: value.comment };
}
module.exports = { walkView, feedbackView };
