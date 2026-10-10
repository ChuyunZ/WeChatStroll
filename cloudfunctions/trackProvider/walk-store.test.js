const { createWalkStore } = require('./walk-store');
test('walk authorization reads one document by ID, preserves identity and projects lifecycle metadata only', async () => {
  const walk = { _id: 'walk-1', walkId: 'walk-1', ownerKey: 'owner' };
  const doc = { field: jest.fn(), get: jest.fn().mockResolvedValue({ data: walk }) }; doc.field.mockReturnValue(doc);
  const collection = { doc: jest.fn().mockReturnValue(doc) };
  const db = { collection: jest.fn().mockReturnValue(collection) };
  expect(await createWalkStore(db).getWalk('walk-1')).toEqual(walk);
  expect(db.collection).toHaveBeenCalledWith('walks'); expect(collection.doc).toHaveBeenCalledWith('walk-1');
  const fields = Object.keys(doc.field.mock.calls[0][0]);
  expect(fields).toEqual(['_id', 'walkId', 'ownerKey', 'schemaVersion', 'status', 'completionStatus', 'trajectoryEnabled', 'trajectoryPartial', 'startTime', 'endTime', 'trajectoryEndTimeMs']);
  expect(fields.join(' ')).not.toMatch(/gps|polyline|preferences|routeId|poi/i);
  doc.get.mockResolvedValue({ data: null }); expect(await createWalkStore(db).getWalk('missing')).toBeNull();
  doc.get.mockResolvedValue({}); await expect(createWalkStore(db).getWalk('bad')).rejects.toThrow();
});
