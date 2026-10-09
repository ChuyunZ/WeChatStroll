const { normalizeInput, validateCopy } = require('./route-copy-contract');
const MAX_COPY_CALLS = 8;
const COPY_SOFT_TIMEOUT_MS = 20000;
const TERMINAL_ERRORS = new Set(['COPY_UNAUTHORIZED', 'COPY_INVALID_INPUT', 'COPY_UNAVAILABLE', 'COPY_INVALID_OUTPUT',
  'COPY_QUOTA_EXCEEDED', 'COPY_QUOTA_UNAVAILABLE']);
const sessions = new Map();
let nextSessionId = 0;

function projectRoute(route, preferences, history) {
  try {
    const ids = route.routeOrder.orderedWaypointIds;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return null;
    // The editable pool includes removed stops. Only active, ordered POIs qualify.
    const pois = ids.map(id => route.pointsOfInterest.find(p => p.poiId === id));
    const payload = normalizeInput({ schemaVersion: 1,
      routeFacts: { routeType: route.routeType, returnsToStart: route.returnsToStart,
        distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds,
        durationMinutes: route.durationMinutes,
        orderedPois: pois.map((p, i) => ({ ref: `P${i + 1}`, name: p.name, category: p.category || p.type })) },
      preferences: { durationMinutes: preferences.durationMinutes, routeType: preferences.routeType,
        crowdPreference: preferences.crowdPreference, environmentPreferences: preferences.environmentPreferences },
      historicalPreferenceProfile: history || null });
    return payload ? { payload, fingerprint: JSON.stringify([ids, payload]) } : null;
  } catch (_) { return null; }
}

function requestCopy(payload) {
  // Preserve execution-state information, unlike the generic cloud error wrapper.
  return wx.cloud.callFunction({ name: 'routeCopyGenerator', data: { payload } })
    .then(response => response && response.result);
}

// Shared across questionnaire sessions. Disposal detaches callbacks but never
// releases an unfinished request. Unknown remote execution pauses this runtime.
function createScheduler() {
  let active = null, paused = false;
  const queue = [];
  function detach(job) {
    clearTimeout(job.timer);
    job.payload = null;
    job.onStart = job.onResult = job.onTimeout = null;
    job.request = null;
  }
  function pump() {
    if (active || paused || !queue.length) return;
    const job = queue.shift();
    active = job;
    job.onStart();
    job.timer = setTimeout(() => { if (job.onTimeout) job.onTimeout(); }, job.timeoutMs);
    let promise;
    try { promise = job.request(job.payload); } catch (_) { promise = Promise.reject(new Error('COPY_TRANSPORT_FAILED')); }
    // These continuations retain only the detachable job, never a Page.
    Promise.resolve(promise).then(result => settle(job, result), () => settle(job, null));
  }
  function settle(job, result) {
    const terminal = result && result.executionState !== 'unknown' && (result.success === true ||
      result.success === false && result.error && TERMINAL_ERRORS.has(result.error.code));
    if (!terminal) paused = true;
    if (job.onResult) job.onResult(result, !terminal);
    detach(job);
    active = null;
    if (paused) {
      // No more sends in this runtime; release all queued payloads/listeners.
      while (queue.length) {
        const waiting = queue.shift();
        if (waiting.onResult) waiting.onResult(null, true);
        detach(waiting);
      }
    }
    pump();
  }
  return {
    enqueue(job) {
      if (paused) { job.onResult(null, true); detach(job); return; }
      queue.push(job);
      // A task is not sent until the current rendering/confirmation stack ends.
      Promise.resolve().then(pump);
    },
    cancel(job) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      detach(job);
    },
    prioritize(job) {
      const index = queue.indexOf(job);
      if (index > 0) { queue.splice(index, 1); queue.unshift(job); }
    },
    inspect: () => ({ inFlight: Boolean(active), paused, queued: queue.length })
  };
}
const sharedScheduler = createScheduler();

