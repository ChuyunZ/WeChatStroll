const mockAdd = jest.fn()
const mockGet = jest.fn()
const mockRemove = jest.fn()
const mockDoc = jest.fn(() => ({
  get: mockGet,
  remove: mockRemove
}))
const mockCollection = jest.fn(() => ({
  add: mockAdd,
  doc: mockDoc
}))

jest.mock('wx-server-sdk', () => ({
  DYNAMIC_CURRENT_ENV: 'test-env',
  init: jest.fn(),
  database: jest.fn(() => ({
    collection: mockCollection
  }))
}))

const { main } = require('./index')

describe('dbHealthCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockAdd.mockResolvedValue({
      _id: 'test-document-id'
    })

    mockGet.mockResolvedValue({
      data: {
        _id: 'test-document-id',
        openid: '__db_health_check__',
        username: 'Database Health Check',
        totalWalks: 0,
        createdAt: '2026-09-05T00:00:00.000Z'
      }
    })

    mockRemove.mockResolvedValue({
      stats: {
        removed: 1
      }
    })
  })

  test('writes, reads, and deletes the health check document', async () => {
    const result = await main()

    expect(result.success).toBe(true)
    expect(result.message).toBe(
      'Database write, read, and delete succeeded'
    )

    expect(mockCollection).toHaveBeenCalledWith('users')

    expect(mockAdd).toHaveBeenCalledWith({
      data: {
        openid: '__db_health_check__',
        username: 'Database Health Check',
        totalWalks: 0,
        createdAt: expect.any(String)
      }
    })

    expect(mockDoc).toHaveBeenCalledWith('test-document-id')
    expect(mockGet).toHaveBeenCalled()
    expect(mockRemove).toHaveBeenCalled()
  })

  test('returns a clean error when database write fails', async () => {
    mockAdd.mockRejectedValue(
      new Error('Database write failed')
    )

    const result = await main()

    expect(result).toEqual({
      success: false,
      message: 'Database health check failed',
      error: 'Database write failed'
    })

    expect(mockGet).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  test('cleans up the temporary document when read fails', async () => {
    mockGet.mockRejectedValue(
      new Error('Database read failed')
    )

    const result = await main()

    expect(result).toEqual({
      success: false,
      message: 'Database health check failed',
      error: 'Database read failed'
    })

    expect(mockDoc).toHaveBeenCalledWith('test-document-id')

    // read fails after write, so catch should remove
    // the temporary document.
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })
})