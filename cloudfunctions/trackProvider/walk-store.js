const FIELDS = { _id: true, walkId: true, ownerKey: true, schemaVersion: true, status: true,
  completionStatus: true, trajectoryEnabled: true, trajectoryPartial: true,
  startTime: true, endTime: true, trajectoryEndTimeMs: true };
function createWalkStore(db) {
  return {
    async getWalk(walkId) {
      const result = await db.collection('walks').doc(walkId).field(FIELDS).get();
      if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid walk read.');
      return result.data;
    }
  };
}
module.exports = { createWalkStore };
