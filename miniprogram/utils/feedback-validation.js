// Kept identical to the Mini Program validator: each cloud function deploys independently.
const POSITIVE_TAGS = ['nice_view', 'quiet', 'comfortable_route', 'duration_good'];
const NEGATIVE_TAGS = ['too_crowded', 'too_quiet', 'distance_too_long', 'distance_too_short',
  'duration_too_long', 'duration_too_short', 'route_hard_to_walk', 'pois_not_interesting'];
function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
}
function fields(input) {
  if (!input || !validId(input.walkId) || !Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5 ||
      !['low', 'medium', 'high'].includes(input.observedCrowdLevel) || typeof input.wouldRecommend !== 'boolean') {
    throw new Error('Invalid feedback fields.');
  }
  for (const [key, allowed] of [['positiveTags', POSITIVE_TAGS], ['negativeTags', NEGATIVE_TAGS]]) {
    if (!Array.isArray(input[key]) || input[key].length > allowed.length ||
        new Set(input[key]).size !== input[key].length || !input[key].every(tag => allowed.includes(tag))) {
      throw new Error('Invalid feedback tags.');
    }
  }
  if (input.comment != null && (typeof input.comment !== 'string' || input.comment.length > 500)) {
    throw new Error('Invalid feedback comment.');
  }
  return { walkId: input.walkId, rating: input.rating, observedCrowdLevel: input.observedCrowdLevel,
    wouldRecommend: input.wouldRecommend, positiveTags: [...input.positiveTags], negativeTags: [...input.negativeTags],
    comment: input.comment == null ? null : input.comment.trim() || null };
}
module.exports = { POSITIVE_TAGS, NEGATIVE_TAGS, validId, fields };
