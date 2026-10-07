test('entry point uses dynamic environment and authenticated context; setup errors are normalized', async () => {
  jest.resetModules();
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init: jest.fn(), getWXContext: jest.fn(() => ({})), database: jest.fn(() => ({})) };
  jest.doMock('wx-server-sdk', () => cloud);
  try {
    const { main } = require('./index');
    expect(cloud.init).toHaveBeenCalledWith({ env: 'current' });
    expect((await main({ action: 'getProfile', OPENID: 'forged' })).error.code).toBe('UNAUTHENTICATED');
    expect(cloud.database).toHaveBeenCalledWith({ throwOnNotFound: false });
    cloud.database.mockImplementation(() => { throw new Error('secret'); });
    expect((await main({})).error.code).toBe('PREFERENCE_PROFILE_STORE_FAILED');
  } finally { jest.dontMock('wx-server-sdk'); }
});
