// Offline operator use and test re-export. The deployed cleanup function ships
// the SAME standalone policy code; never fork a second retention predicate.
module.exports = require('../cloudfunctions/mapQuotaCleanup/retention')
