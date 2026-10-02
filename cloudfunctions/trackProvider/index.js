const cloud = require("wx-server-sdk");
const axios = require("axios");
const { loadConfig } = require("./config");
const { createTrackClient } = require("./track-client");
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
      getOpenId: () => {
        const context = cloud.getWXContext();
        return context && context.OPENID;
      },
      ensuredEntityIds,
      log: record =>
        console.info("[Track Provider]", record)
    });

    return await handler(event);
  } catch (error) {
    console.info("[Track Provider]", {
      event: "gateway_unavailable",
      action:
        typeof action === "string" && action.trim() !== ""
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
