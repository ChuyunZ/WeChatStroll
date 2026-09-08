const cloud = require("wx-server-sdk")
const { createAiClient } = require("./aiClient")

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 60000
})

const ai = cloud.ai()
const model = ai.createModel("cloudbase")

const aiClient = createAiClient(model)

exports.main = async () => {
  const prompt = 'Return exactly: {"success":true}'

  return aiClient.request(prompt)
}