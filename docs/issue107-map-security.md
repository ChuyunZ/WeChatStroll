# #107 Map Provider security and coupled quotas

This is a local implementation and operator runbook, not a deployment record.
AI and Track Provider logic is outside this change. No provider credentials,
environment variables, console limits or online collections were changed.

## Contract and authorization

`mapProvider.nearbyPois` accepts `{ latitude, longitude, radius, requestId }`.
`requestId` is a 16–100 character alphanumeric/underscore/hyphen identifier,
generated once per logical invocation. The existing three categories and radius
clamp are unchanged. A nonempty successful response additionally returns
`planningToken` and `planningExpiresAt`.

`walkingRoute` requires `{ start, destination, planningToken, requestId }`.
`closePlanning` accepts `{ planningToken }` and releases unused capacity.
No raw Walking endpoint exists outside these checks.

Direct identity comes exclusively from `getWXContext().APPID/OPENID`. Client
OPENID/userId/ownerKey fields have no authority. Stored owners are SHA-256 of
`JSON.stringify([APPID, OPENID])`. A domain-tagged HMAC-SHA256 token binds the
owner, random session ID, quota day, absolute expiry, declared origin and exact
six-decimal coordinate allowlist returned by Explore. Both Walking endpoints
must be members. Six decimals match the existing outgoing Tencent formatting.
This authorizes a declared planning area, not proof of physical GPS presence or
proof that the user followed the UI. An authenticated malicious user can still
consume their bounded share through legitimate authorized points.

The database stores only owner hashes, counters, random session IDs, expiry,
scope/request digests and attempt receipts. It stores no POI IDs/names,
coordinates, provider responses, polylines or tokens. Discovery request digests
include the owner and random request identifier; Walking digests include the
random session/request identifiers. Credentials live in client WeakMaps and
resolver closures, never in POIs, page `data`, AI payloads, Route, Walk, History
or recovery snapshots. Existing authorized active-Walk device recovery is unchanged.

Use a separate high-entropy `MAP_PLANNING_SECRET` (at least 32 bytes), configured
only on the gateway and both wrappers through operator-managed secrets. Never
reuse the Tencent secret. The required `MAP_QUOTA_OFFSET_MINUTES` and
`MAP_QUOTA_ACTIVE_FROM_MS` values must be nonempty, canonical base-10 integer
strings (no whitespace, exponent, hex or plus prefix), within the enforced
numeric ranges. Invalid or missing values fail closed instead of silently
selecting UTC/epoch zero. Rotation invalidates active planning credentials;
displayed routes and active Walks remain usable. Do not log invocation payloads,
tokens, secret material or provider URLs, including platform debug/event logging.

### Chosen daily accounting reset: 09:00 Beijing (operator policy)

Tencent support (2026-10-11) confirmed the WebService daily allotment resets
once per day but **could not confirm the exact time or timezone**. For this
project we choose **09:00 Asia/Shanghai (UTC+08:00)** as the *internal*
Explore/Walking daily ledger boundary, **not as a statement about Tencent's
billing cycle**. It is 01:00 UTC; with the existing calculation
`floor((nowMs + offsetMinutes * 60000) / 86400000)`, configure
`MAP_QUOTA_OFFSET_MINUTES=-60` (**not** `480`). Both services share one
`map_planning_quotas` calendar and therefore one boundary:

- Beijing 08:59:59 remains in the previous internal quota day.
- Beijing 09:00:00 begins the next internal quota day with fresh local
  physical-usage, reservation and record-creation counters. Existing usage
  remains in the old ledger; it is never deleted/reset to force admission.
- A Planning Session expires by its original ledger boundary and cannot move
  its unused Explore/Walking holds into the next day. New sessions are rejected
  during the final 60 seconds of a quota day.
