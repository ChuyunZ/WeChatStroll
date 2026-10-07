// Mirrored in miniprogram/utils/preference-profile-schema.js for independent deployment.
const PROFILE_HISTORY_LIMIT = 20;
const ENVIRONMENTS = ['park', 'water', 'street', 'shoppingStreet'];
const POSITIVE_TAGS = ['nice_view', 'quiet', 'comfortable_route', 'duration_good'];
const NEGATIVE_TAGS = ['too_crowded', 'too_quiet', 'distance_too_long', 'distance_too_short',
  'duration_too_long', 'duration_too_short', 'route_hard_to_walk', 'pois_not_interesting'];
const PUBLIC_FIELDS = ['schemaVersion', 'environmentWeights', 'preferredDurationMinutes',
  'crowdPreferenceSignal', 'likedTags', 'dislikedTags', 'evidenceWalkCount', 'completedWalkCount',
  'endedEarlyWalkCount', 'feedbackCount', 'evidence', 'source', 'lastUpdatedAt'];
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function orderedTags(counts, allowed) {
  return allowed.filter(tag => counts[tag] > 0).sort((a, b) => counts[b] - counts[a] || allowed.indexOf(a) - allowed.indexOf(b));
}
function validateProfile(p) {
  const count = value => Number.isInteger(value) && bounded(value, 0, p.evidenceWalkCount);
  const counts = (value, keys) => exact(value, keys) && keys.every(key => count(value[key]));
  const tags = (value, allowed, values) => Array.isArray(value) &&
    JSON.stringify(value) === JSON.stringify(orderedTags(values, allowed));
  if (!exact(p, PUBLIC_FIELDS) || p.schemaVersion !== 1 ||
      !Number.isInteger(p.evidenceWalkCount) || !bounded(p.evidenceWalkCount, 1, PROFILE_HISTORY_LIMIT) ||
      !count(p.completedWalkCount) || !count(p.endedEarlyWalkCount) || !count(p.feedbackCount) ||
      p.completedWalkCount + p.endedEarlyWalkCount !== p.evidenceWalkCount ||
      !exact(p.environmentWeights, ENVIRONMENTS) || !ENVIRONMENTS.every(key => bounded(p.environmentWeights[key], 0, 1)) ||
      !(p.preferredDurationMinutes === null || bounded(p.preferredDurationMinutes, 15, 120) && p.preferredDurationMinutes % 5 === 0) ||
      !(p.crowdPreferenceSignal === null || bounded(p.crowdPreferenceSignal, -1, 1)) || !validTime(p.lastUpdatedAt)) {
    throw new Error('Invalid preference profile response.');
  }
  const e = p.evidence;
  if (!exact(e, ['environment', 'duration', 'crowd', 'positiveTagCounts', 'negativeTagCounts']) ||
      !exact(e.environment, ENVIRONMENTS) || !ENVIRONMENTS.every(key =>
        counts(e.environment[key], ['firstChoiceCount', 'topTwoCount']) &&
        e.environment[key].firstChoiceCount <= e.environment[key].topTwoCount) ||
      !counts(e.duration, ['durationGoodCount', 'tooLongCount', 'tooShortCount']) ||
      !counts(e.crowd, ['tooCrowdedCount', 'tooQuietCount', 'quietPositiveCount']) ||
      !counts(e.positiveTagCounts, POSITIVE_TAGS) || !counts(e.negativeTagCounts, NEGATIVE_TAGS) ||
      ![...Object.values(e.positiveTagCounts), ...Object.values(e.negativeTagCounts)].every(value => value <= p.feedbackCount) ||
      !tags(p.likedTags, POSITIVE_TAGS, e.positiveTagCounts) || !tags(p.dislikedTags, NEGATIVE_TAGS, e.negativeTagCounts) ||
      e.duration.durationGoodCount !== e.positiveTagCounts.duration_good ||
      e.duration.tooLongCount !== e.negativeTagCounts.duration_too_long ||
      e.duration.tooShortCount !== e.negativeTagCounts.duration_too_short ||
      e.crowd.tooCrowdedCount !== e.negativeTagCounts.too_crowded ||
      e.crowd.tooQuietCount !== e.negativeTagCounts.too_quiet ||
      e.crowd.quietPositiveCount !== e.positiveTagCounts.quiet ||
      !exact(p.source, ['historyLimit', 'newestWalkEndTime', 'latestFeedbackCreatedAt', 'fingerprint']) ||
      p.source.historyLimit !== PROFILE_HISTORY_LIMIT || !validTime(p.source.newestWalkEndTime) ||
      !(p.source.latestFeedbackCreatedAt === null && p.feedbackCount === 0 ||
        p.feedbackCount > 0 && validTime(p.source.latestFeedbackCreatedAt)) ||
      typeof p.source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(p.source.fingerprint)) {
    throw new Error('Invalid preference profile response.');
  }
  return p;
}
module.exports = { PROFILE_HISTORY_LIMIT, ENVIRONMENTS, POSITIVE_TAGS, NEGATIVE_TAGS,
  PUBLIC_FIELDS, validTime, validId, orderedTags, validateProfile };
