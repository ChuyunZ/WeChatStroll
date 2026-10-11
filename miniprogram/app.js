App({
  onLaunch() {
    console.log('WeChatStroll launched')

    if (!wx.cloud) {
      console.error('CloudBase is not supported by the current base library version')
      return
    }

    wx.cloud.init({
      env: 'cloud1-d0g0q6wm2e49d23d0',
      traceUser: true
    })

    console.log('CloudBase initialized')

    // Sanitize old terminal handoffs and verify old active walks after cold launch.
    // Never clear an active lock on local time alone; CloudBase is authoritative.
    let sessions
    try {
      sessions = require('./services/active-walk-session')
    } catch (_) {
      console.warn('[Recovery] Local session service unavailable')
      return
    }
    // Legacy Feedback cleanup cannot block server-authoritative stale checking.
    try {
      sessions.getPendingWalkResult()
    } catch (_) {
      console.warn('[Recovery] Terminal handoff cleanup deferred')
    }
    try {
      void sessions.cleanupStaleActiveWalk().catch(() => {
        console.warn('[Recovery] Stale walk verification deferred')
      })
    } catch (_) {
      console.warn('[Recovery] Stale walk verification deferred')
    }
  }
})