- Tencent 120 still uses shared key-wide short cooldown and bounded retry.
  Tencent 121 terminates the current request without retry and publishes a
  shared `tencent:key` cooldown through the **next 09:00 Beijing boundary**.
  This blocks new physical sends from both Explore and Walking across instances
  (but cannot revoke starts already admitted before the feedback commit).
  New attempts after that boundary still go through normal admission; if the
  first Tencent response is 121 again, the same block renews for another
  internal day. Blocked calls return `PROVIDER_BUSY`; the triggering
  121 returns `PROVIDER_QUOTA_EXHAUSTED`. No local reset guarantees Tencent
  availability or changes its actual provider billing cycle.

**Activation/migration:** The offset is part of the persisted `calendar`
contract. `MAP_QUOTA_OFFSET_MINUTES`, `MAP_QUOTA_ACTIVE_FROM_MS` and the
seeded `calendar` must exactly agree. Never change only the environment
variable on an already activated quota calendar: mismatches fail closed with
`MAP_QUOTA_NOT_READY`. For a different existing offset, stop new planning,
drain in-flight operations, preserve old documents and reconcile a new
activation boundary under an independently reviewed maintenance plan. Do not
overwrite today's live ledger or fabricate zero historical usage. Keep all
same-Key consumers under the same single ledger. Do not make any CloudBase
configuration/database/deployment changes as part of this code-only change.

## Accounting and capacity decision

| Physical HTTP attempts | User/day | Global/day |
| --- | ---: | ---: |
| Explore | 9 | 180 |
| Walking | 270 | 5400 |

All active holds count against both limits. A transaction admits a discovery
only when it can reserve **3 Explore and 90 Walking together**, plus the
record-creation capacity to produce three Explore attempt receipts and 90 each
of Walking logical-request records and attempt receipts. The three
Explore requests and each status-120 retry convert holds into used attempts;
retry capacity beyond three is acquired from unreserved capacity. Empty or
failed discovery releases unused holds after all category tasks settle.

Walking consumes its protected base hold and corresponding request/receipt
creation holds, then atomically extends **one physical attempt at a time**
if both physical and record budgets permit. Creation holds are released on
close/expiry; used record counts are never refunded. Repeated never-sent
attempts can consume extra creation budget, so a base reservation is not a
promise of 90 successful HTTP responses. No fixed 540-attempt buffer is
withheld. Candidate complexity is not trusted as authority to enlarge a budget.

Evidence and tradeoff:

- The existing four-waypoint prefetch uses 16 directed edges for point-to-point,
  20 for loop/out-and-back. The existing five-candidate fixture reaches 94 logical
  requests despite cache reuse; these are synthetic cases, not average traffic.
- With the default two provider attempts, that same successful-edge pattern can
  require 188 physical starts. A configured four-attempt policy can require 376,
  exceeding the user daily 270 cap. Finite limits cannot preserve every possible
  unbounded manual-edit/replanning sequence.
- Pure capacity arithmetic: 5400 accommodates 60 bases of 90, at most 57 plans
  each using 94, or 28 each using 188, before considering Explore retries,
  per-user limits, existing usage, failures or unused holds.
- A fixed buffer of 540 would cut base admissions to 54 without proving enough
  expansion capacity: 54 plans needing 188 would require 10,152 attempts.
- Simulated transactions admit exactly 60 distinct 90-attempt bases, reject a
  61st, protect the first user's 90, and reject its 91st until another hold is
  released. The first user can then reach 94 without stealing any remaining hold.

**Admission protects base capacity; it does not guarantee enough expansion or a
successful route.** A later admission can occupy previously unreserved extension
capacity. An expansion-priority policy would reduce new admissions and requires
real, privacy-safe aggregate usage evidence; no such policy is claimed here.
Existing route quality, directed-edge Promise cache, ordering, scoring and
deterministic correction budgets are unchanged.

### Nonrefundable record creation budgets (P0-2)

The daily ledger also contains `creations`: global and per-owner `requests` and
`attempts` counters, each split into Explore and Walking. A new record and its
counter increment commit in the **same transaction**. The limits apply separately
to each of those two record types:

| Record creations, per type | User/day | Global/day |
| --- | ---: | ---: |
| Explore | 18 | 360 |
| Walking | 540 | 10,800 |

