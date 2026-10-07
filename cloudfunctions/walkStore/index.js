const cloud = require('wx-server-sdk');
const { createStore } = require('./store');
const { createWalkHandler, publicFailure } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async event => {
  try {
    return await createWalkHandler({
      store: createStore(cloud.database({ throwOnNotFound: false })),
      getOpenId: () => (cloud.getWXContext() || {}).OPENID
    })(event);
  } catch (error) { return publicFailure(error); }
};
