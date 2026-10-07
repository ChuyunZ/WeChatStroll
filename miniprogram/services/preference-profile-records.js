const { callCloudFunction } = require('./cloud-function-client');
const { validateProfile } = require('../utils/preference-profile-schema');
async function request(action) {
  const result = await callCloudFunction('preferenceProfileStore', { action }, {
    fallbackCode: 'PREFERENCE_PROFILE_STORE_FAILED',
    fallbackMessage: 'Preference profile storage is temporarily unavailable.'
  });
  return result.profile === null ? null : validateProfile(result.profile);
}
module.exports = { getProfile: () => request('getProfile'), refreshProfile: () => request('refreshProfile') };
