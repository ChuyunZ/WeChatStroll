const {
  callCloudFunction
} = require(
  '../miniprogram/services/cloud-function-client'
)

const originalWx = global.wx

describe('cloud-function-client', () => {
  afterEach(() => {
    global.wx = originalWx
  })

  test(
    'returns the successful cloud function result',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result: {
              success: true,
              value: 'test-value'
            }
          })
        }
      }

      const result =
        await callCloudFunction(
          'testFunction',
          {
            input: 123
          }
        )

      expect(result).toEqual({
        success: true,
        value: 'test-value'
      })
    }
  )

  test(
    'passes the function name and data to wx.cloud.callFunction',
    async () => {
      let receivedRequest

      global.wx = {
        cloud: {
          callFunction: async (
            request
          ) => {
            receivedRequest = request

            return {
              result: {
                success: true
              }
            }
          }
        }
      }

      await callCloudFunction(
        'testFunction',
        {
          input: 123
        }
      )

      expect(receivedRequest).toEqual({
        name: 'testFunction',
        data: {
          input: 123
        }
      })
    }
  )

  test(
    'rejects an invalid cloud function name before calling wx.cloud',
    async () => {
      let callCount = 0

      global.wx = {
        cloud: {
          callFunction: async () => {
            callCount++

            return {
              result: {
                success: true
              }
            }
          }
        }
      }

      await expect(
        callCloudFunction(
          '   ',
          {}
        )
      ).rejects.toMatchObject({
        code:
          'INVALID_CLOUD_FUNCTION_NAME',

        message:
          'Cloud function name must be a non-empty string.'
      })

      expect(callCount).toBe(0)
    }
  )

  test(
    'wraps an SDK or network failure with the configured fallback error',
    async () => {
      const originalError =
        new Error(
          'Network unavailable'
        )

      global.wx = {
        cloud: {
          callFunction: async () => {
            throw originalError
          }
        }
      }

      let caughtError

      try {
        await callCloudFunction(
          'testFunction',
          {},
          {
            fallbackCode:
              'TEST_FUNCTION_FAILED',

            fallbackMessage:
              'Unable to call test function.'
          }
        )
      } catch (error) {
        caughtError = error
      }

      expect(
        caughtError
      ).toBeInstanceOf(Error)

      expect(
        caughtError.code
      ).toBe(
        'TEST_FUNCTION_FAILED'
      )

      expect(
        caughtError.message
      ).toBe(
        'Unable to call test function.'
      )

      expect(
        caughtError.originalError
      ).toBe(originalError)
    }
  )

  test(
    'preserves an error code and message returned by the cloud function',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result: {
              success: false,

              error: {
                code:
                  'ROUTE_NOT_FOUND',

                message:
                  'No walking route was found.'
              }
            }
          })
        }
      }

      await expect(
        callCloudFunction(
          'getWalkingRoute',
          {}
        )
      ).rejects.toMatchObject({
        code:
          'ROUTE_NOT_FOUND',

        message:
          'No walking route was found.'
      })
    }
  )

  test(
    'uses fallback values when the cloud function returns an invalid error object',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result: {
              success: false,
              error: null
            }
          })
        }
      }

      await expect(
        callCloudFunction(
          'testFunction',
          {},
          {
            fallbackCode:
              'TEST_FUNCTION_FAILED',

            fallbackMessage:
              'Unable to call test function.'
          }
        )
      ).rejects.toMatchObject({
        code:
          'TEST_FUNCTION_FAILED',

        message:
          'Unable to call test function.'
      })
    }
  )

  test(
    'uses fallback values when the response has no usable result',
    async () => {
      global.wx = {
        cloud: {
          callFunction: async () => ({
            result: null
          })
        }
      }

      await expect(
        callCloudFunction(
          'testFunction',
          {},
          {
            fallbackCode:
              'TEST_FUNCTION_FAILED',

            fallbackMessage:
              'Unable to call test function.'
          }
        )
      ).rejects.toMatchObject({
        code:
          'TEST_FUNCTION_FAILED',

        message:
          'Unable to call test function.'
      })
    }
  )
})