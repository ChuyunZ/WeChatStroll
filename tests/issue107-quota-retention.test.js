const { canDeleteQuotaRecord } = require('../scripts/issue107-quota-retention.cjs')
const { DAY } = require('../cloudfunctions/mapProvider/quota')
const calendar = { activeFromMs: 0, offsetMinutes: 480, latestDay: 10 }
const now = 10 * DAY - 480 * 60000
const check = (id, data, overrides = {}) => canDeleteQuotaRecord({ id, data, calendar, now, ...overrides })
test('calendar, current day, high water day and three complete previous days survive cleanup', () => {
  for (const id of ['calendar', 'day_10', 'day_9', 'day_8', 'day_7', 'unknown']) expect(check(id)).toBe(false)
  expect(check('day_6')).toBe(true)
  expect(check('day_6', null, { calendar: { ...calendar, latestDay: 6 } })).toBe(false)
})
test.each(['request_' + 'a'.repeat(64), 'attempt_' + 'a'.repeat(48)])('%s requires a full next quota day of retention', id => {
  expect(check(id, { day: 8, expires: now })).toBe(true)
  expect(check(id, { day: 8, expires: now }, { now: now - 1 })).toBe(false)
  expect(check(id, { day: 9, expires: now })).toBe(false)
  expect(check(id, { day: 10, expires: now })).toBe(false)
  expect(check(id, { day: 8, expires: now - 1 })).toBe(false)
  expect(check(id, { day: 8, expires: now + DAY })).toBe(false)
})
test('missing/malformed calendar, backwards clock and foreign document names fail closed', () => {
  expect(check('day_1', {}, { calendar: null })).toBe(false)
  expect(check('day_1', {}, { calendar: { ...calendar, offsetMinutes: NaN } })).toBe(false)
  expect(check('day_1', {}, { now: now - DAY })).toBe(false)
  expect(check('request_bad', { day: 0, expires: DAY * 2 })).toBe(false)
})
