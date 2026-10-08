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

      const rawStatus = error && (error.status || error.statusCode ||
        error.response && error.response.status);
      const status = Number(rawStatus);
      const code = error && error.code;
      const retryAfter = error && error.response && error.response.headers &&
        (error.response.headers['retry-after'] || error.response.headers['Retry-After']);
      return {
        success: false,
        error: "AI_REQUEST_FAILED",
        diagnostic: {
          // Allowlisted metadata only: never serialize raw response, prompt,
          // request headers or API tokens.
          httpStatus: Number.isInteger(status) ? status : null,
          sdkErrorCode: typeof code === 'string' ? code.slice(0, 64) : null,
          retryAfter: typeof retryAfter === 'string' ? retryAfter.slice(0, 32) : null
        }
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