function createSession({ scheduler = sharedScheduler, request = requestCopy,
  softTimeoutMs = COPY_SOFT_TIMEOUT_MS } = {}) {
  const id = `copy-session-${++nextSessionId}`;
  const entries = new Map(), bindings = new Map(), listeners = new Set();
  let disposed = false, sent = 0, version = 0, generation = 0, requestVersion = 0;
  const notify = () => {
    for (const listener of [...listeners]) {
      // A disappearing view must not break the queue or another subscriber.
      try { listener(); } catch (_) { /* Presentation failures retain fallback. */ }
    }
  };
  function stopEntry(entry) {
    if (entry.job) scheduler.cancel(entry.job);
    entry.job = null;
    entry.payload = null;
    if (entry.state === 'queued') entries.delete(entry.fingerprint);
    else if (entry.state === 'inFlight' || entry.state === 'expiredInFlight') entry.state = 'stale';
  }
  function clearBindings() {
    bindings.clear();
    for (const entry of entries.values()) if (entry.job) stopEntry(entry);
  }
  function enqueue(binding) {
    let entry = entries.get(binding.fingerprint);
    if (entry) return;
    if (sent >= MAX_COPY_CALLS || scheduler.inspect().paused) return;
    entry = { fingerprint: binding.fingerprint, payload: binding.payload, state: 'queued', copy: null, job: null };
    entries.set(entry.fingerprint, entry);
    const requestGeneration = generation;
    const currentRequestVersion = ++requestVersion;
    entry.requestVersion = currentRequestVersion;
    const job = {
      payload: entry.payload, request, timeoutMs: softTimeoutMs,
      onStart() {
        // Queued tasks are capped as well, so an eighth send cannot leave a ninth.
        sent++;
        entry.state = 'inFlight';
        entry.expiresAt = Date.now() + softTimeoutMs;
      },
      onTimeout() {
        entry.state = 'expiredInFlight';
        notify();
      },
      onResult(result, unknown) {
        if (disposed || requestGeneration !== generation || entry.requestVersion !== currentRequestVersion ||
            entries.get(entry.fingerprint) !== entry) return;
        const copy = entry.state === 'inFlight' && Date.now() < entry.expiresAt && result && result.success === true
          ? validateCopy(result.copy, entry.payload) : null;
        entry.copy = copy;
        entry.state = unknown ? 'executionUnknown' : copy ? 'accepted' : 'rejected';
        entry.payload = null;
        entry.job = null;
        notify();
      }
    };
    entry.job = job;
    scheduler.enqueue(job);
  }
  const api = {
    id,
    beginGeneration() {
      if (disposed) return;
      generation++;
      clearBindings();
      notify();
    },
    reconcile(routes, preferences, history) {
      if (disposed) return;
      const next = new Map();
      for (const route of routes) {
        const projected = projectRoute(route, preferences, history);
        if (!projected || typeof route.routeId !== 'string') continue;
        const old = bindings.get(route.routeId);
        next.set(route.routeId, { ...projected, route,
          version: old && old.route === route && old.fingerprint === projected.fingerprint ? old.version : ++version });
      }
      bindings.clear();
      for (const [key, binding] of next) bindings.set(key, binding);
      const current = new Set([...bindings.values()].map(b => b.fingerprint));
      for (const entry of entries.values()) if (!current.has(entry.fingerprint) && entry.job) stopEntry(entry);
    },
    surfaced(routes) {
      if (disposed) return;
      for (const route of routes) {
        const binding = bindings.get(route.routeId);
        if (!binding || binding.route !== route) continue;
        const queued = [...entries.values()].filter(e => e.state === 'queued').length;
        if (sent + queued < MAX_COPY_CALLS) enqueue(binding);
      }
      notify(); // Also restores a cached version, after fallback has rendered.
    },
    get(route) {
      const binding = route && bindings.get(route.routeId);
      const entry = binding && entries.get(binding.fingerprint);
      return !disposed && binding && binding.route === route && entry && entry.state === 'accepted' ? entry.copy : null;
    },
    prioritize(route) {
      const binding = route && bindings.get(route.routeId);
      const entry = binding && binding.route === route && entries.get(binding.fingerprint);
      if (entry && entry.state === 'queued') scheduler.prioritize(entry.job);
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearBindings();
      // Notify consumers once so a surviving detail cannot display a dead overlay.
      notify();
      listeners.clear();
      entries.clear();
      sessions.delete(id);
    },
    inspect: () => ({ sent, generation, disposed, bindings: bindings.size, entries: entries.size, listeners: listeners.size,
      states: [...entries.values()].map(e => e.state) })
  };
  sessions.set(id, api);
  return api;
}
function presentation(route, session, fallbackOnly = false) {
  const copy = !fallbackOnly && session && session.get(route);
  return { title: copy ? copy.title : route.title, description: copy ? copy.description : route.description,
    recommendationReason: copy ? copy.recommendationReason : route.recommendationReason, copySource: copy ? 'ai' : 'fallback' };
}
module.exports = { MAX_COPY_CALLS, COPY_SOFT_TIMEOUT_MS, projectRoute, createScheduler, createSession,
  getSession: id => sessions.get(id) || null, presentation };
