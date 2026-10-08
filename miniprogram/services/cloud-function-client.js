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

    const exception = createCodedError(
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
    // Temporary diagnostics, allowlisted numeric/short status metadata only.
    if (name === 'aiRoutePlanner' && result && result.diagnostic) {
      const d = result.diagnostic
      exception.diagnostic = {
        httpStatus: Number.isInteger(d.httpStatus) ? d.httpStatus : null,
        sdkErrorCode: typeof d.sdkErrorCode === 'string' ? d.sdkErrorCode.slice(0, 64) : null,
        retryAfter: typeof d.retryAfter === 'string' ? d.retryAfter.slice(0, 32) : null,
        model: d.model === 'hy3' ? 'hy3' : 'unknown',
        promptChars: Number.isInteger(d.promptChars) ? d.promptChars : null,
        promptUtf8Bytes: Number.isInteger(d.promptUtf8Bytes) ? d.promptUtf8Bytes : null,
        manual: d.manual === true,
        attempt: Number.isInteger(d.attempt) ? d.attempt : null
      }
    }
    throw exception
  }

  return result
}

module.exports = {
  callCloudFunction
}