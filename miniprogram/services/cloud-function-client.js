const {
  createCodedError
} = require('../utils/errors')

async function callCloudFunction(
  name,
  data,
  {
    fallbackCode = 'CLOUD_FUNCTION_FAILED',
    fallbackMessage = 'Cloud function request failed.'
  } = {}
) {
  if (
    typeof name !== 'string' ||
    name.trim() === ''
  ) {
    throw createCodedError(
      'INVALID_CLOUD_FUNCTION_NAME',
      'Cloud function name must be a non-empty string.'
    )
  }

  let response

  try {
    response = await wx.cloud.callFunction({
      name,
      data
    })
  } catch (error) {
    throw createCodedError(
      fallbackCode,
      fallbackMessage,
      error
    )
  }

  const result =
    response && response.result

  if (
    !result ||
    result.success !== true
  ) {
    const providerError =
      result &&
      result.error &&
      typeof result.error === 'object'
        ? result.error
        : null

    throw createCodedError(
      providerError &&
      typeof providerError.code === 'string' &&
      providerError.code.trim() !== ''
        ? providerError.code
        : fallbackCode,

      providerError &&
      typeof providerError.message === 'string' &&
      providerError.message.trim() !== ''
        ? providerError.message
        : fallbackMessage
    )
  }

  return result
}

module.exports = {
  callCloudFunction
}