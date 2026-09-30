# AMap provider gateway (#74)

## Architecture and contracts

The Mini Program calls `amapProvider` with `action: walkingRoute` or
`action: nearbyPois`. Only this cloud function communicates with AMap. Walking
route parsing (distance, duration, polyline, environment statistics) and the POI
category/radius contracts are preserved. The three POI category queries run
sequentially through the same limiter, sharing one invocation deadline. A failed
category stops the remaining work, without background HTTP requests.

`getWalkingRoute` and `getNearbyPois` are compatibility forwarders to the gateway.
They fix the action server-side and contain neither HTTP requests nor a second
limiter. Function directories remain independently deployable.

The old client scheduler, its 400 ms interval, retry delays and obsolete tests
are removed. Route Engine still permits four logical segment requests in parallel
and deduplicates directed edges with its session Promise cache. Each segment calls
the backend once. No optimizer, validation threshold, agentic replanning, editing
UX or persistent L2 cache (#64) was changed.

## Shared state and transactions

Collection: `provider_rate_limits`, with deterministic documents:

| Document | Pacing | Cooldown |
| --- | --- | --- |
| `amap:key` | Disabled by default; independently configurable | Both services |
| `amap:walking` | Walking starts | Walking only |
| `amap:poi-around` | Every POI category request | POI only |

Each document contains `nextAllowedAtMs`, `cooldownUntilMs`, `updatedAtMs`,
`leaseOwner`, `leaseStartBeforeMs`, `leaseUntilMs`, and the database `_id`.
`leaseOwner` is a fresh random 128-bit token per acquisition, unrelated to a user,
device, location or API key. Cleared leases have a null owner and zero timestamps.
Old documents without lease fields are upgraded on write. No keys, locations,
URLs or provider payloads are stored.

Admission has two phases, followed by recording the actual HTTP start:

1. A transaction reads both applicable documents, checking cooldowns, paced
   next-start timestamps and live leases. If eligible, it atomically acquires an
   owned lease on every paced scope, without advancing `nextAllowedAtMs`.
   Blocked callers close the transaction and wait outside it. Live leases are
   polled every 100 ms because they may be released much earlier than expiry.
   Every subsequent attempt re-reads all shared state against the fixed deadline.
2. After acquisition returns, a start-gate transaction rechecks ownership and all
   cooldown/pacing state. A cooldown published while acquisition was returning
   releases the caller's lease, so it must reacquire after cooldown rather than
   hold a future reservation. After confirmation returns, the owner checks the
   queue deadline and lease start cutoff, then invokes HTTP synchronously beside
   the actual `startedAtMs` measurement. Normal 500/1500 ms commit latency does not
   invalidate an otherwise live lease.
3. While the lease still excludes competing starts, a transaction records
   `max(existing nextAllowedAtMs, startedAtMs + minIntervalMs + 2 * clockGuardMs)`
   and clears the owned lease atomically. It checks the owner of every paced scope
   before changing any of them. HTTP response completion is independent of this
   record: a slow response does not keep a successfully recorded lease locked.

The unpaced key is touched during acquisition/confirmation to fence concurrent
cooldown publication under snapshot isolation, but it gets no exclusive lease.
Walking and POI therefore keep independent start rates. Enabling key pacing gives
the key a lease too, atomically acquired/released with the service lease.

Lease start cutoff = acquisition timestamp + `leaseStartWindowMs` (default 10 s).
Lease expiry = cutoff + maximum applicable pacing interval + twice the clock guard
(default walking expiry is 11.7 s after acquisition). HTTP must never start in the
tail between cutoff and expiry. Thus a worker crashing immediately after its latest
permitted start cannot let another worker start too soon when the lease expires.
An abandoned or crashed worker leaves a bounded lease that another worker recovers
with a new owner; a late old worker cannot clear a successor's lease.

Start-record failure returns a recoverable busy result, stops provider retries,
logs `start_record_failed`, and leaves any uncommitted lease to expire. If commit
actually succeeded but its acknowledgement was lost, the persisted pacing still
protects starts. QPS feedback is still published when available. No best-effort
unlock is attempted after HTTP was sent. Only a known not-yet-started request may
release its own lease without recording a start.

Missing documents are read with `throwOnNotFound: false` and created through
transactional `doc(id).set({ data })`. Concurrent first-use initialization takes
the same conflict path as normal acquisition. Other DB errors and corrupt state
fail closed. Explicit transactions roll back on read/write/commit errors; known
transaction conflicts retry at most six times, with 1–40 ms jitter outside the
transaction. No DB error details reach the client or diagnostic logs. This retry
budget is independent of the provider attempt budget.

Reference: [CloudBase transactions](https://docs.cloudbase.net/database/transaction).
The adapter follows the installed `wx-server-sdk` 4.0.2 API; tests cover its
`{ data }` document shape, missing rows, commit/rollback and wrapped conflict
errors. Automated tests use an optimistic shared backing store, not live CloudBase.

## QPS feedback, retries and time

| AMap infocode | Meaning | Shared cooldown scope |
| --- | --- | --- |
| 10019 | Service total QPS | Current service |
| 10020 | Key + service QPS | Current service |
| 10021 | Egress IP + service QPS | Current service |
| 10022 | Key + egress IP + service QPS | Current service (conservative) |
| 10023 | Key QPS | `amap:key` |

Source: [AMap error codes](https://developer.amap.com/api/web-service/tools/info).
An egress-IP identity is not available, so no fictitious per-user/IP scope is used.
Other applications using the same key or egress outside this database boundary
are not coordinated by this limiter.

Both ordinary AMap responses and rejected HTTP responses are inspected for these
codes. Feedback publishes `max(existing, proposed)` cooldown even on the last
allowed attempt. Cooldown publication and start recording have their own bounded
5-second transaction retry windows,
so an expired queue deadline does not suppress feedback. A failed publication
stops the request. Every provider retry reacquires both scopes. Non-QPS errors
are not automatically retried and do not publish cooldowns.
The attempt limit is per physical category/route request; a successful POI
operation has three category requests, each with its own attempt counter.

Temporary provider errors have distinct meanings:

| Code | Meaning |
| --- | --- |
| AMAP_RATE_LIMITED | Recognized AMap QPS feedback (10019-10023) exhausted the provider attempt budget |
| PROVIDER_BUSY | Queue budget or bounded transaction-conflict retries exhausted |
| PROVIDER_GATEWAY_FAILED | Storage, corrupt state, configuration initialization, or unexpected gateway failure |

If a retry cannot acquire permission before the queue deadline, it returns
PROVIDER_BUSY even when earlier attempts received QPS feedback. Failed bookkeeping
or cooldown publication preserves contention as PROVIDER_BUSY; other infrastructure
failures return PROVIDER_GATEWAY_FAILED. No new HTTP attempt bypasses the limiter.

All three codes remain temporary throughout walking segments, Route Engine,
optimizer, generation/fallback, agentic planning and edit preview. They stay in
the request-local Promise cache to avoid repeated requests, but are never written
as unreachable facts into resolved segment costs. Generation stops rather than
asking AI to repair waypoints for a provider outage. Edit preview uses the same
safe service-busy message. Existing validation/business codes remain unchanged.
No internal limiter fields are added to business responses.

All coordination uses backend `Date.now()` milliseconds, never client timestamps.
Cloud Function clocks are assumed synchronized within the configured guard.
Pacing and lease safety tails add twice the guard for clock differences; cooldowns
add one guard. **The guard is not a transaction validity window or latency budget.**
Do not increase it to compensate for DB commit latency. Actual starts with default
configuration are at least about 1700 ms apart; slow DB work can make them farther
apart. A genuinely expired lease is not allowed to start HTTP and must be reacquired.
No finite expiring lease can permit arbitrarily delayed owners to start safely;
its explicit cutoff is a crash-recovery bound, not the old 100 ms latency guess.
No DB transaction can atomically send external HTTP. Confirmation is the admission
boundary: cooldown published after confirmation cannot revoke already admitted or
in-flight HTTP. A long process suspension between the final time check and network
invocation, or large clock jumps, remain outside the synchronized-clock assumption.

The queue deadline is fixed when the gateway operation starts and is shared by
all attempts/category queries. Waiting for leases, pacing, cooldown, or transaction
conflicts must fit that deadline. Once HTTP starts, its response and start record
are awaited independently of the queue deadline, so a valid in-flight response is
not rejected as queue timeout. Subsequent retries/category starts still use the
original wall-clock deadline; it is never extended by HTTP response time. An HTTP
call has its own timeout and can finish after the queue deadline. There is no durable queue or
FIFO/fairness guarantee; excess traffic receives a recoverable busy response.

## Configuration

Only `amapProvider` needs `AMAP_API_KEY` (a server Web Service key). Configuration
is read from server environment variables and validated in `config.js`. Defaults
are conservative development choices, **not documented production quota facts**.

| Variable | Default | Allowed values |
| --- | --- | --- |
| `AMAP_WALKING_MIN_INTERVAL_MS`, `AMAP_POI_MIN_INTERVAL_MS` | 1500 | 1–60000 ms |
| `AMAP_WALKING_MAX_QUEUE_WAIT_MS`, `AMAP_POI_MAX_QUEUE_WAIT_MS` | 12000 | 1–60000 ms |
| `AMAP_WALKING_MAX_ATTEMPTS`, `AMAP_POI_MAX_ATTEMPTS` | 2 | 1–4 |
| `AMAP_WALKING_COOLDOWN_MS`, `AMAP_POI_COOLDOWN_MS` | 3000 | 1–60000 ms; multiplied by attempt |
| `AMAP_KEY_MIN_INTERVAL_MS` | 0 (unpaced) | 0–60000 ms |
| `AMAP_CLOCK_GUARD_MS` | 100 | 0–5000 ms |
| `AMAP_LEASE_START_WINDOW_MS` | 10000 | 1000–60000 ms; crash recovery start cutoff, not a pacing interval |
| `AMAP_REQUEST_TIMEOUT_MS` | 10000 | 1–60000 ms |

Verify intervals against the AMap account/service quota and observed sanitized
timings/error codes. Keep all live revisions using consistent configuration.
One environment currently represents one AMap key. Sharing a key across multiple
CloudBase environments requires a shared gateway/state boundary. Multiple keys
would require explicit, non-secret scope IDs; that is outside this change.

## Deployment sequence (manual)

1. In the target WeChat CloudBase environment, create the document collection
   **`provider_rate_limits`**. Set custom security rules to
   `{ "read": false, "write": false }` for Mini Program/client access; the trusted
   cloud function uses its server privileges. Verify server read/write/transaction
   access. Do not manually create the three rows. Do not add TTL expiry or clear
   limiter rows during live traffic.
2. Upload/deploy `cloudfunctions/amapProvider` with cloud dependency installation
   (`package.json` and lockfile included). Configure `AMAP_API_KEY` and desired
   limits. For defaults, set the cloud function execution timeout to **60 seconds**
   and ensure caller transport timeouts can accommodate a queue plus HTTP response.
   If increasing limits, recalculate these timeouts and cloud concurrency/cost.
3. Deploy both legacy forwarding functions before releasing the new Mini Program.
   They require permission to invoke `amapProvider` in the same environment and a
   compatible timeout. Remove their obsolete key environment variables. Drain old
   in-flight revisions during cutover: an old deployed direct-caller revision can
   still bypass coordination until it is gone. Test both forwarders.
4. Release the Mini Program, which now calls `amapProvider` directly. Keep the
   forwarders while older clients exist; delete them only after those clients are
   retired. Roll back to forwarders/gateway-compatible versions, not independent
   AMap callers. Do not reset shared state as a rollback step.
5. Run the scenarios below in a development environment before production release.
   The collection/permissions, cloud deployment, account quotas and live behavior
   cannot be verified by local Jest tests.

### Deploying the slow-transaction fix

Re-upload the **whole `cloudfunctions/amapProvider` directory**; runtime changes
are in `limiter.js`, `provider.js`, and `config.js`. Dependencies and the database
collection are unchanged. No document recreation or manual schema migration is
needed. The old `nextAllowedAtMs`/cooldown values remain valid.

Drain old gateway invocations/revisions before routing traffic to the lease
version. The previous limiter does not understand leases and may overwrite their
fields, so mixed old/new gateway versions are unsafe. Existing legacy forwarders
and the Mini Program do not need another upload for this fix. Keep the existing
100 ms clock guard; the new lease window has a default and needs no environment
change for this smoke test. Verify the function timeout still allows queue time,
HTTP timeout and bounded record/feedback work (60 s for default configuration).

Repeat a single walking request first: expect exactly one `provider_start` and a
normal route response, even when transactions exceed 100 ms. Then test concurrent
walking requests and a POI query; compare actual start times across all instances.
Check that lease fields clear after recorded starts, or expire/recover after an
interrupted worker. Never clear rows or shorten a live lease to speed up recovery.

### Legacy forwarding deployment

Deploy both getWalkingRoute and getNearbyPois **with dependency installation**.
Each function pins @cloudbase/node-sdk 3.17.2 in its own package and lockfile.
Keep their execution timeout at **80 seconds**, above the explicit 60-second
nested SDK timeout and independent 65-second forwarding watchdog.

The wrappers use the current CloudBase environment and runtime credentials.
SDK retries and keepalive are disabled; callbackWaitsForEmptyEventLoop is false.
The watchdog is cleared on completion and does not cancel an already-running
child. Neither wrapper calls AMap directly or retries the gateway.

Valid child business results, including all temporary provider failures, pass
through unchanged. Malformed results and actual wrapper transport/infrastructure
failures return PROVIDER_GATEWAY_FAILED without exposing raw exceptions.

Only three diagnostic events are emitted: forward_start (target, action,
transport and numeric timeout configuration), forward_return (success boolean),
and forward_failed (fixed sanitized failure category). No heartbeat or stage
tracking is needed. Never log coordinates, request/result payloads, POIs, routes,
URLs, API keys, raw errors or the CloudBase context.

In the CloudBase console, enable **Enable synchronous testing** when inspecting
the returned business result. Asynchronous testing can show an apparent failure
even when the parent function succeeds. Verify the parent's final report and
business result in the Logs page; a child's success or a partial test-panel log
alone does not establish the parent's outcome.

After deploying the refined error contract, verify the Mini Program end to end,
both legacy wrappers, and safe service-busy feedback. Deploy the Mini Program's
temporary-error handling before exposing the new gateway error codes to clients.

## Manual verification and single-developer diagnosis

Generate a route with several waypoints, request more candidates, edit the route,
and simultaneously generate another route in a second device/session. Include a
new POI search. Old behavior combined session-local schedules, three parallel POI
queries and client retries; multiple cloud instances can also share egress IPs.
These are plausible burst sources even for one developer; 10021 is not proof of
a user-specific quota, and its exact cause requires deployment observations.

Filter cloud logs by `[AMap Provider]` and `provider_start`. Aggregate **all cloud
instances and both legacy/direct entrypoints**, sort `startedAtMs` per scope and
verify spacing. Inspect `waitMs`, `attempt`, `transaction_conflict` /
`transactionAttempt`, `rate_limited` / `infocode`, `shared_cooldown` /
`cooldownUntilMs` / `cooldownMs`, and `queue_deadline_exceeded`. Lease diagnostics
are `lease_wait`, `lease_recovered`, `lease_start_expired`, and `start_record_failed`.
`lease_start_expired` indicates the explicit crash-recovery start window elapsed;
it is unrelated to the 100 ms clock guard. The old `stale_acquisition` event has
been removed. Its repetition in the first deployed smoke test was an admission
bug: committed slots were repeatedly discarded before any AMap HTTP request.
`acquisition_failed` / `cooldown_failed` / `gateway_unavailable` require checking
DB access, contention or config; do not add client retries.

Verify independent walking/POI pacing, cooldown monotonicity, no gateway bypass,
and usable route/POI results. In a development environment only, temporarily set
a very long service interval plus a short queue deadline, make a second request,
and verify busy returns without a second provider start; restore configuration
and let the existing deadline expire. Inspect naturally occurring QPS feedback
for shared cooldown behavior; do not deliberately overload the production key.
If 10021 persists, inspect the actual service/IP quota, other callers using the
same key/egress, configured spacing, and shared cooldown before reducing the rate.

Diagnostic records contain operation/scope/timing/counts/known QPS categories
only. Never add coordinates, keys, URLs, axios configs or raw payloads to logs.

## Local verification

Run `npm test` (`npm.cmd test` in restricted PowerShell), `git diff --check`,
`git diff --stat`, and `git status --short`. New tests cover independent workers,
multi-user contention/initialization, hierarchical pacing, all five QPS codes,
late cooldown rechecks, monotonic publication, retries/deadlines, DB conflicts,
fail-closed errors, 500/1500 ms transactions and slow acknowledgements, actual-start
spacing across independent clients, live-lease exclusion, crash/expiry recovery,
late finalizer ownership, record failure, in-flight completion beyond queue deadline,
clock skew, safe diagnostics, gateway/legacy integration,
three-category POI pacing, logical concurrency and session L1 deduplication.
Original walking/POI parser tests now live beside the gateway adapters.
All automated provider requests are mocked; no real AMap calls are made.
