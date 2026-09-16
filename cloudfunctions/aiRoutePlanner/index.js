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
      error: "AI_CONFIG_UNAVAILABLE"
    }
  }

  return generateWaypointPlan(
    event,
    aiClient
  )
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

exports.generateWaypointPlan =
  generateWaypointPlan
