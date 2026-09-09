const cloud = require("wx-server-sdk")
const { createAiClient } = require("./aiClient")

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 60000
})

let aiClient

exports.main = async () => {
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

  const prompt = 'Return exactly: {"success":true}'

  return aiClient.request(prompt)
}