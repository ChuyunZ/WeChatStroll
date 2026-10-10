const crypto = require('crypto');
const START_MS = 1760000000000;
const END_MS = START_MS + 1800000;
function testWalk(changes = {}, openid = 'openid-one') {
  return { _id: 'walk-1', walkId: 'walk-1', ownerKey: crypto.createHash('sha256').update(openid).digest('hex'),
    schemaVersion: 1, status: 'completed', completionStatus: 'completed', trajectoryEnabled: true,
    trajectoryPartial: false, startTime: new Date(START_MS).toISOString(), endTime: new Date(END_MS).toISOString(),
    trajectoryEndTimeMs: END_MS, ...changes };
}
module.exports = { testWalk, START_MS, END_MS };
