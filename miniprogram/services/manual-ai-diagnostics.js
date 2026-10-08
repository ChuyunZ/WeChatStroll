// TEMPORARY 429 investigation. Remove this file after diagnosis.
// Only records bounded request metadata, not prompts, coordinates, access tokens
// or raw model responses. Stored inside the WeChat simulator sandbox.
const events = [];
const path = typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH
  ? wx.env.USER_DATA_PATH + '/manual-ai-diagnostics.json' : null;
function record(type, data = {}) {
  events.push({ at: new Date().toISOString(), type, ...data });
  if (events.length > 100) events.shift();
  try {
    if (path && wx.getFileSystemManager) {
      wx.getFileSystemManager().writeFileSync(path, JSON.stringify({
        version: 1, note: 'Temporary client-side diagnostic; no raw prompt or coordinates',
        events
      }, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn('[AI Diagnostic] File write unavailable:', error && error.errMsg || 'unknown');
  }
}
function exportToClipboard() {
  const data = JSON.stringify({ version: 1, events }, null, 2);
  if (typeof wx !== 'undefined' && wx.setClipboardData) {
    wx.setClipboardData({ data });
  }
  console.log('[AI Diagnostic] Simulator file:', path);
  return { path, eventCount: events.length, data };
}
module.exports = { record, exportToClipboard };
