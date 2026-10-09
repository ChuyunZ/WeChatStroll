const { generateCases, runBenchmark } = require('../../services/route-copy-benchmark');

Page({
  data: {
    loading: false,
    status: 'idle',
    message: '',
    timestamp: '',
    errorMessage: '',
    benchmarkRunning: false,
    benchmarkCompleted: 0,
    benchmarkFailures: 0,
    benchmarkMessage: '',
    benchmarkFile: '',
    benchmarkHasReport: false
  },

  // Only run this in WeChat Developer Tools. This page is for development only;
  // do not ship benchmark controls as part of the public release.
  async startCopyBenchmark(event) {
    if (this._benchmarkRunning) return;
    const minutes = Number(event && event.currentTarget && event.currentTarget.dataset.minutes);
    if (![30, 60].includes(minutes)) return;
    let platform = '';
    try { platform = wx.getSystemInfoSync().platform; } catch (_) { /* fail closed */ }
    if (platform !== 'devtools') {
      this.setData({ benchmarkMessage: '仅允许在微信开发者工具运行' }); return;
    }
    const routesPage = getCurrentPages().find(p => p.route === 'pages/routes/routes');
    if (!routesPage || !Array.isArray(routesPage._verifiedWaypointPool) ||
        !routesPage._verifiedWaypointPool.length) {
      this.setData({ benchmarkMessage: '请先生成真实路线，取得地图搜索的 POI 候选池，然后进入本页' });
      return;
    }
    const cases = generateCases({
      poiPool: routesPage._verifiedWaypointPool, seed: Date.now(), count: 150
    });
    if (!cases.length) {
      this.setData({ benchmarkMessage: '没有符合文案契约的地图 POI 名称及类别，未发送请求' });
      return;
    }
    const control = { stopped: false };
    this._benchmarkControl = control;
    this._benchmarkRunning = true;
    this._benchmarkReport = null;
    const fs = wx.getFileSystemManager && wx.getFileSystemManager();
    const path = wx.env && wx.env.USER_DATA_PATH ?
      wx.env.USER_DATA_PATH + '/route-copy-benchmark.json' : '';
    const save = report => {
      this._benchmarkReport = report;
      if (fs && path) {
        try { fs.writeFileSync(path, JSON.stringify(report, null, 2), 'utf8'); }
        catch (_) { /* Clipboard export remains available. */ }
      }
    };
    const begin = Date.now();
    this.setData({ benchmarkRunning: true, benchmarkCompleted: 0,
      benchmarkFailures: 0, benchmarkMessage: '随机组合地图 POI + 模拟路线事实；首次失败立即停止',
      benchmarkFile: path, benchmarkHasReport: false });
    try {
      const report = await runBenchmark({
        minutes, cases,
        shouldStop: () => control.stopped || this._unloaded,
        call: payload => wx.cloud.callFunction({ name: 'routeCopyGenerator',
          data: { payload, benchmarkDebug: true } }),
        // Wake at most every 2 seconds so pressing Stop works promptly.
        sleep: async ms => {
          const until = Date.now() + ms;
          while (!control.stopped && !this._unloaded && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, until - Date.now())));
          }
        },
        onRecord: (record, partial) => {
          save(partial);
          if (!this._unloaded) this.setData({ benchmarkCompleted: partial.records.length,
            benchmarkFailures: partial.records.filter(r => r.status !== 'accepted').length,
            benchmarkMessage: `完成 ${partial.records.length} 次；最新: ${record.code}` });
        }
      });
      save(report);
      if (!this._unloaded) this.setData({ benchmarkHasReport: true,
        benchmarkMessage: report.stopReason === 'FIRST_FAILURE'
          ? `已自动停止：第 ${report.summary.total} 次发现问题（${report.failures[0].code}）。请复制 JSON 报告发给我。`
          : `结束: ${report.stopReason}；成功 ${report.summary.accepted} / 失败 ${report.summary.failed}` });
      console.log('[Route Copy Benchmark] Finished:', {
        summary: report.summary, stopReason: report.stopReason, file: path
      });
    } catch (_) {
      if (!this._unloaded) this.setData({ benchmarkMessage: '自动测试未启动或遇到本地错误；请查看 Console' });
    } finally {
      this._benchmarkRunning = false;
      this._benchmarkControl = null;
      if (!this._unloaded) this.setData({ benchmarkRunning: false });
      // Record time for manual log correlation even after page exit.
      this._benchmarkFinishedAt = Date.now() - begin;
    }
  },

  stopCopyBenchmark() {
    if (this._benchmarkControl) this._benchmarkControl.stopped = true;
    this.setData({ benchmarkMessage: '正在停止；当前正在执行的请求会先结束' });
  },

  copyBenchmarkReport() {
    if (!this._benchmarkReport) return;
    wx.setClipboardData({ data: JSON.stringify(this._benchmarkReport, null, 2) });
  },

  onUnload() {
    this._unloaded = true;
    if (this._benchmarkControl) this._benchmarkControl.stopped = true;
  },

  async callHealthCheck() {
    this.setData({
      loading: true,
      status: 'idle',
      message: '',
      timestamp: '',
      errorMessage: ''
    })

    try {
      const response = await wx.cloud.callFunction({
        name: 'cloudHealthCheck'
      })

      console.log('cloudHealthCheck response:', response)

      const result = response.result

      if (!result || result.success !== true) {
        throw new Error('Unexpected response from cloudHealthCheck')
      }

      this.setData({
        status: 'success',
        message: result.message,
        timestamp: result.timestamp
      })
    } catch (error) {
      console.error('cloudHealthCheck failed:', error)

      this.setData({
        status: 'error',
        errorMessage: error.errMsg || error.message || 'Unknown error'
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  }
})