These are twice the corresponding physical HTTP ceilings: one complete day's
normal traffic plus equal headroom for queue failures/confirmed unsent refunds.
A successful logical request needs at most one request record; a physical
attempt needs one receipt. Internal 120 retries create receipts, not new logical
claims. Thus normal requests that fit the 270/5400 HTTP limits also fit these
creation limits, including the 94/188 capacity fixtures, edits and candidates.
Pathological repeated queue failures eventually stop; unlimited free retries
would defeat the bound. New discoveries are refused up front if the remaining
request/receipt budget cannot cover their 90-Walking base, including other
sessions' creation holds. Each accepted base protects those records from
competing sessions; used receipts and requests are irreversibly counted. This
is a bounded failure allowance, not a guarantee of successful completion or a
measured optimal traffic policy.

`claim()` checks the live signed session, existing request identity, remaining
hold or extensible physical capacity, its own reserved receipt/request creation
slots or unreserved headroom **before** writing. Existing claims remain `MAP_EXECUTION_UNKNOWN`, never replay
HTTP. `begin()` reserves the full base receipt/request headroom atomically, then
counts discovery creation; unused close/reopen loops cannot reset spent
records. `debit()` counts receipts before granting HTTP permission. Close,
expiry and refund never decrement creation counters. Every owner shares them
across all sessions and instances; random IDs do not increase the budget.

Rejected quota/creation/replay transactions commit no writes. Concurrent accepted
claims can still compete for the last physical attempt; final debit enforces the
HTTP ceiling and a losing claim stays conservatively consumed. Unknown commit
acknowledgements likewise never reset counts or authorize unconfirmed HTTP.

Per day, at most **22,320 new request/attempt documents globally**:
`2 * (360 + 10,800)`; at most **1,116 per owner**. Add one daily ledger and the
singleton calendar. Actual pruning/refunds update existing records but cannot
enlarge this creation bound. No-op close/refund/sweep no longer rewrites an
unchanged ledger. Denied requests and repeated closes still cost
function invocations, reads and transaction work: **this does not eliminate DoS**.
The existing limiter protects Tencent sends and is downstream of claim; it is
not an ingress limiter. Before release, assess a platform-enforced authenticated
invocation rate/concurrency limit (including wrappers), validate normal parallel
segment bursts and queue latency, and alarm on rejection/transaction volume.
Do not trust a client-provided owner/IP or add per-random-ID throttle documents.
In-process throttling alone cannot enforce multi-instance limits. No unverified
platform setting or new online ingress policy was applied in this local repair.

## Transactions, QPS, expiry and unknown outcomes

`map_planning_quotas` is separate from `provider_rate_limits`. A single daily
ledger atomically contains global usage, per-user usage and active reservations;
request/attempt documents participate in the same CloudBase transactions.
The ledger serializes contention at this small configured daily scale. Only
explicit transaction conflicts retry, with bounded jitter. Database failures
and uncertain commit acknowledgements fail closed.

Authenticated `closePlanning` is independent of Tencent API credentials and
the provider/QPS `loadLimits()` configuration. Missing Tencent keys or invalid
provider pacing settings therefore cannot trap unused reservations; owner,
signed token, planning configuration and quota-store checks are still required.
Discoveries and Walking continue to reject invalid Tencent configuration.

The transaction compares the validated resulting ledger with its original JSON
snapshot and writes only on an actual change or first initialization. It still
reads the ledger inside the transaction, preserving conflict detection and
atomicity. The first close deletes the remaining reservation; a repeated close
of a missing session succeeds without any ledger/document write. If genuinely
expired reservations are pruned during that transaction, that one real change
is persisted; subsequent no-op closes do not rewrite it. Creation counters and
used attempts are never released by close. Calendar high-water advancement and
new-day initialization retain their existing rules. An internal late close of
an already removed old-day session does not touch the current-day ledger; public
expired tokens continue to fail authorization.

This fixes unbounded **no-op ledger writes**, not unbounded reads or transaction
invocations. The 1000-close regression observes 1000 successful read-only
transactions with zero writes after the first close. Ingress protection remains
a release prerequisite; the downstream Tencent QPS limiter does not provide it.

