const SESSION = {
  version: 2,
  status: 'active',
  walkId: 'walk-existing',
  routeId: 'saved route/& 123',
  startTimeMs: Date.parse('2026-10-10T12:00:00Z')
};

let reconcileActiveWalk;
let definition;
let page;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetModules();
  definition = null;
  reconcileActiveWalk = jest.fn();

  jest.doMock('../miniprogram/services/active-walk-session', () => ({
    reconcileActiveWalk
  }));

  global.Page = jest.fn(value => { definition = value; });
  global.wx = {
    navigateTo: jest.fn(({ success }) => { if (success) success(); }),
    showToast: jest.fn()
  };
  require('../miniprogram/pages/home/home');

  page = { ...definition };
  page.onLoad();
  page.onShow();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.Page;
  delete global.wx;
});

test('Home CTA resumes an existing walk without requesting new preferences or route', async () => {
  reconcileActiveWalk.mockResolvedValue(SESSION);

  await page.goPreference();

  expect(reconcileActiveWalk).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({
    url: '/pages/walking/walking?routeId=saved%20route%2F%26%20123'
  }));
  expect(wx.showToast).not.toHaveBeenCalled();
});

test('Home CTA follows existing questionnaire flow when no active walk exists', async () => {
  reconcileActiveWalk.mockResolvedValue(null);

  await page.goPreference();

  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({
    url: '/pages/preferences/preferences'
  }));
});

test('a previously completed or ended-early walk does not resume', async () => {
  // The service reconciles local/cloud terminal state and returns null.
  reconcileActiveWalk.mockResolvedValue(null);

  await page.goPreference();

  expect(wx.navigateTo.mock.calls[0][0].url).toBe('/pages/preferences/preferences');
});

test('network reconciliation error never opens preferences or walking', async () => {
  reconcileActiveWalk.mockRejectedValue(new Error('CloudBase network unavailable'));

  await page.goPreference();

  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
    title: expect.stringContaining('请重试'),
    icon: 'none'
  }));
});

test('cloud walk without local route snapshot fails safely instead of creating another walk', async () => {
  reconcileActiveWalk.mockRejectedValue(Object.assign(
    new Error('Missing saved route'), { code: 'WALK_ROUTE_UNAVAILABLE' }
  ));

  await page.goPreference();

  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
    title: expect.stringContaining('原路线')
  }));
});

test('expired active session reports its closure without misleading navigation', async () => {
  reconcileActiveWalk.mockRejectedValue(Object.assign(
    new Error('Abandoned'), { code: 'WALK_ABANDONED' }
  ));

  await page.goPreference();

  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({
    title: expect.stringContaining('超时')
  }));
});

test('repeated taps while reconciliation is in flight do not navigate twice', async () => {
  const pending = deferred();
  reconcileActiveWalk.mockReturnValue(pending.promise);

  const first = page.goPreference();
  const second = page.goPreference();
  expect(reconcileActiveWalk).toHaveBeenCalledTimes(1);

  pending.resolve(SESSION);
  await Promise.all([first, second]);

  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
});

test('repeated taps while navigation is in flight do not navigate twice', async () => {
  reconcileActiveWalk.mockResolvedValue(SESSION);
  const navigation = deferred();
  wx.navigateTo.mockImplementation(() => { /* Pending platform callbacks. */ });

  const first = page.goPreference();
  // Allow reconciliation to finish and launch navigateTo.
  await Promise.resolve();
  await page.goPreference();

  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  // Simulate leaving Home after successful platform navigation.
  page.onHide();
  // In a real mini-program, navigation invokes success. Resolve the test's
  // outstanding callback by explicitly calling the captured success handler.
  wx.navigateTo.mock.calls[0][0].success();
  navigation.resolve();
  await first;
});

test('navigation failure informs user and permits a retry', async () => {
  reconcileActiveWalk.mockResolvedValue(SESSION);
  wx.navigateTo.mockImplementationOnce(({ fail }) => fail(new Error('Navigation failed')));

  await page.goPreference();

  expect(wx.showToast).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).toHaveBeenCalledTimes(1);

  await page.goPreference();

  expect(reconcileActiveWalk).toHaveBeenCalledTimes(2);
  expect(wx.navigateTo).toHaveBeenCalledTimes(2);
});

test('leaving Home during a cloud lookup prevents stale redirect', async () => {
  const pending = deferred();
  reconcileActiveWalk.mockImplementationOnce(() => pending.promise).mockResolvedValue(null);

  const first = page.goPreference();
  page.onHide();
  pending.resolve(SESSION);
  await first;

  expect(wx.navigateTo).not.toHaveBeenCalled();

  page.onShow();
  await page.goPreference();

  expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo.mock.calls[0][0].url).toBe('/pages/preferences/preferences');
});

test('unloading Home during a cloud lookup prevents stale redirect and toast', async () => {
  const pending = deferred();
  reconcileActiveWalk.mockReturnValue(pending.promise);

  const first = page.goPreference();
  page.onUnload();
  pending.reject(new Error('Late failure'));
  await first;

  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).not.toHaveBeenCalled();
});

test('Home profile button remains unaffected', () => {
  page.goProfile();

  expect(wx.navigateTo).toHaveBeenCalledWith({
    url: '/pages/profile/profile'
  });
});
