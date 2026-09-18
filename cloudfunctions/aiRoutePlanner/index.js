const cloud = require("wx-server-sdk")
const { createAiClient } = require("./aiClient")
const { buildRoutePlanningPrompt } = require("./routePlanningPrompt")
const { parseAndValidateRoutePlan } = require("./routePlanContract")

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 60000
})

let aiClient

exports.main = async (event) => {
  try {
    if (!aiClient) {
      const ai = cloud.ai()
      const model = ai.createModel("cloudbase")
      aiClient = createAiClient(model)
    }
  }
  catch (error) {
    console.error("[AI Client] Configuration unavailable:", error.message)
    return {
      success: false,
      error: {
        code: "AI_CONFIG_UNAVAILABLE",
        message:
          "AI service configuration is unavailable."
      }
    }
  }

  const result =
    await generateWaypointPlan(
      event,
      aiClient
    )

  return normalizeErrorResponse(result)
}

async function generateWaypointPlan(
  event,
  client
) {
  const promptResult =
    buildRoutePlanningPrompt({
      startPoint: event.startPoint,
      preferences: event.preferences,
      nearbyPois: event.nearbyPois
    })

  if (!promptResult.success) {
    return promptResult
  }

  const aiResult =
    await client.request(
      promptResult.data.prompt
    )

  if (!aiResult.success) {
    return aiResult
  }

  const planResult =
    parseAndValidateRoutePlan(
      aiResult.data.text,
      event.nearbyPois
    )

  if (!planResult.success) {
    return planResult
  }

  return {
    success: true,
    plan: planResult.data
  }
}


function normalizeErrorResponse(result) {
  if (
    !result ||
    result.success === true ||
    typeof result.error !== "string"
  ) {
    return result
  }

  const errorMessages = {
    INVALID_AI_ROUTE_INPUT:
      "Route planning input is invalid.",

    INVALID_AI_REQUEST:
      "AI request is invalid.",

    EMPTY_AI_RESPONSE:
      "AI returned an empty response.",

    AI_REQUEST_FAILED:
      "Unable to request an AI route plan.",

    INVALID_AI_ROUTE_PLAN:
      "AI returned an invalid route plan."
  }

  return {
    success: false,
    error: {
      code: result.error,
      message:
        errorMessages[result.error] ||
        "Unable to generate waypoint plan."
    }
  }
}

exports.generateWaypointPlan =
  generateWaypointPlan
