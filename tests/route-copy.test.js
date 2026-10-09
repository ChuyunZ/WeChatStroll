const { createSession, createScheduler, getSession, presentation } = require('../miniprogram/services/route-copy');
const { preferences, history, copy, route, deferred, flush } = require('./helpers/route-copy');
let live;
beforeEach(() => { jest.useFakeTimers(); live = []; });
afterEach(() => { live.forEach(s => s.dispose()); jest.useRealTimers(); });
function setup(request = jest.fn().mockResolvedValue({ success: true, copy }), scheduler = createScheduler()) {
  const session = createSession({ request, scheduler }); live.push(session);
  return { session, request, scheduler };
}
function surface(session, routes = [route()]) {
  session.reconcile(routes, preferences, history); session.surfaced(routes); return routes;
}
test('successful overlay preserves business identity, data and caches same facts once', async () => {
  const { session, request } = setup(), r = route(), original = JSON.stringify(r);
  surface(session, [r]); await flush();
  expect(session.get(r)).toEqual(copy);
  expect(presentation(r, session).copySource).toBe('ai');
  expect(JSON.stringify(r)).toBe(original);
  surface(session, [r]); await flush(); expect(request).toHaveBeenCalledTimes(1);
  expect(session.inspect().sent).toBe(1);
});
test('terminal failures retain fallback, consume budget and are not retried', async () => {
  const { session, request } = setup(jest.fn().mockResolvedValue({ success: false, error: { code: 'COPY_INVALID_OUTPUT' } }));
  const [r] = surface(session); await flush(); surface(session, [r]); await flush();
  expect(session.get(r)).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  expect(session.inspect().sent).toBe(1); expect(presentation(r, session).copySource).toBe('fallback');
});
test('invalid success copy is rejected without affecting queue', async () => {
  const { session, scheduler } = setup(jest.fn().mockResolvedValue({ success: true, copy: { ...copy, extra: 1 } }));
  const [r] = surface(session); await flush(); expect(session.get(r)).toBeNull();
  expect(scheduler.inspect()).toEqual({ inFlight: false, paused: false, queued: 0 });
});
test('single concurrency, stable order and detail priority', async () => {
  const pending = [], request = jest.fn(() => { const p = deferred(); pending.push(p); return p.promise; });
  const { session, scheduler } = setup(request);
  const routes = [1, 2, 3].map(i => route(`r${i}`, { distanceMeters: 1800 + i }));
  surface(session, routes); await flush();
  expect(request).toHaveBeenCalledTimes(1); expect(scheduler.inspect().queued).toBe(2);
  session.prioritize(routes[2]); pending[0].resolve({ success: true, copy }); await flush();
  expect(request.mock.calls[1][0].routeFacts.distanceMeters).toBe(1803);
  pending[1].resolve({ success: true, copy }); await flush();
  expect(request.mock.calls[2][0].routeFacts.distanceMeters).toBe(1802);
  pending[2].resolve({ success: true, copy }); await flush();
});
test('initial, progressive, add/replace and edit all share eight sends; retry keeps budget', async () => {
  const { session, request } = setup();
  for (let i = 0; i < 10; i++) {
    surface(session, [route('same-id', { distanceMeters: 1800 + i })]); await flush();
  }
  expect(request).toHaveBeenCalledTimes(8); expect(session.inspect().sent).toBe(8);
  session.beginGeneration(); surface(session, [route('retry', { distanceMeters: 9999 })]); await flush();
  expect(request).toHaveBeenCalledTimes(8);
});
test('a large queued batch cannot reserve more than remaining budget', async () => {
  const { session, request } = setup();
  surface(session, Array.from({ length: 12 }, (_, i) => route(`r${i}`, { distanceMeters: 2000 + i })));
  await flush(); await flush();
  expect(request).toHaveBeenCalledTimes(8);
});
test('cancelled queued request does not spend budget', async () => {
  const p = deferred(), { session, request } = setup(jest.fn(() => p.promise));
  const r1 = route(), r2 = route('r2', { distanceMeters: 1999 });
  surface(session, [r1, r2]); await flush();
  session.reconcile([r1], preferences, history);
  p.resolve({ success: true, copy }); await flush();
  expect(request).toHaveBeenCalledTimes(1); expect(session.inspect().sent).toBe(1);
});
test('same route ID with a new fingerprint ignores late old text and requests its own copy', async () => {
  const a = deferred(), b = deferred();
  const { session, request } = setup(jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
  const old = route(), edited = route('route-1', { distanceMeters: 1999 });
  surface(session, [old]); await flush(); surface(session, [edited]); await flush();
  expect(session.get(edited)).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  a.resolve({ success: true, copy }); await flush();
  expect(session.get(old)).toBeNull(); expect(session.get(edited)).toBeNull();
  const next = { ...copy, title: '再给心情留一点空白' };
  b.resolve({ success: true, copy: next }); await flush(); expect(session.get(edited)).toEqual(next);
});
test('restoring a fully identical accepted version uses session cache; ranking does not regenerate', async () => {
  const { session, request } = setup(), original = route();
  surface(session, [original]); await flush();
  const edited = route('route-1', { distanceMeters: 2000 });
  surface(session, [edited]); await flush();
  const restored = route(); surface(session, [restored]); await flush();
  expect(session.get(restored)).toEqual(copy); expect(request).toHaveBeenCalledTimes(2);
});
test('UI soft timeout keeps concurrency occupied until actual completion, drops late copy', async () => {
  const a = deferred(), b = deferred();
  const { session, scheduler, request } = setup(jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
  const rs = [route(), route('r2', { distanceMeters: 2000 })]; surface(session, rs); await flush();
  jest.advanceTimersByTime(20000); await flush();
  expect(session.inspect().states).toContain('expiredInFlight');
  expect(session.get(rs[0])).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  expect(scheduler.inspect().inFlight).toBe(true);
  a.resolve({ success: true, copy }); await flush();
  expect(session.get(rs[0])).toBeNull(); expect(request).toHaveBeenCalledTimes(2);
  b.resolve({ success: true, copy }); await flush(); expect(session.get(rs[1])).toEqual(copy);
});
test('suspended app timers cannot accept a result after its wall-clock deadline', async () => {
  const p = deferred(), { session } = setup(jest.fn(() => p.promise));
  const [r] = surface(session); await flush();
  jest.setSystemTime(Date.now() + 21000); // no timer callbacks dispatched
  p.resolve({ success: true, copy }); await flush();
  expect(session.get(r)).toBeNull(); expect(session.inspect().states).toEqual(['rejected']);
});
test('one broken view listener cannot strand the queue or block other views', async () => {
  const { session, scheduler } = setup();
  session.subscribe(() => { throw new Error('view disappeared'); });
  const listener = jest.fn(); session.subscribe(listener);
  const [r] = surface(session); await flush();
  expect(session.get(r)).toEqual(copy); expect(listener).toHaveBeenCalled();
  expect(scheduler.inspect()).toEqual({ inFlight: false, queued: 0, paused: false });
});
test.each(['transport', 'server', 'malformed'])('unknown %s execution pauses this runtime across sessions', async kind => {
  const request = jest.fn(() => kind === 'transport' ? Promise.reject(new Error('network')) : Promise.resolve(kind === 'server'
    ? { success: false, error: { code: 'COPY_EXECUTION_UNKNOWN' }, executionState: 'unknown' } : undefined));
  const { session, scheduler } = setup(request);
  surface(session, [route(), route('r2', { distanceMeters: 2000 })]); await flush();
  expect(scheduler.inspect()).toEqual({ inFlight: false, paused: true, queued: 0 });
  const next = setup(request, scheduler).session; surface(next); await flush();
  expect(request).toHaveBeenCalledTimes(1); expect(next.inspect().sent).toBe(0);
});
test('disposal clears listeners, registry, payloads and timers, but old call still occupies global slot', async () => {
  const p = deferred(), { session, scheduler, request } = setup(jest.fn().mockReturnValueOnce(p.promise).mockResolvedValue({ success: true, copy }));
  const listener = jest.fn(); session.subscribe(listener); surface(session); await flush();
  session.dispose(); listener.mockClear();
  expect(getSession(session.id)).toBeNull();
  expect(session.inspect()).toMatchObject({ bindings: 0, entries: 0, listeners: 0, disposed: true });
  expect(jest.getTimerCount()).toBe(0); expect(scheduler.inspect().inFlight).toBe(true);
  const next = setup(request, scheduler).session; const [r] = surface(next); await flush();
  expect(request).toHaveBeenCalledTimes(1);
  p.resolve({ success: true, copy }); await flush();
  expect(listener).not.toHaveBeenCalled(); expect(next.get(r)).toEqual(copy);
});
test('new generation invalidates in-flight response without replenishing budget', async () => {
  const p = deferred(), { session, request } = setup(jest.fn().mockReturnValueOnce(p.promise).mockResolvedValue({ success: true, copy }));
  const [old] = surface(session); await flush(); session.beginGeneration();
  const [next] = surface(session, [route('new', { distanceMeters: 2100 })]);
  p.resolve({ success: true, copy }); await flush();
  expect(session.get(old)).toBeNull(); expect(session.get(next)).toEqual(copy);
  expect(session.inspect().sent).toBe(2); expect(request).toHaveBeenCalledTimes(2);
});

test.each(['COPY_QUOTA_EXCEEDED', 'COPY_QUOTA_UNAVAILABLE'])('terminal server quota %s retains fallback without pausing scheduling', async code => {
  const { session, scheduler, request } = setup(jest.fn().mockResolvedValue({
    success: false, error: { code }
  }));
  const routes = [route(), route('r2', { distanceMeters: 2100 })];
  surface(session, routes); await flush();
  expect(request).toHaveBeenCalledTimes(2);
  expect(session.get(routes[0])).toBeNull();
  expect(scheduler.inspect()).toEqual({ inFlight: false, paused: false, queued: 0 });
});
