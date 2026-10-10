const { callCloudFunction } = require('./cloud-function-client');
const { validateRequest, validateTraceResponse, traceError, safeCode } = require('../utils/history-trace-schema');
const TRACE_SEARCH_RETRY_DELAYS_MS = [500, 1000];
async function searchWalkTrace(input) {
  const { walkId } = validateRequest(input);
  const query = async () => {
    try {
      const result = await callCloudFunction('trackProvider', { action: 'searchWalkTrace', walkId }, {
        fallbackCode: 'TRACK_SEARCH_FAILED', fallbackMessage: 'Unable to query walking trajectory.'
      });
      return validateTraceResponse(result);
    } catch (error) {
      // Preserve known codes, never forward unexpected upstream messages or originalError payloads.
      throw traceError(safeCode(error));
    }
  };
  let trace = await query();
  for (const delay of TRACE_SEARCH_RETRY_DELAYS_MS) {
    if (trace.points.length || !trace.retryable) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    trace = await query();
  }
  return trace;
}
module.exports = { searchWalkTrace };
