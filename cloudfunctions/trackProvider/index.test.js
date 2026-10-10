const { testWalk, START_MS } = require('./test-walk');
let cloud, client, document, main;
beforeEach(() => {
  jest.resetModules();
  document = { field: jest.fn(), get: jest.fn().mockResolvedValue({ data: testWalk() }) }; document.field.mockReturnValue(document);
  const db = { collection: jest.fn(() => ({ doc: jest.fn(() => document) })) };
  cloud = { init: jest.fn(), DYNAMIC_CURRENT_ENV: 'dynamic', getWXContext: jest.fn(() => ({ OPENID: 'openid-one' })), database: jest.fn(() => db) };
  client = { ensureEntity: jest.fn().mockResolvedValue({}), uploadTrace: jest.fn().mockResolvedValue({ uploadedCount: 1 }),
    searchTrace: jest.fn().mockResolvedValue({ points: [{ lat: 31, lng: 121, loctime: START_MS / 1000 + 1 }], mileageMeters: 10, durationSeconds: 1 }) };
  jest.doMock('wx-server-sdk', () => cloud);
  jest.doMock('./config', () => ({ loadConfig: () => ({ entitySecret: 'test-secret' }) }));
  jest.doMock('./track-client', () => ({ createTrackClient: () => client }));
  jest.spyOn(console, 'info').mockImplementation(() => {});
  main = require('./index').main;
});
afterEach(() => { jest.restoreAllMocks(); jest.dontMock('wx-server-sdk'); jest.dontMock('./config'); jest.dontMock('./track-client'); });
test('entry point ignores CloudBase userInfo and tcbContext, authenticating only via WXContext', async () => {
  const transport = {
    userInfo: { openId: 'forged', appId: 'metadata' },
    tcbContext: { OPENID: 'forged', openId: 'forged', other: 'untrusted' }
  };
  const result = await main({ action: 'searchWalkTrace', walkId: 'walk-1', ...transport });
  expect(result.success).toBe(true); expect(cloud.database).toHaveBeenCalledWith({ throwOnNotFound: false });
  expect(result.trace.points).toHaveLength(1);
  cloud.getWXContext.mockReturnValue({ OPENID: 'other-user' });
  client.ensureEntity.mockClear(); client.searchTrace.mockClear();
  expect((await main({ action: 'searchWalkTrace', walkId: 'walk-1',
    userInfo: { openId: 'openid-one' }, tcbContext: { OPENID: 'openid-one' } })).error.code).toBe('WALK_NOT_FOUND');
  expect(client.ensureEntity).not.toHaveBeenCalled(); expect(client.searchTrace).not.toHaveBeenCalled();
});
test('entry point still rejects unexpected application fields and retired range action', async () => {
  for (const extra of [{ OPENID: 'forged' }, { ownerKey: 'forged' },
    { startTimeMs: START_MS }, { endTimeMs: START_MS + 1000 }, { trajectoryPartial: false }]) {
    expect((await main({ action: 'searchWalkTrace', walkId: 'walk-1',
      userInfo: { openId: 'forged' }, tcbContext: { OPENID: 'forged' }, ...extra })).error.code)
      .toBe('INVALID_WALK_TRACE_REQUEST');
  }
  expect((await main({ action: 'searchTrace', startTimeMs: START_MS, endTimeMs: START_MS + 1000 })).error.code).toBe('TRACK_WALK_REQUIRED');
  expect(cloud.database).not.toHaveBeenCalled(); expect(client.ensureEntity).not.toHaveBeenCalled();
});
test('active entity initialization and upload still require no database access', async () => {
  await main({ action: 'ensureEntity' });
  await main({ action: 'uploadTrace', routeId: 'r', walkStartTimeMs: START_MS,
    point: { latitude: 31, longitude: 121, timestampMs: START_MS } });
  expect(client.ensureEntity).toHaveBeenCalledTimes(1); expect(client.uploadTrace).toHaveBeenCalledTimes(1); expect(cloud.database).not.toHaveBeenCalled();
});
test('database errors stay fixed and contain no server details', async () => {
  document.get.mockRejectedValue(new Error('secret credentials'));
  const result = await main({ action: 'searchWalkTrace', walkId: 'walk-1' });
  expect(result.error.code).toBe('TRACK_WALK_READ_FAILED'); expect(JSON.stringify(result)).not.toContain('secret');
  expect(client.searchTrace).not.toHaveBeenCalled();
});
