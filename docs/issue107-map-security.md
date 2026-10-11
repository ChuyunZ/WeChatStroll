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
reuse the Tencent secret. Rotation invalidates active planning credentials;
displayed routes and active Walks remain usable. Do not log invocation payloads,
tokens, secret material or provider URLs, including platform debug/event logging.

## Accounting and capacity decision

| Physical HTTP attempts | User/day | Global/day |
| --- | ---: | ---: |
| Explore | 9 | 180 |
| Walking | 270 | 5400 |

All active holds count against both limits. A transaction admits a discovery
only when it can reserve **3 Explore and 90 Walking together**. The three
Explore requests and each status-120 retry convert holds into used attempts;
retry capacity beyond three is acquired from unreserved capacity. Empty or
failed discovery releases unused holds after all category tasks settle.

Walking consumes its protected base hold, then atomically extends **one physical
attempt at a time** if both ceilings permit. No fixed 540-attempt buffer is
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

## Transactions, QPS, expiry and unknown outcomes

`map_planning_quotas` is separate from `provider_rate_limits`. A single daily
ledger atomically contains global usage, per-user usage and active reservations;
request/attempt documents participate in the same CloudBase transactions.
The ledger serializes contention at this small configured daily scale. Only
explicit transaction conflicts retry, with bounded jitter. Database failures
and uncertain commit acknowledgements fail closed.

The existing QPS lease is acquired **before charging**. A committed debit then
precedes final QPS confirmation and synchronous HTTP invocation. Slow debit or
queue/lease/session expiry that definitely prevents invocation refunds through
an idempotent attempt receipt. The start timestamp still sits next to HTTP;
no awaited quota work occurs between them. A lost debit acknowledgement sends
no HTTP but may conservatively retain a charge. Invoked HTTP, including timeout,
120, 121 and unknown network outcomes, is never refunded. This is a safe upper
bound on possible starts, not exact provider billing reconciliation.

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
On page disposal or replacement of a completed planning session the client
releases unused holds; failed/missing close calls fall back to server expiry.
Abandoned generation can retain its hold until expiry.

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
`MAP_QUOTA_UNAVAILABLE` and `MAP_QUOTA_NOT_READY`.
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
2. Verify Tencent's actual reset timezone for this Key. This implementation has
   no timezone default. Do not copy the AI quota's UTC convention. Confirm clocks.
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
does not connect to CloudBase. Input example (offset **must be confirmed**, the
example value is not a statement of Tencent policy):

```json
{
  "date": "2026-10-12",
  "offsetMinutes": 480,
  "used": { "explore": 0, "walking": 0 },
  "users": {},
  "userUsageComplete": true
}
```

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

All request and attempt records have numeric `expires` at the end of the next
quota day. Configure a trusted administrative cleanup job to delete expired
receipt/request records and day ledgers older than three complete quota days.
No public cleanup action is exposed. Never delete `calendar`. Do not delete today's ledger or active
dedup records; deletion is not a mechanism to release capacity. Physical cleanup
is an operator task and was not installed here. With no cleanup, metadata grows
but expired reservations still stop occupying capacity. Keep the same-Key gateway
closed if its ledger is lost; restore/reconcile rather than treating loss as zero.

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

Local verification on 2026-10-11: **110 suites / 2519 tests passed**. Both #91
offline benchmarks completed; success counts, logical request counts and cache
metrics matched the pre-change baseline (CPU timings vary). `git diff --check`
passed. On this Windows host `npm.cmd` was used because PowerShell blocks the
`npm.ps1` shim; Jest assertions and requirements were not reduced. The locked
wrapper dependency update reported six npm audit findings (one moderate, five
high); no unrelated dependency upgrade or automatic audit fix was performed.
These findings require dependency review before a production security sign-off.
