// Integration-style regression: use the REAL active-walk-session service rather
// than mocking reconciliation, so a legacy local lock with incomplete geometry
// is proven to survive Home recovery checks.
const routeId = 'original-route';
const goodRoute = {
  routeId,
  durationMinutes: 20,
  distanceMeters: 1200,
  polyline: [
    { latitude: 30.3798, longitude: 120.0295 },
    { latitude: 30.3800, longitude: 120.0297 }
  ]
};
let storage;
let page;
let getWalk;
let getActiveWalk;

beforeEach(() => {
  jest.resetModules();
  const startTimeMs = Date.now() - 60000;
  storage = {
    activeWalkSession: {
      version: 2,
      status: 'active',
      walkId: 'original-walk',
      routeId,
      route: { routeId }, // still passes older active-walk-session validation
      startTimeMs,
      preferences: {
        durationMinutes: 20,
        routeType: 'out_and_back',
        crowdPreference: 'medium',
        environmentPreferences: ['公园']
      },
      trackingEnabled: false
    }
  };

  getWalk = jest.fn().mockResolvedValue({
    walkId: 'original-walk',
    routeId,
    status: 'active',
    startTime: new Date(startTimeMs).toISOString()
  });
  getActiveWalk = jest.fn().mockResolvedValue(null);
  jest.doMock('../miniprogram/services/walk-records', () => ({
    getWalk, getActiveWalk,
    isValidPreferences: () => true
  }));

  global.wx = {
    getStorageSync: jest.fn(key => storage[key]),
    removeStorageSync: jest.fn(key => { delete storage[key]; }),
    setStorageSync: jest.fn((key, value) => { storage[key] = value; }),
    navigateTo: jest.fn(({ success }) => { if (success) success(); }),
    showToast: jest.fn()
  };
  global.Page = jest.fn(definition => { page = { ...definition }; });
  // Do not mock active-walk-session; we want its real local/cloud reconcile.
  require('../miniprogram/pages/home/home');
  page.onLoad();
  page.onShow();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.Page;
  delete global.wx;
});

test('real reconciliation keeps invalid local walk identity on Home rather than clearing it in Walking', async () => {
  const originalSession = storage.activeWalkSession;
  await page.goPreference();

  expect(getWalk).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith({
    title: '原路线数据缺失，暂时无法恢复散步',
    icon: 'none'
  });
  expect(wx.removeStorageSync).not.toHaveBeenCalled();
  expect(storage.activeWalkSession).toBe(originalSession);
  expect(storage.activeWalkSession.walkId).toBe('original-walk');

  // Simulate recovering the route geometry without changing walk identity.
  storage.activeWalkSession = { ...originalSession, route: goodRoute };
  await page.goPreference();
  expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({
    url: '/pages/walking/walking?routeId=original-route'
  }));
  expect(storage.activeWalkSession.walkId).toBe('original-walk');
});

test('cloud-only active walk with no local snapshot also prevents new route planning', async () => {
  delete storage.activeWalkSession;
  getActiveWalk.mockResolvedValue({
    walkId: 'original-walk',
    routeId,
    startTime: new Date(Date.now() - 60000).toISOString(),
    status: 'active'
  });

  await page.goPreference();

  expect(getActiveWalk).toHaveBeenCalledTimes(1);
  expect(wx.navigateTo).not.toHaveBeenCalled();
  expect(wx.showToast).toHaveBeenCalledWith({
    title: '原路线数据缺失，暂时无法恢复散步',
    icon: 'none'
  });
  expect(wx.removeStorageSync).not.toHaveBeenCalled();
});
