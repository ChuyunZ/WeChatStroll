const { getMapQuotaStatus, quotaStatusText } = require('../miniprogram/services/map-quota-status')

test('reads authenticated server-owned quota with only an action; formats a qualified estimate', async () => {
  const call = jest.fn(async () => ({
    success: true, quota: { remainingPlanningSessions: 2, resetAtMs: 1791853200000 }
  }))
  const status = await getMapQuotaStatus({ call })
  expect(call).toHaveBeenCalledWith('mapProvider', { action: 'quotaStatus' }, expect.objectContaining({
    fallbackCode: 'MAP_QUOTA_UNAVAILABLE'
  }))
  expect(status).toEqual({ remainingPlanningSessions: 2, resetAtMs: 1791853200000 })
  expect(quotaStatusText(status)).toContain('预计还可发起 2 次')
  expect(quotaStatusText(null)).toBe('今日规划额度暂不可查询')
})
test.each([
  null, {}, { remainingPlanningSessions: -1, resetAtMs: 100 },
  { remainingPlanningSessions: 4, resetAtMs: 100 },
  { remainingPlanningSessions: 1.5, resetAtMs: 100 },
  { remainingPlanningSessions: 1, resetAtMs: 'private' }
])('invalid or missing quota response %p never fabricates a balance', async quota => {
  await expect(getMapQuotaStatus({ call: async () => ({ success: true, quota }) }))
    .rejects.toMatchObject({ code: 'MAP_QUOTA_UNAVAILABLE' })
})
test('network and backend failures cannot be mistaken for zero remaining', async () => {
  await expect(getMapQuotaStatus({ call: async () => { throw new Error('offline') } }))
    .rejects.toThrow('offline')
})
