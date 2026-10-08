const cloud = require("wx-server-sdk")
const { createAiClient } = require("./aiClient")
const { buildRoutePlanningPrompt } = require("./routePlanningPrompt")
const { parseRoutePlan, parseAndValidateRoutePlan } = require("./routePlanContract")
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
  const normalizedEvent =
    event &&
    typeof event === "object" &&
    !Array.isArray(event)
      ? event
      : {}

  const promptResult =
    buildRoutePlanningPrompt({
      startPoint: normalizedEvent.startPoint,
      preferences: normalizedEvent.preferences,
      nearbyPois: normalizedEvent.nearbyPois,
      historicalPreferenceProfile: normalizedEvent.historicalPreferenceProfile,
      replanningContext: normalizedEvent.replanningContext
    })

  if (!promptResult.success) {
    return promptResult
  }

  const aiResult =
    await client.request(
      promptResult.data.prompt
    )

  if (!aiResult.success) {
    // Temporary diagnostics: report the actual prompt size and safe SDK error
    // metadata, never the prompt, location, tokens or raw server response.
    return {
      ...aiResult,
      diagnostic: {
        ...(aiResult.diagnostic || {}),
        model: 'hy3',
        promptChars: promptResult.data.prompt.length,
        promptUtf8Bytes: Buffer.byteLength(promptResult.data.prompt, 'utf8'),
        manual: normalizedEvent.replanningContext &&
          normalizedEvent.replanningContext.mode === 'manual',
        attempt: normalizedEvent.replanningContext &&
          normalizedEvent.replanningContext.attempt || 1
      }
    }
  }
  const rawPlanResult =
    parseRoutePlan(
      aiResult.data.text
    )

  if (rawPlanResult.success) {
    const rawCandidates =
      rawPlanResult.data &&
      Array.isArray(
        rawPlanResult.data.candidates
      )
        ? rawPlanResult.data.candidates
        : []

    console.log(
      "[AI Route Planner] Raw candidates:",
      {
        count:
          rawCandidates.length,

        waypointIds:
          rawCandidates.map(
            candidate =>
              candidate &&
              Array.isArray(candidate.waypoints)
                ? candidate.waypoints.map(
                    waypoint =>
                      waypoint &&
                      typeof waypoint.poiId === "string"
                        ? waypoint.poiId
                        : null
                  )
                : null
          )
      }
    )
  }
  else {
    console.warn(
      "[AI Route Planner] Raw response is not valid JSON."
    )
  }

  const planResult =
    parseAndValidateRoutePlan(
      aiResult.data.text,
      normalizedEvent.nearbyPois
    )

  if (!planResult.success) {
    console.warn('[AI Route Planner] Validation failed:', { code: planResult.error })
    return planResult
  }
  console.log(
    "[AI Route Planner] Validated candidates:",
    {
      count:
        planResult.data.candidates.length,

      waypointIds:
        planResult.data.candidates.map(
          candidate =>
            candidate.waypoints.map(
              waypoint =>
                waypoint.poiId
            )
        )
    }
  )

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
    },
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {})
  }
}

exports.generateWaypointPlan =
  generateWaypointPlan
