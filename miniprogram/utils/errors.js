function createCodedError(
  code,
  message,
  originalError = null
) {
  const error = new Error(message)

  error.code = code

  if (originalError) {
    error.originalError = originalError
  }

  return error
}

module.exports = {
  createCodedError
}