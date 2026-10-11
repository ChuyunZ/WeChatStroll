const { buildSeed } = require('../scripts/issue107-quota-seed.cjs')
const input = { date: '2026-10-11', offsetMinutes: 480, used: { explore: 12, walking: 100 },
  users: { ['a'.repeat(64)]: { explore: 3, walking: 40 } }, userUsageComplete: true }
test('offline seed identifies provider-local day and retains reconciled user/global counts', () => {
  const result = buildSeed(input)
  expect(new Date(result.activeFromMs).toISOString()).toBe('2026-10-10T16:00:00.000Z')
  expect(result.documentId).toBe('day_20737')
  expect(result.data).toEqual({ used: input.used, users: input.users, sessions: {} })
})
test.each([{ userUsageComplete: false }, { offsetMinutes: undefined }, { date: '2026-02-30' },
  { users: { OPENID: { explore: 1, walking: 1 } } }, { used: { explore: 0, walking: 0 } }])(
  'rejects unsafe initialization %j', override => expect(() => buildSeed({ ...input, ...override })).toThrow())
test('saturates already-exceeded ceilings rather than granting fresh capacity', () => {
  const result = buildSeed({ ...input, used: { explore: 200, walking: 6000 }, users: {
    ['a'.repeat(64)]: { explore: 10, walking: 300 }
  } })
  expect(result.data.used).toEqual({ explore: 180, walking: 5400 })
  expect(result.data.users['a'.repeat(64)]).toEqual({ explore: 9, walking: 270 })
})
