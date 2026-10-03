let page

beforeEach(() => {
  let definition
  global.Page = value => { definition = value }
  jest.isolateModules(() => require('../miniprogram/pages/preferences/preferences'))
  page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = updates => {
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'questions[0].answer') page.data.questions[0].answer = value
      else page.data[key] = value
    }
  }
  global.wx = { showModal: jest.fn(), navigateTo: jest.fn() }
  page.data.questions[1].answer = 'loop'
  page.data.questions[2].answer = '适中'
  page.data.questions[3].answer = ['公园', '水边', '街道', '商街']
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  delete global.Page
  delete global.wx
})

const changeTime = (hour, minute) => page.onTimeChange({ detail: { value: [hour, minute] } })
const normalMinutes = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']

test('keeps the default at 30 minutes with hours 0 through 2', () => {
  expect(page.data.hourOptions).toEqual([0, 1, 2])
  expect(page.data.minuteOptions).toEqual(normalMinutes)
  expect(page.data.timePickerValue).toEqual([0, 6])
  expect(page.data.questions[0].answer).toEqual({ hours: 0, minutes: 30 })
})

test.each([0, 1, 2])('normalizes subminimum minute index %i to 0:15', minute => {
  changeTime(0, minute)
  expect(page.data.timePickerValue).toEqual([0, 3])
  expect(page.data.questions[0].answer).toEqual({ hours: 0, minutes: 15 })
})

test('entering two hours from 1:55 normalizes to 2:00 and limits the minute column', () => {
  changeTime(1, 11)
  changeTime(2, 11)
  expect(page.data.minuteOptions).toEqual(['00'])
  expect(page.data.timePickerValue).toEqual([2, 0])
  expect(page.data.questions[0].answer).toEqual({ hours: 2, minutes: 0 })
})

test.each([0, 1])('leaving two hours for hour %i restores normal minutes', hour => {
  changeTime(2, 6)
  changeTime(hour, 0)
  expect(page.data.minuteOptions).toEqual(normalMinutes)
  expect(page.data.questions[0].answer).toEqual({ hours: hour, minutes: hour === 0 ? 15 : 0 })
  changeTime(hour, 11)
  expect(page.data.questions[0].answer).toEqual({ hours: hour, minutes: 55 })
})

test.each([
  { hours: 0, minutes: 10 }, { hours: 2, minutes: 5 },
  { hours: 3, minutes: 0 }, { hours: NaN, minutes: 30 },
  { hours: Infinity, minutes: 0 }, { hours: 0, minutes: '30' }, null, {}
])('blocks invalid duration before route navigation: %p', answer => {
  page.data.questions[0].answer = answer
  page.goToRoutes()
  expect(wx.navigateTo).not.toHaveBeenCalled()
  expect(wx.showModal).toHaveBeenCalledTimes(1)
})

test.each([[0, 15, 15], [2, 0, 120]])('passes boundary duration %i:%i to route generation', (hours, minutes, duration) => {
  page.data.questions[0].answer = { hours, minutes }
  page.goToRoutes()
  expect(wx.showModal).not.toHaveBeenCalled()
  expect(wx.navigateTo).toHaveBeenCalledTimes(1)
  const emit = jest.fn()
  wx.navigateTo.mock.calls[0][0].success({ eventChannel: { emit } })
  expect(emit).toHaveBeenCalledWith('routePreferences', expect.objectContaining({ durationMinutes: duration }))
})