The existing QPS lease is acquired **before charging**. A committed debit then
precedes final QPS confirmation and synchronous HTTP invocation. Slow debit or
queue/lease/session expiry that definitely prevents invocation refunds through
an idempotent attempt receipt. The start timestamp still sits next to HTTP;
no awaited quota work occurs between them. A lost debit acknowledgement sends
no HTTP but may conservatively retain a charge. Invoked HTTP, including timeout,
120, 121 and unknown network outcomes, is never refunded. This is a safe upper
bound on possible starts, not exact provider billing reconciliation.

### Close versus a pre-debited Walking request

Close stops **new quota admissions**, not an already granted single-attempt
permit. Debit and close serialize on the same day ledger. If close commits first,
debit cannot find a live session and fails; if the confirmed debit commits first,
that in-flight attempt may start even when close commits before final QPS
confirmation. Its endpoints/owner were authorized before debit, and its permit
is internal to that execution, not a reusable client credential. Close releases
only the unused hold, preserving this already-used attempt.

The permitted attempt must still pass QPS ownership/cooldown confirmation, the
queue deadline, lease start window and permit/session/day expiry checks. No
additional awaited quota read was inserted between final confirmation and the
timestamp/HTTP invocation. QPS fencing, cooldown conflict detection and lease
safety tails are unchanged. If a stale lease or cooldown prevents HTTP, the
never-sent attempt can be refunded exactly once even after close, without
resurrecting the session or refunding receipt creation capacity. Once HTTP is
invoked, success, timeout or failure keeps the charge. A status-120 retry needs
a new debit and therefore cannot send after close; new logical claims also fail.

Reproducible tests pause the actual mock CloudBase QPS confirmation transaction
at `beforeCommit`, after a confirmed quota debit and before any HTTP. A second
operation closes the session, then the test resumes confirmation. Cases verify
one allowed/charged send, a blocked 120 retry, no send with a safe refund on lease expiry,
and concurrent cooldown publication causing a transaction conflict and no send.
The limiter is not mocked out or weakened to obtain these results.

Each logical request is claimed once. Duplicate IDs return
`MAP_EXECUTION_UNKNOWN`, even if the first request completed: no route response
is persisted to replay. A client must not automatically issue a fresh request ID
to hide an unknown result. Explicit new operations can spend additional quota.
The existing Promise cache prevents automatic same-edge storms within a session.
Each server-side 120 retry has a separately charged attempt. 121 never retries.

Default session lifetime is **two hours**, configurable from one minute to four
hours. This covers the minutes-scale generation and an editing interval without
equating a 120-minute Walk with a 120-minute planning operation. There is no
automatic renewal or replay-based extension. At expiry, new HTTP is denied;
existing routes/cache hits/active Walk/Feedback/History/recovery remain usable.
Each generation owns a `createPlanningRun()` until a successful route is adopted.
Discovery credentials are captured before response validation. Empty POIs,
AI+fallback failure, exceptions and cancellation release them even when no
`routePlanningSession` is returned. Page unload/replacement cancels pending work;
late discovery captures immediately close their token and cannot restart work.
Only an adopted successful session is detached from the run and retained for
candidate filling, additions, replacements and editing. Standalone generation
callers own and must release a returned successful session.

During reload, the previous displayed session is retained privately until the
replacement succeeds or definitively fails. A quota/request-budget refusal
restores it; overlapping reloads share that retained state. A stale result cannot
take ownership. Unload closes both retained and pending credentials. Duplicate
closes share one promise; failed close has one bounded retry, including a lost
acknowledgement. Failures cannot mask the generation result. The gateway also makes a best-effort
server-side release if an accepted discovery throws before the token is
delivered (including a failed/uncertain ready transaction); failed cleanup
and an unknown initial admission still rely on session expiry. This release
does not refund HTTP attempts or record creations. New resolver calls
stop on cancellation; already invoked HTTP may settle and remains charged.
No raw route/credential persistence is added. Offline/crashed clients, a lost
discovery response with no token, or two failed closes still rely on expiry.

