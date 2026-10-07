const crypto = require('crypto');
const { PROFILE_HISTORY_LIMIT, ENVIRONMENTS, POSITIVE_TAGS, NEGATIVE_TAGS,
  validTime, validId, orderedTags } = require('./profile-schema');
const SCORING = Object.freeze({ rankScores: [1, 0.67, 0.33, 0], baseWeight: 1,
  feedbackWeight: 2, durationStep: 10, minDuration: 15, maxDuration: 120,
  durationRounding: 5, precision: 4, acceptanceRating: 4 });
const LABELS = ['公园', '水边', '街道', '商街'];
const CROWD = { low: -1, medium: 0, high: 1 };
const crowd = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(CROWD, value) ? CROWD[value] : null;
const round = value => Number(value.toFixed(SCORING.precision));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const duration = value => Number.isFinite(value) && value >= SCORING.minDuration && value <= SCORING.maxDuration ? value : null;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const zeroes = keys => Object.fromEntries(keys.map(key => [key, 0]));
function ranking(value) {
  return Array.isArray(value) && value.length === LABELS.length && new Set(value).size === LABELS.length &&
    value.every(label => LABELS.includes(label)) ? value.map(label => ENVIRONMENTS[LABELS.indexOf(label)]) : null;
}
function canonicalWalks(walks, ownerKey) {
  const rows = (Array.isArray(walks) ? walks : []).filter(w => w && w.ownerKey === ownerKey &&
    validId(w.walkId) && ['completed', 'ended_early'].includes(w.status) && validTime(w.endTime)).map(w => ({
    walkId: w.walkId, status: w.status, endTime: new Date(w.endTime).toISOString(),
    requested: duration(w.requestedDurationMinutes) ?? duration((w.preferences || {}).durationMinutes),
    actual: Number.isFinite(w.actualDurationSeconds) && w.actualDurationSeconds >= 0 ? w.actualDurationSeconds / 60 : null,
    environment: ranking((w.preferences || {}).environmentPreferences), crowd: crowd((w.preferences || {}).crowdPreference)
  }));
  rows.sort((a, b) => compareText(b.endTime, a.endTime) || compareText(a.walkId, b.walkId) ||
    compareText(JSON.stringify(a), JSON.stringify(b)));
  const seen = new Set();
  return rows.filter(w => !seen.has(w.walkId) && seen.add(w.walkId)).slice(0, PROFILE_HISTORY_LIMIT);
}
function canonicalFeedback(records, ownerKey, walks) {
  const ids = new Set(walks.map(w => w.walkId));
  const rows = (Array.isArray(records) ? records : []).filter(f => f && f.ownerKey === ownerKey &&
    ids.has(f.walkId) && validTime(f.createdAt)).map(f => ({
    walkId: f.walkId, createdAt: new Date(f.createdAt).toISOString(),
    rating: Number.isInteger(f.rating) && f.rating >= 1 && f.rating <= 5 ? f.rating : null,
    wouldRecommend: f.wouldRecommend === true, observed: crowd(f.observedCrowdLevel),
    positiveTags: POSITIVE_TAGS.filter(tag => Array.isArray(f.positiveTags) && f.positiveTags.includes(tag)),
    negativeTags: NEGATIVE_TAGS.filter(tag => Array.isArray(f.negativeTags) && f.negativeTags.includes(tag))
  }));
  rows.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const result = new Map();
  for (const row of rows) if (!result.has(row.walkId)) result.set(row.walkId, row);
  return result;
}
function buildProfile({ walks = [], feedback = [], ownerKey, lastUpdatedAt }) {
  if (typeof ownerKey !== 'string' || !ownerKey) throw new Error('Missing owner.');
  const history = canonicalWalks(walks, ownerKey);
  if (!history.length) return null;
  if (!validTime(lastUpdatedAt)) throw new Error('Missing profile timestamp.');
  const responses = canonicalFeedback(feedback, ownerKey, history);
  const environmentWeights = zeroes(ENVIRONMENTS);
  const environment = Object.fromEntries(ENVIRONMENTS.map(key => [key, { firstChoiceCount: 0, topTwoCount: 0 }]));
  const positiveTagCounts = zeroes(POSITIVE_TAGS), negativeTagCounts = zeroes(NEGATIVE_TAGS);
  let rankedCount = 0, durationSum = 0, durationWeight = 0, crowdSum = 0, crowdWeight = 0;
  const addDuration = (target, weight) => {
    durationSum += clamp(target, SCORING.minDuration, SCORING.maxDuration) * weight;
    durationWeight += weight;
  };
  const addCrowd = (target, weight) => { crowdSum += clamp(target, -1, 1) * weight; crowdWeight += weight; };
  for (const w of history) {
    if (w.environment) {
      rankedCount++;
      w.environment.forEach((key, rank) => {
        environmentWeights[key] += SCORING.rankScores[rank];
        if (rank === 0) environment[key].firstChoiceCount++;
        if (rank < 2) environment[key].topTwoCount++;
      });
    }
    // Requested intent stays weak even for ended_early; actual time alone is not satisfaction.
    if (w.requested !== null) addDuration(w.requested, SCORING.baseWeight);
    if (w.crowd !== null) addCrowd(w.crowd, SCORING.baseWeight);
    const f = responses.get(w.walkId);
    if (!f) continue;
    for (const tag of f.positiveTags) positiveTagCounts[tag]++;
    for (const tag of f.negativeTags) negativeTagCounts[tag]++;
    const tags = [...f.positiveTags, ...f.negativeTags];
    const durationTags = ['duration_good', 'duration_too_long', 'duration_too_short'].filter(tag => tags.includes(tag));
    if (durationTags.length === 1 && w.actual !== null) {
      if (durationTags[0] === 'duration_good') addDuration(w.actual, SCORING.feedbackWeight);
      else if (w.requested !== null) addDuration(durationTags[0] === 'duration_too_long'
        ? Math.min(w.requested, w.actual) - SCORING.durationStep
        : Math.max(w.requested, w.actual) + SCORING.durationStep, SCORING.feedbackWeight);
    }
    const tooCrowded = tags.includes('too_crowded'), tooQuiet = tags.includes('too_quiet'), quiet = tags.includes('quiet');
    // quiet + too_crowded agree; too_quiet conflicts with either quieter signal.
    if (tooQuiet && (tooCrowded || quiet)) continue;
    if (tooCrowded || tooQuiet) {
      if (f.observed !== null) addCrowd(f.observed + (tooCrowded ? -1 : 1), SCORING.feedbackWeight);
    } else if (quiet) addCrowd(-1, SCORING.feedbackWeight);
    else if (f.rating >= SCORING.acceptanceRating && f.wouldRecommend && f.observed !== null) addCrowd(f.observed, SCORING.baseWeight);
  }
  for (const key of ENVIRONMENTS) environmentWeights[key] = rankedCount ? round(environmentWeights[key] / rankedCount) : 0;
  const canonicalSource = history.map(w => ({ walk: w, feedback: responses.get(w.walkId) || null }));
  return {
    schemaVersion: 1, environmentWeights,
    preferredDurationMinutes: durationWeight ? Math.round(durationSum / durationWeight / SCORING.durationRounding) * SCORING.durationRounding : null,
    crowdPreferenceSignal: crowdWeight ? round(crowdSum / crowdWeight) : null,
    likedTags: orderedTags(positiveTagCounts, POSITIVE_TAGS), dislikedTags: orderedTags(negativeTagCounts, NEGATIVE_TAGS),
    evidenceWalkCount: history.length, completedWalkCount: history.filter(w => w.status === 'completed').length,
    endedEarlyWalkCount: history.filter(w => w.status === 'ended_early').length, feedbackCount: responses.size,
    evidence: { environment,
      duration: { durationGoodCount: positiveTagCounts.duration_good, tooLongCount: negativeTagCounts.duration_too_long, tooShortCount: negativeTagCounts.duration_too_short },
      crowd: { tooCrowdedCount: negativeTagCounts.too_crowded, tooQuietCount: negativeTagCounts.too_quiet, quietPositiveCount: positiveTagCounts.quiet },
      positiveTagCounts, negativeTagCounts },
    source: { historyLimit: PROFILE_HISTORY_LIMIT, newestWalkEndTime: history[0].endTime,
      latestFeedbackCreatedAt: [...responses.values()].map(f => f.createdAt).sort().pop() || null,
      fingerprint: crypto.createHash('sha256').update(JSON.stringify(canonicalSource)).digest('hex') },
    lastUpdatedAt: new Date(lastUpdatedAt).toISOString()
  };
}
module.exports = { buildProfile, canonicalWalks, SCORING };
