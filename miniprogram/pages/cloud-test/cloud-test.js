const { generateCases, runBenchmark, MAX_SENDS } = require('../../services/route-copy-benchmark');
const { loadBenchmarkPoiPool } = require('../../services/route-copy-poi-source');

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
    const dataset = event && event.currentTarget && event.currentTarget.dataset;
    const audit100 = dataset && dataset.audit === '100';
    const minutes = audit100 ? 60 : Number(dataset && dataset.minutes);
    if (![30, 60].includes(minutes)) return;
    let platform = '';
    try { platform = wx.getSystemInfoSync().platform; } catch (_) { /* fail closed */ }
    if (platform !== 'devtools') {
      this.setData({ benchmarkMessage: '仅允许在微信开发者工具运行' }); return;
    }
    // Start immediately from Cloud Test after compiling the mini program.
    // No Routes Page or route-validation success is required.
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
      benchmarkFailures: 0,
      benchmarkMessage: this._benchmarkPoiPool
        ? '复用本页内存中的腾讯 POI 池，准备文案测试…'
        : '正在获取定位和腾讯地图 POI（仅一次），不生成步行路线…',
      benchmarkFile: path, benchmarkHasReport: false });
    try {
      const poiPool = this._benchmarkPoiPool || await loadBenchmarkPoiPool();
      if (control.stopped || this._unloaded) {
        if (!this._unloaded) this.setData({ benchmarkMessage: '已停止，未发起 AI 文案测试' });
        return;
      }
      this._benchmarkPoiPool = poiPool; // only sanitized {name, category}
      const seed = Date.now();
      const cases = generateCases({ poiPool, seed, count: MAX_SENDS });
      if (!cases.length) {
        this.setData({ benchmarkMessage: '腾讯 POI 池无符合文案契约的数据；未发送 AI 请求' });
        return;
      }
      this.setData({ benchmarkMessage: audit100
        ? `已准备 ${poiPool.length} 个真实 POI；100 次验收开始，第二次文案拒绝即 FAIL`
        : `已准备 ${poiPool.length} 个真实 POI；首次文案失败即停止` });
      const report = await runBenchmark({
        minutes, cases, audit100, seed,
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
        benchmarkMessage: report.audit
          ? `100 次验收：${report.audit.verdict}，已测 ${report.audit.assessed}/100，文案拒绝 ${report.audit.acceptanceFailures}，停止原因 ${report.stopReason}`
          : report.stopReason === 'FIRST_FAILURE'
          ? `已自动停止：第 ${report.summary.total} 次发现问题（${report.failures[0].code}）。请复制 JSON 报告发给我。`
          : `结束: ${report.stopReason}；成功 ${report.summary.accepted} / 失败 ${report.summary.failed}` });
      console.log('[Route Copy Benchmark] Finished:', {
        summary: report.summary, stopReason: report.stopReason, file: path
      });
    } catch (error) {
      // Never display/log raw location, provider responses or exception text.
      if (!this._unloaded) {
        const code = error && error.code;
        const locationIssue = ['PERMISSION_DENIED', 'LOCATION_TIMEOUT',
          'LOCATION_FAILED', 'BENCHMARK_LOCATION_INVALID'].includes(code);
        const empty = code === 'BENCHMARK_POI_EMPTY';
        this.setData({ benchmarkMessage: locationIssue
          ? '定位不可用：请检查开发者工具的模拟位置和定位权限，未发送 AI 请求'
          : empty
            ? '腾讯地图未返回可用 POI：请换一个模拟位置再试，未发送 AI 请求'
            : '腾讯 POI 获取失败或测试初始化异常；未发送新的 AI 测试请求' });
      }
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
    // POI names are only kept within this page instance, not persisted.
    this._benchmarkPoiPool = null;
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