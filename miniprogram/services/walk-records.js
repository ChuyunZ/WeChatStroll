const { callCloudFunction } = require('./cloud-function-client');
const { createCodedError } = require('../utils/errors');
const { historyRequest, historyResponse } = require('../utils/history-schema');

const MIN_WALKING_DURATION_MINUTES = 15;
const MAX_WALKING_DURATION_MINUTES = 120;

// Deliberate allowlist: never send a Route Data Contract or location object.
function preferencesSnapshot(value = {}) {
  return { durationMinutes: value.durationMinutes, routeType: value.routeType,
    crowdPreference: value.crowdPreference,
    environmentPreferences: Array.isArray(value.environmentPreferences) ? [...value.environmentPreferences] : [] };
}
function isValidPreferences(value) {
  return Boolean(value && Number.isInteger(value.durationMinutes) &&
    value.durationMinutes >= MIN_WALKING_DURATION_MINUTES &&
    value.durationMinutes <= MAX_WALKING_DURATION_MINUTES &&
    ['loop', 'out_and_back', 'point_to_point'].includes(value.routeType) &&
    ['low', 'medium', 'high'].includes(value.crowdPreference) &&
    Array.isArray(value.environmentPreferences) && value.environmentPreferences.length <= 10 &&
    value.environmentPreferences.every(item => ['公园', '水边', '街道', '商街'].includes(item)));
}
function normalizeWalk(walk) {
  if (!walk || typeof walk.walkId !== 'string' || !walk.walkId ||
      typeof walk.routeId !== 'string' || !walk.routeId || walk.schemaVersion !== 1 ||
      !['active', 'completed', 'ended_early', 'abandoned'].includes(walk.status) ||
      !(Date.parse(walk.startTime) > 0) || typeof walk.trajectoryEnabled !== 'boolean' ||
      !isValidPreferences(walk.preferences) || typeof walk.trajectoryPartial !== 'boolean' ||
      (walk.status === 'active' && (walk.endTime !== null || walk.completionStatus !== null ||
        walk.actualDurationSeconds !== 0 || walk.trajectoryEndTimeMs !== null)) ||
      (walk.status === 'abandoned' && (walk.completionStatus !== 'abandoned' ||
        walk.endTime !== null || walk.actualDurationSeconds !== null || walk.trajectoryEndTimeMs !== null)) ||
      (['completed', 'ended_early'].includes(walk.status) && (walk.completionStatus !== walk.status ||
        !Number.isFinite(Date.parse(walk.endTime)) || Date.parse(walk.endTime) < Date.parse(walk.startTime) ||
        !Number.isInteger(walk.actualDurationSeconds) || walk.actualDurationSeconds < 0 ||
        walk.actualDurationSeconds !== Math.floor((Date.parse(walk.endTime) - Date.parse(walk.startTime)) / 1000) ||
        !Number.isSafeInteger(walk.trajectoryEndTimeMs) || walk.trajectoryEndTimeMs < Date.parse(walk.endTime)))) {
    throw new Error('Invalid walk store response.');
  }
  return walk;
}
async function request(action, fields = {}, nullable = false) {
  const result = await callCloudFunction('walkStore', { action, ...fields }, {
    fallbackCode: 'WALK_STORE_FAILED', fallbackMessage: 'Unable to save or restore walk.'
  });
  if (nullable && result.walk === null) return null;
  const walk = normalizeWalk(result.walk);
  if (fields.walkId && fields.walkId !== walk.walkId) throw new Error('Mismatched walk response.');
  if (['startWalk', 'getActiveWalk'].includes(action) && walk.status !== 'active') throw new Error('Invalid active walk.');
  if (action === 'completeWalk' && walk.status !== fields.completionStatus) {
    if (walk.status === 'abandoned') {
      throw createCodedError('WALK_ABANDONED', 'Walk was automatically closed after remaining active too long.');
    }
    throw new Error('Invalid completion response.');
  }
  if (action === 'updateTrajectoryMetadata' &&
      (!['completed', 'ended_early'].includes(walk.status) || walk.trajectoryEnabled !== true ||
       walk.trajectoryEndTimeMs < fields.trajectoryEndTimeMs ||
       (fields.trajectoryPartial === false && walk.trajectoryPartial !== false))) {
    throw new Error('Invalid trajectory metadata response.');
  }
  return walk;
}
module.exports = {
  async listHistory(options) {
    const input = historyRequest(options);
    const result = await callCloudFunction('walkStore', { action: 'listHistory', ...input }, {
      fallbackCode: 'WALK_STORE_FAILED', fallbackMessage: 'Unable to load walk history.'
    });
    return historyResponse(result, input);
  },
  isValidPreferences,
  preferencesSnapshot,
  async startWalk({ routeId, preferences, trajectoryEnabled }) {
    const snapshot = preferencesSnapshot(preferences);
    if (!isValidPreferences(snapshot) || typeof trajectoryEnabled !== 'boolean') {
      throw new Error('Invalid walk questionnaire or consent.');
    }
    return request('startWalk', { routeId, preferences: snapshot, trajectoryEnabled });
  },
  getActiveWalk: () => request('getActiveWalk', {}, true),
  getWalk: walkId => request('getWalk', { walkId }),
  completeWalk: ({ walkId, completionStatus, endTimeMs, trajectoryPartial }) => request('completeWalk', {
    walkId, completionStatus, endTimeMs, trajectoryPartial
  }),
  updateTrajectoryMetadata: ({ walkId, trajectoryPartial, trajectoryEndTimeMs }) =>
    request('updateTrajectoryMetadata', { walkId, trajectoryPartial, trajectoryEndTimeMs })
};
