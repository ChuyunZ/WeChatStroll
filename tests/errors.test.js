const {
  createCodedError
} = require(
  '../miniprogram/utils/errors'
)

describe('error utils', () => {
  test(
    'creates a standard Error with a code and message',
    () => {
      const error =
        createCodedError(
          'TEST_ERROR',
          'Something went wrong.'
        )

      expect(error).toBeInstanceOf(Error)

      expect(error.code).toBe(
        'TEST_ERROR'
      )

      expect(error.message).toBe(
        'Something went wrong.'
      )
    }
  )

  test(
    'does not add originalError when none is provided',
    () => {
      const error =
        createCodedError(
          'TEST_ERROR',
          'Something went wrong.'
        )

      expect(
        Object.prototype.hasOwnProperty.call(
          error,
          'originalError'
        )
      ).toBe(false)
    }
  )

  test(
    'preserves an original error when provided',
    () => {
      const originalError =
        new Error(
          'Underlying failure'
        )

      const error =
        createCodedError(
          'WRAPPED_ERROR',
          'Higher-level failure.',
          originalError
        )

      expect(
        error.originalError
      ).toBe(originalError)

      expect(error.code).toBe(
        'WRAPPED_ERROR'
      )

      expect(error.message).toBe(
        'Higher-level failure.'
      )
    }
  )
})