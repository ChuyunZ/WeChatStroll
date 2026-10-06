// Page tests use a durable lifecycle double; service/backend contracts are tested separately.
function mockWalkRecords(storage) {
  const records = new Map();
  const preferencesSnapshot = value => ({ ...(value || {}), environmentPreferences: [...((value || {}).environmentPreferences || [])] });
  const fromLocal = local => ({ walkId: local.walkId, routeId: local.routeId, status: 'active',
    startTime: new Date(local.startTimeMs).toISOString(), trajectoryEnabled: local.trackingEnabled === true,
    preferences: local.preferences, schemaVersion: 1 });
  const service = {
    isValidPreferences: jest.requireActual('../../miniprogram/services/walk-records').isValidPreferences,
    preferencesSnapshot,
    getWalk: jest.fn(async id => records.get(id) || fromLocal(storage().activeWalkSession)),
    getActiveWalk: jest.fn(async () => [...records.values()].find(w => w.status === 'active') || null),
    startWalk: jest.fn(async args => {
      let walk = [...records.values()].find(w => w.status === 'active');
      if (!walk) {
        walk = { ...args, walkId: 'walk-test', status: 'active', schemaVersion: 1, startTime: new Date().toISOString() };
        records.set(walk.walkId, walk);
      }
      return walk;
    }),
    completeWalk: jest.fn(async args => {
      const walk = records.get(args.walkId) || fromLocal(storage().activeWalkSession);
      if (walk.status !== 'active') return walk;
      const terminal = { ...walk, status: args.completionStatus, completionStatus: args.completionStatus,
        endTime: new Date(args.endTimeMs).toISOString(), trajectoryEndTimeMs: args.endTimeMs,
        actualDurationSeconds: Math.floor((args.endTimeMs - Date.parse(walk.startTime)) / 1000) };
      records.set(walk.walkId, terminal);
      return terminal;
    })
  };
  return service;
}
module.exports = { mockWalkRecords };