Every successful ledger transaction prunes expired holds **before admission**;
capacity recovery does not depend on a cron job or physical document deletion.
Expiry and close do not refund used/uncertain attempts. Refund versus close and
duplicate refund races are transactional. Old-day reservations cannot fund
new-day requests. Discovery admission stops in the last minute of the confirmed
quota day; every physical permit expires no later than one second before the
day boundary. Delayed commits are checked again before HTTP. Clock alignment
with Tencent remains an operator prerequisite; this is not a guarantee about
when a remote server receives a packet.

## Errors and user experience

Client messages distinguish `MAP_UNAUTHORIZED`, `MAP_SESSION_INVALID`,
`MAP_SESSION_EXPIRED`, `MAP_REQUEST_INVALID`, `MAP_EXECUTION_UNKNOWN`,
`MAP_USER_QUOTA_EXHAUSTED`, `MAP_GLOBAL_QUOTA_EXHAUSTED`,
`MAP_QUOTA_UNAVAILABLE`, `MAP_QUOTA_NOT_READY` and `MAP_REQUEST_LIMITED` (daily
record-creation protection, distinct from physical quota exhaustion).
Existing Tencent `PROVIDER_RATE_LIMITED` (120), `PROVIDER_QUOTA_EXHAUSTED` (121),
busy/network/configuration failures remain separate codes. Quota/session failures
are service failures, never unreachable-edge facts. Manual add/replace/edit
failures preserve confirmed routes. A quota-denied reload restores previously
displayed routes. No new dependency is added to the Walk lifecycle.

## Caller audit and safe migration

Repository audit at base `06e5c64`:

- Production discovery: `services/route-generation.js` calls `mapProvider` directly.
- Production segments: `services/walking-segment.js` calls it directly.
- Development-only `route-copy-poi-source.js` also calls it; its five centers can
  cost 15 Explore. It now uses the same quota and releases Walking holds, stops
  on service/quota failure and receives no production exemption.
- No Mini Program source caller invokes `getNearbyPois` or `getWalkingRoute`.
- The existing deployment record describes development checks and explicitly
  says the recorded build was not promoted to production. Local Git has no
  release tags establishing the currently published WeChat version.

**Published-client compatibility is not established by this local audit.** The
operator must inspect the WeChat published/trial versions and cloud invocation
metrics before scheduling rollout. Do not infer that no old clients exist.

Both old functions remain present. They authenticate locally through
`getWXContext`, discard caller identity/delegation fields, allowlist business
fields and sign a 65-second forwarding envelope containing the hashed owner and
payload digest. The gateway verifies it rather than assuming nested calls retain
OPENID. Replayed forwarding cannot bypass request claims, session checks or quotas.
The wrappers have no direct Tencent HTTP path. Their duplicated small delegation
modules are necessary for independent deployment and are tested for parity.

A credential-aware client can use either direct or legacy transport. An old
client sending arbitrary Walking coordinates without a planning token cannot be
made safely compatible by these wrappers; it receives authorization failure.
Do not issue a synthetic unrestricted token for it. The new discovery fields are
additive, but this Walking contract requires a coordinated migration.

Operator sequence (none performed automatically):

1. Inventory published/trial clients, all Key users and both old cloud functions.
   If any published version lacks this protocol, prepare an update/maintenance
   window for **new planning**, while preserving Walk/History/recovery access.
2. Tencent has not confirmed its actual reset time; apply our documented
   **09:00 Beijing internal boundary** (`MAP_QUOTA_OFFSET_MINUTES=-60`) with
   explicit awareness that it is not Tencent's verified billing cutoff.
   Keep external availability errors fail-closed; confirm backend clock health.
3. Require this Key's callers to use one authoritative gateway environment and
   its quota/QPS stores. Two independent environments each with 5400 are unsafe.
   Merely using the same secret does not create a shared ledger. If another
   environment still directly uses the Key, do not enable this rollout.
4. Create `map_planning_quotas` manually with client reads/writes denied; retain
   `provider_rate_limits`. Gateway service identity needs transaction access.
   No raw POI/route collections or persistent response cache are required.
