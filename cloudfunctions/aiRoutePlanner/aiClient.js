const { AI_MODEL } = require("./config")

function createAiClient(model) {
  async function request(prompt) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return {
        success: false,
        error: "INVALID_AI_REQUEST"
      }
    }

    const messages = [
      {
        role: "user",
        content: prompt
      }
    ]

    try {
      const result = await model.generateText({
        model: AI_MODEL,
        messages
      })

      if (typeof result.text !== "string" || result.text.trim() === "") {
        return {
          success: false,
          error: "EMPTY_AI_RESPONSE"
        }
      }

      console.log("[AI Client] Usage:", result.usage)

      return {
        success: true,
        data: {
          text: result.text
        }
      }
    }
    catch (error) {
      console.error("[AI Client] Model request failed:", error.message)

      return {
        success: false,
        error: "AI_REQUEST_FAILED"
      }
    }
  }

  return {
    request
  }
}

module.exports = {
  createAiClient
}