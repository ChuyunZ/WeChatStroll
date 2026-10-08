const { createAiClient } = require("./aiClient")

describe("aiClient", () => {
  test("returns normalized result when AI request succeeds", async () => {
    const fakeModel = {
      generateText: jest.fn().mockResolvedValue({
        text: "hello",
        usage: {
          total_tokens: 10
        }
      })
    }

    const aiClient = createAiClient(fakeModel)

    const result = await aiClient.request("test prompt")

    expect(result).toEqual({
      success: true,
      data: {
        text: "hello"
      }
    })

    expect(fakeModel.generateText).toHaveBeenCalledWith({
      model: "hy3",
      messages: [
        {
          role: "user",
          content: "test prompt"
        }
      ]
    })
  })

  test("returns invalid request when prompt is empty", async () => {
    const fakeModel = {
      generateText: jest.fn()
    }
  
    const aiClient = createAiClient(fakeModel)
  
    const result = await aiClient.request("")
  
    expect(result).toEqual({
      success: false,
      error: "INVALID_AI_REQUEST"
    })
  
    expect(fakeModel.generateText).not.toHaveBeenCalled()
  })

  test("returns normalized error when AI request fails", async () => {
    const fakeModel = {
      generateText: jest
        .fn()
        .mockRejectedValue(new Error("model unavailable"))
    }
  
    const aiClient = createAiClient(fakeModel)
  
    const result = await aiClient.request("test prompt")
  
    expect(result).toEqual({
      success: false,
      error: "AI_REQUEST_FAILED",
      diagnostic: { httpStatus: null, retryAfter: null, sdkErrorCode: null }
    })
  
    expect(fakeModel.generateText).toHaveBeenCalledTimes(1)
  })

  test("preserves safe HTTP 429 metadata without leaking response bodies", async () => {
    const failure = new Error("rate limited");
    failure.response = { status: 429, headers: { "retry-after": "30" },
      data: { secret: "DO_NOT_EXPORT" } };
    const client = createAiClient({ generateText: jest.fn().mockRejectedValue(failure) });
    const result = await client.request("test prompt");
    expect(result).toEqual({
      success: false,
      error: "AI_REQUEST_FAILED",
      diagnostic: { httpStatus: 429, retryAfter: "30", sdkErrorCode: null }
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
  });

  test("returns empty response error when AI returns no text", async () => {
    const fakeModel = {
      generateText: jest.fn().mockResolvedValue({
        text: ""
      })
    }
  
    const aiClient = createAiClient(fakeModel)
  
    const result = await aiClient.request("test prompt")
  
    expect(result).toEqual({
      success: false,
      error: "EMPTY_AI_RESPONSE"
    })
  
    expect(fakeModel.generateText).toHaveBeenCalledTimes(1)
  })

  
})