5. Configure `MAP_PLANNING_SECRET`, explicit `MAP_QUOTA_OFFSET_MINUTES`, fixed
   `MAP_QUOTA_ACTIVE_FROM_MS`, and optionally `MAP_SESSION_TTL_MS`. Keep existing
   Tencent credentials and official limits unchanged. Install each wrapper's
   locked dependencies, now including `wx-server-sdk`.
6. Stop old planning traffic and wait for in-flight functions to finish before
   reconciliation. Include all same-Key environments, consoles and retries.
   Prepare the activation-day seed below. Unknown historical per-user usage
   cannot safely become zero: if complete reconciliation is impossible, wait for
   the verified next day with all other callers stopped, then seed an empty day.
7. During the planning maintenance window deploy gateway, both authenticated
   wrappers and compatible client; keep incompatible clients out of new planning.
   Verify service context, delegation, base/extension counts and cleanup with a
   few controlled calls; verify add/replace/edit and ongoing Walk recovery on device.
   Do not load-test the real Tencent quota. Then reopen new planning.
8. Rollback must keep authorization and quotas enforced. Disable new planning
   rather than restoring a raw unauthenticated Walking endpoint. Existing Walk
   completion/recovery must remain available.

## Offline initialization and metadata retention

`node scripts/issue107-quota-seed.cjs reviewed-input.json` only prints JSON; it
does not connect to CloudBase. Input example for the **operator-chosen** 09:00 Beijing policy (this is
not Tencent's confirmed reset time):

```json
{
  "date": "2026-10-12",
  "offsetMinutes": -60,
  "used": { "explore": 0, "walking": 0 },
  "users": {},
  "userUsageComplete": true
}
```

For this example `activeFromMs` is **2026-10-12T01:00:00.000Z**,
corresponding to **2026-10-12 09:00 in Beijing**. Prepare activation only
when the boundary has been reached, historical usage is reconciled, and no
other same-Key caller can bypass the ledger.

Review the emitted collection/document ID, `activeFromMs` and `data`. The operator
sets the fixed activation epoch and imports `data` into that document exactly
once while admission is stopped, and imports the emitted `calendar` into the
fixed `calendar` document in the same collection. This high-water day marker
prevents a missing previously initialized day ledger from silently resetting to
zero. A missing marker or offset/activation mismatch fails closed. For nonempty days, `users` maps hashed owners
to reconciled Explore/Walking usage. The flag is an operator attestation, not an
automated proof. The tool rejects raw owner IDs, invalid dates/counters and user
sums exceeding global totals; already-exceeded ceilings are saturated closed.
Never overwrite a live ledger with this seed. Missing activation-day state is
`MAP_QUOTA_NOT_READY`; only later days initialize automatically.

The seed now includes empty `creations` counters and is only for initial
activation with **no existing quota request/attempt records for that day**.
An existing ledger without the new counters fails closed; it is never interpreted
as zero. For upgrading an already active old gateway, stop new planning, drain
in-flight functions, and prefer the next confirmed quota day, after old sessions
expire. Preserve the calendar and old ledgers; the first new-day transaction
creates the new shape automatically. If that day's old ledger already exists,
do not overwrite it or advance the calendar artificially. Wait another fresh
day or obtain a complete, independently reviewed reconciliation of all creation
counts, including refunds/unknown outcomes. Old request docs do not contain an
owner field, so per-owner reconciliation may be impossible; zero is not a safe
substitute. No online migration was performed here.

All request and attempt records have numeric `expires` at the end of the next
quota day. Configure a trusted administrative cleanup job to delete expired
receipt/request records and day ledgers older than three complete quota days.
No public cleanup action is exposed. Never delete `calendar`. Do not delete today's ledger or active
dedup records; deletion is not a mechanism to release capacity. Physical cleanup
is an operator task and was not installed here. With no cleanup, metadata grows
but expired reservations still stop occupying capacity. Keep the same-Key gateway
closed if its ledger is lost; restore/reconcile rather than treating loss as zero.

`scripts/issue107-quota-retention.cjs` supplies a tested **pure eligibility
predicate**, not an installed worker. It uses the configured quota offset, not
machine-local/UTC midnight; requires full next-day receipt grace; rejects
malformed/early expiry; preserves today's and three previous complete days'
ledgers, the calendar and its latest initialized day even after a long idle
period. Missing calendar or a backwards clock fails closed.

For the later administrative worker: deny Mini Program invocation and client DB
access; use a dedicated scheduled service identity with only this collection's
required read/delete permissions. Paginate bounded batches, re-read calendar and
candidate inside a transaction immediately before delete, apply the predicate,
and never alter usage/creation counters, activation epoch or high-water mark.
Use an `expires` index for receipt candidates and an explicit old-day ID range
for ledgers; do not enable collection-wide TTL (it would lack these safeguards).
Run a dry-run inventory first; record aggregate deleted/failed counts without
tokens/provider data. Retry cleanup failures later: they retain metadata but
cannot reset quota. Full next-day grace exceeds the bounded function execution
window; verify that window before enabling the worker. If cleanup is delayed
indefinitely, total historical storage still grows by up to the daily bound.

### First deployed E2E blocker (2026-10-12)

The first WeChat DevTools 30-minute route-generation attempt returned
`MAP_QUOTA_UNAVAILABLE` from `mapProvider.nearbyPois` (cloud invocation
completed in ~287 ms with only `gateway_unavailable`, no `provider_start`).
The user confirmed the initial `calendar` and `day_20738` documents and
the 09:00 internal boundary. This is **not** proof of correct CloudBase
transaction semantics; no successful real quota debit or Tencent send has
yet been demonstrated. Do not merge/release on the earlier mock-based CI alone.

A small diagnostic follow-up emits `map_quota_transaction_failed` on
failure with only fixed phases (`start`, `read_calendar`, `read_day`,
`read_request`, `read_attempt`, `write_*`, `commit`) and sanitized
classification (`application`, `transaction_conflict`, or
`sdk_or_unknown`, plus a strictly bounded symbolic database code if present).
It logs **no exception messages, stack traces, IDs, tokens, owners, inputs or
location data** and does not change quota semantics or failure responses.
Only the Map Provider needs redeployment for this diagnostic pass.

Run one controlled signed-in Mini Program discovery after deploying the
diagnostic build, inspect the new phase log, then repair the *verified*
underlying SDK/data issue. Do not reset documents, loosen `ADMINONLY`
permissions, bypass the transaction or blindly retry an uncertain commit.

## Validation and remaining release checks

Automated tests use synthetic POIs, HTTP responses and optimistic CloudBase
transactions. They cover forgery, missing identity, scope/owner/expiry, duplicate
claims, response loss, concurrent last capacity, release/refund races, retries,
cross-day behavior, startup reconciliation, DB conflicts/unknown commits,
physical admission with QPS timing, client cache reuse and credential isolation.
The existing Tencent limiter lease tests remain unchanged.

The two pre-existing #91 A/B tests failed on a CRLF checkout because the script
matched LF-only function-entry anchors. Only the preparation script normalizes
CRLF before matching; all original assertions remain and a LF/CRLF equivalence
test is added. AI production code is unchanged.

Required local commands: full `npm test -- --runInBand` and both
`tests/benchmarks/issue91-route-correction.cjs` and
`tests/benchmarks/issue91-initial-candidates.cjs`. Passing them establishes neither
published-client compatibility nor real CloudBase transaction/identity behavior
nor Tencent availability. Complete the controlled device/deployment checks above
before claiming production readiness.

P0 repair verification on 2026-10-11: **112 suites / 2551 tests passed** (previous
baseline: 110 / 2519). Both #91
offline benchmarks completed; success counts, logical request counts and cache
metrics matched the pre-change baseline (CPU timings vary). `git diff --check`
passed. On this Windows host `npm.cmd` was used because PowerShell blocks the
`npm.ps1` shim; Jest assertions and requirements were not reduced. The locked
wrapper dependency audit still reports six affected packages (one moderate, five
high). See [the exact package/advisory inventory and runtime analysis](issue107-dependency-audit.md).
No dependency upgrade or automatic fix was performed. SDK dependency security
sign-off, verified ingress protections, cleanup installation and controlled
CloudBase/device checks remain release work, not completed deployment claims.

### Original P0 local review inventory and benchmark comparison

All 32 added test cases and the original tests pass. The original two #91 A/B
assertions remain enabled; this repair makes no A/B preparation or AI changes.
Lifecycle tests cover empty POIs, all-route failure, malformed discovery,
exceptions/close failure, repeated close, unload while discovery is pending,
late/superseded results, quota-denied reload preserving old ownership and
concurrent Walking cancellation. Server tests cover 10/100/1000 unique and
repeated rejections, shared-session budgets, last-slot races across instances,
global limits, close/refund loops, ambiguous commits and sent-HTTP close races.
Existing edit/add/replace/cache, credential isolation, Walk/History/recovery,
120/121 and QPS tests remain green.

Each correction scenario has 250 synthetic fixtures. Baseline and repaired
values match exactly (CPU timings are not compared):

| Correction scenario | Success | Mean new segments | Mean cache hits |
| --- | ---: | ---: | ---: |
| balanced | 247 | 3.66 | 7.31 |
| needle-in-haystack | 73 | 10.52 | 21.04 |
| directional | 206 | 6.67 | 13.34 |
| impossible | 0 | 12 | 24 |
| partly-cached | 248 | 1.88 | 7.84 |

Initial-candidate benchmark also matches baseline, 250 fixtures per scenario:

| Scenario | Hybrid successes | Mean new segments | Mean attempted candidates |
| --- | ---: | ---: | ---: |
| short-singletons | 244 | 6.93 | 1.28 |
| mixed | 219 | 6.35 | 2.54 |
| long-singletons | 250 | 2.12 | 1.06 |

Files in the original P0 repair (13 modified, 4 new at that review):

- Client: `miniprogram/pages/routes/routes.js`,
  `miniprogram/services/map-planning-authorization.js`,
  `miniprogram/services/route-generation.js`,
  `miniprogram/utils/provider-errors.js`.
- Server: `cloudfunctions/mapProvider/quota.js`, `errors.js`,
  `planning-session.test.js`, `quota-admission.test.js`, new `request-budget.test.js`
  (all under that function directory).
- Client/operator tests: `tests/routes.test.js`,
  `tests/map-planning-authorization.test.js`, `tests/issue107-quota-seed.test.js`,
  new `tests/issue107-quota-retention.test.js`.
- Operator scripts: `scripts/issue107-quota-seed.cjs`,
  new `scripts/issue107-quota-retention.cjs`.
- Documentation: this file and new `docs/issue107-dependency-audit.md`.

Reviewed tracked diffs and the four new files; `git diff --check` passes. The
original three unfinished client modifications were retained and completed.
No add/commit/push/PR/merge, dependency upgrade, real Tencent stress call or online
CloudBase/configuration/deployment operation was performed.

### Follow-up review of f77e77f

The repeated-close write repair changes only `cloudfunctions/mapProvider/quota.js`,
`planning-session.test.js`, `quota-admission.test.js` and this document. Added
seven cases cover 1000 signed duplicate closes, concurrent closes with a lost
commit acknowledgement, expiry pruning and old-day cleanup, and the four
post-debit/QPS-confirmation races above. Existing request creation and physical
quota ceilings are unchanged; no AI/Track/client/limiter implementation changed.

Follow-up local validation: **112 suites / 2558 tests passed** with
`npm.cmd test -- --runInBand --silent`. Both #91 offline benchmarks completed;
success counts, segment calls, candidate counts and cache hits match the tables
above (CPU timings vary). `git diff --check` passes. All four changed files remain
local and unstaged on `feature/issue-107-map-session-budget`; no commit, push, PR
or deployment was performed for this follow-up.

Release gates remain: authenticated ingress rate/concurrency protection against
read/transaction abuse, the six SDK dependency findings and their security
sign-off, deployment/migration and cleanup setup, and controlled CloudBase/device
verification. This local repair does not declare those gates satisfied and does
not deploy or change online settings.
