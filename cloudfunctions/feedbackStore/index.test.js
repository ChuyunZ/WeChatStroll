test('entry point derives identity from cloud context and normalizes database setup failures', async () => {
  jest.resetModules();
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init: jest.fn(), getWXContext: jest.fn(() => ({})), database: jest.fn(() => ({})) };
  jest.doMock('wx-server-sdk', () => cloud);
  try {
    const { main } = require('./index');
    expect(cloud.init).toHaveBeenCalledWith({ env: 'current' });
    expect((await main({ action: 'getFeedback', walkId: 'walk-1', OPENID: 'forged' })).error.code).toBe('UNAUTHENTICATED');
    expect(cloud.database).toHaveBeenCalledWith({ throwOnNotFound: false });
    cloud.database.mockImplementation(() => { throw new Error('secret'); });
    expect((await main({})).error.code).toBe('FEEDBACK_STORE_FAILED');
  } finally { jest.dontMock('wx-server-sdk'); }
});
