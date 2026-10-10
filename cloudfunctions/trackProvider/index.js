const cloud = require("wx-server-sdk");
const axios = require("axios");
const { loadConfig } = require("./config");
const { createTrackClient } = require("./track-client");
const { createWalkStore } = require('./walk-store');
const { createQuotaStore, createHistoryLimiter } = require('./history-limiter');
const {
  createTrackHandler,
  publicFailure
} = require("./handler");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const ensuredEntityIds = new Set();

exports.main = async event => {
  const action = event && event.action;

  try {
    const config = loadConfig();
    const client = createTrackClient({
      config,
      http: axios
    });

    const handler = createTrackHandler({
      config,
      client,
      // Lazy: active uploads/entity preparation do not acquire new database dependencies.
      walkStore: { getWalk: walkId => createWalkStore(cloud.database({ throwOnNotFound: false })).getWalk(walkId) },
      historyLimiter: createHistoryLimiter({ store: {
        transaction: work => createQuotaStore(cloud.database({ throwOnNotFound: false })).transaction(work)
      } }),
      getOpenId: () => {
        const context = cloud.getWXContext();
        return context && context.OPENID;
      },
      ensuredEntityIds,
      log: record =>
        console.info("[Track Provider]", record)
    });

    // CloudBase injects transport fields. Never use these for authentication:
    // only cloud.getWXContext().OPENID can identify the current user.
    // All other unexpected application fields still reach strict validation.
    if (action === 'searchWalkTrace' && event && typeof event === 'object') {
      const { userInfo, tcbContext, ...request } = event;
      return await handler(request);
    }
    return await handler(event);
  } catch (error) {
    console.info("[Track Provider]", {
      event: "gateway_unavailable",
      action:
        ['ensureEntity', 'uploadTrace', 'searchTrace', 'searchWalkTrace'].includes(action)
          ? action
          : "unknown"
    });

    if (
      error &&
      typeof error.message === "string" &&
      error.message.includes("configuration")
    ) {
      return {
        success: false,
        error: {
          code: "TRACK_PROVIDER_CONFIG_ERROR",
          message:
            "Walking trajectory service is not configured."
        }
      };
    }

    return publicFailure(error);
  }
};
