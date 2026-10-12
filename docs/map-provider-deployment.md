# Map provider deployment (#94)

**#107 local security update:** the contracts and rollout requirements in
[Map authorization and coupled quotas](issue107-map-security.md) supersede the
unsigned discovery/Walking examples below. The earlier smoke tests here remain
historical development evidence, not validation of the new authorization path.
For #107 the team-selected **internal** quota day begins at **09:00 Beijing**
(`MAP_QUOTA_OFFSET_MINUTES=-60`); Tencent has not confirmed its official
WebService reset time. Apply the seed/calendar migration instructions in the
linked #107 runbook, not an environment-only offset edit. No deployment is implied.

This describes the current repository implementation and the development validation
completed on 2026-10-04. Direct CloudBase smoke tests, legacy-wrapper forwarding and
a Mini Program end-to-end route-generation check passed in the development environment.
Technical API functionality alone does not establish permission for data use.
Tencent's 2026-10-08 and 2026-10-09 written replies clarify the POI storage
restriction and a narrow temporary device-side recovery exception; see below.

## Architecture

```text
Mini Program -> mapProvider
                  nearbyPois   -> Tencent Maps explore
                  walkingRoute -> Tencent Maps walking direction
             <- normalized provider-neutral contracts -> Route Engine

getNearbyPois / getWalkingRoute -> mapProvider (legacy forwarding only)
```

`cloudfunctions/amapProvider/` remains as a rollback implementation, not the current
production planned-route provider. Both POI discovery and walking use Tencent via
`mapProvider`; do not mix provider facts during release or rollback. The historical
[AMap guide](amap-provider-deployment.md) is not the current deployment procedure.

## API contracts

Invoke `mapProvider` with one of the following action payloads. Coordinates are
numeric latitude/longitude. Cloud invocation results contain the business response.

### Nearby POIs

```javascript
{ action: 'nearbyPois', latitude, longitude, radius }
```

The application computes a duration-aware discovery radius from the requested walk
time using `duration * 75 m/min * 0.5`. Product duration is bounded to **15–120 minutes**.
The provider boundary independently clamps every caller radius to **200–1000 meters**,
so longer requests never exceed Tencent's 1 km nearby-search cap. The request uses
`auto_extend = 0`, encoded as `boundary=nearby(latitude,longitude,radius,0)`.
It calls Tencent explore (`https://apis.map.qq.com/ws/place/v1/explore`) for the three
application categories: `park`, `water`, `shoppingStreet`. All three category requests
enter the distributed limiter immediately; the limiter, not HTTP completion order,
controls actual Tencent request starts. The adapter requests the first page of six
entries per category, ordered by distance; invalid entries are filtered. All scheduled
categories are awaited and any category failure discards the partial result.

```javascript
{
  success: true,
  poisByCategory: { park: [/* POI */], water: [/* POI */], shoppingStreet: [/* POI */] }
}
// Each normalized POI:
{
  poiId, name, category, latitude, longitude, distanceInMeters,
  // address: optional string
}
```

`distanceInMeters` is a nonnegative number or `null` when unavailable. Category
keys exist even when their arrays are empty. There is no `providerMeta` or raw
provider response in the public contract. Provider category codes are internal
adapter details, not application categories or client inputs.

Requested duration therefore influences POI discovery until the 1000 m provider cap
is reached (for example: 15 min -> 563 m, 20 min -> 750 m, 25 min -> 938 m,
30+ min -> 1000 m). Real walking segments, waypoint selection, Route Engine,
optimization and final validation remain authoritative for route duration.

### Walking route

```javascript
{
  action: 'walkingRoute',
  start: { latitude, longitude },
  destination: { latitude, longitude }
}
```

The adapter calls Tencent walking direction
(`https://apis.map.qq.com/ws/direction/v1/walking/`) and returns:

```javascript
{
  success: true,
  route: {
    distanceMeters,
    durationSeconds,
    polyline: [/* { latitude, longitude }, ... */]
    // streetEvidence: { coverageRatio, ordinaryRoadRatio } // optional runtime-only
  }
}
```

The adapter converts duration to seconds and decodes the polyline. There is no
`environmentStats`, raw Tencent steps, `type` or `road_class` in the response.
#84 optionally normalizes documented walking types and step meters into
`streetEvidence`; missing/malformed evidence is omitted, while valid partial
classification remains proportional to confirmed ordinary road. No unclassified
step is assumed ordinary and no coverage percentage is a hard gate. The client
moves the two allowlisted ratios into a runtime WeakMap, not public segments or
Route snapshots. See [Street source, coverage and limitations](street-preference-ranking.md).
Live October 8 development checks found 8 classified steps / 4 m accounting
gap and 10 classified steps / 5 m gap on separate routes. These do not justify
a rounding rule. The final proportional-scoring cloud and matching client were
subsequently tested in development on October 9 local time; see the #84
development E2E section below. No configuration changes were needed.

## Error semantics

Business failures use `{ success: false, error: { code, message } }`.

| Availability code | Meaning |
| --- | --- |
| `PROVIDER_RATE_LIMITED` | Tencent status 120 exhausted the bounded provider attempt budget |
| `PROVIDER_QUOTA_EXHAUSTED` | Tencent status 121; no retry or artificial short cooldown |
| `PROVIDER_BUSY` | Queue deadline or bounded transaction contention budget exhausted |
| `PROVIDER_GATEWAY_FAILED` | Provider/service, key/signature/origin authorization, configuration initialization or shared-state infrastructure failure |

Tencent key/origin/signature/authorization statuses `110`, `111`, `112`, `113`,
`190`, `199` and malformed-key status `311` normalize to `PROVIDER_GATEWAY_FAILED`.
They are configuration/service failures, not evidence that a particular walking edge
is unreachable, and they do not trigger AI waypoint replanning.

HTTP failures without a recognized Tencent business status (including HTTP 429),
missing or malformed walking responses, and invalid route facts or geometry normalize
to `PROVIDER_GATEWAY_FAILED`. They stop route generation without fallback and are
not stored as unreachable segment costs. Only explicit no-route results (status 378
or a successful response with an empty routes array) become `ROUTE_NOT_FOUND`.

All four availability codes represent provider/service failures, not deterministic
unreachable edges. Route Engine may retain a request-local Promise result for
deduplication but does not record these as unreachable resolved segment facts.
Agentic planning does not ask AI to repair an unavailable provider by choosing
different waypoints. Quota exhaustion is not necessarily short-lived.

`ROUTE_NOT_FOUND` is instead a deterministic walking-route result and can be reused
as a failed edge fact within the planning session. Validation/configuration errors
such as `INVALID_ACTION`, `INVALID_COORDINATES` and `CONFIG_MISSING` remain separate.

## Shared limiter state

Collection: `provider_rate_limits`. Client read/write must be disabled; trusted
cloud functions coordinate through transactions. Scope documents are:

| Scope | Role |
| --- | --- |
| `tencent:key` | Shared key cooldown; key pacing disabled by default |
| `tencent:poi-explore` | POI request start pacing |
| `tencent:walking` | Walking request start pacing |

Transactions acquire leases on paced scopes, then recheck ownership and admission
before HTTP starts. Owner fencing prevents a late worker clearing a successor's
lease. Start accounting records actual request start time, advances shared pacing
and clears owned leases atomically. Expiring leases bound crash recovery; an expired
start window cannot authorize a new request. An unpaced key still participates in
coordination to fence shared cooldown changes.

Database errors, corrupt state and failed start accounting fail closed. After HTTP
has started, bookkeeping failure must not unlock state optimistically or bypass the
limiter for another attempt. Shared cooldown is monotonic. Tencent status **120**
publishes key-wide cooldown, including on the final attempt; only this status permits
bounded provider retry, with admission reacquired each time. Status **121** does not
retry. There are no client-side provider retries or a client request-start scheduler;
the engine's logical concurrency and session cache remain separate from backend pacing.

Each physical route/category request establishes a queue deadline shared by its
attempts. POI categories enter admission concurrently and each gets its own request
deadline; the shared `tencent:poi-explore` scope still serializes starts at the
configured safe pace. Admission waits must fit it; an admitted HTTP response and its
bookkeeping can finish after it. HTTP has a separate timeout. There is no durable FIFO queue or fairness
guarantee. Transaction conflict retries are bounded independently of provider attempts.

Coordination assumes backend clocks within the configured guard. Pacing adds twice
the guard; cooldown adds one guard. With the 100 ms default guard, Explore starts are
at least about 400 ms apart (200 + 2 * 100). Walking uses the same verified
200 ms service interval, so its physical starts are also at least about 400 ms apart. The guard is not a database latency budget. No database transaction
can atomically send external HTTP; already-admitted requests cannot be revoked by
a subsequently published cooldown.

One shared-state boundary represents one Tencent key. Other environments/applications
using the key outside this boundary are not coordinated. Do not reset live limiter
rows, add TTL expiry or shorten active leases to accelerate rollout.

## Server-side configuration

Required: `TENCENT_MAPS_API_KEY` and `TENCENT_MAPS_SECRET_KEY`, configured only in the
`mapProvider` server environment. The Tencent WebService key uses SN/signature
verification. For every GET request the gateway sorts parameter names, signs the
unencoded raw values with the exact request pathname and Secret Key, then sends the
lowercase MD5 result as `sig`. The Secret Key never leaves the server environment.
Never place either credential in Mini Program code, committed files or logs.

| Optional variable | Default | Allowed values |
| --- | --- | --- |
| `TENCENT_MAPS_WALKING_MIN_INTERVAL_MS` | 200 | 1–60000 ms |
| `TENCENT_MAPS_WALKING_MAX_QUEUE_WAIT_MS` | 12000 | 1–60000 ms |
| `TENCENT_MAPS_WALKING_MAX_ATTEMPTS` | 2 | 1–4 |
| `TENCENT_MAPS_WALKING_COOLDOWN_MS` | 3000 | 1–60000 ms; multiplied by attempt |
| `TENCENT_MAPS_POI_MIN_INTERVAL_MS` | 200 | 1–60000 ms |
| `TENCENT_MAPS_POI_MAX_QUEUE_WAIT_MS` | 12000 | 1–60000 ms |
| `TENCENT_MAPS_POI_MAX_ATTEMPTS` | 2 | 1–4 |
| `TENCENT_MAPS_POI_COOLDOWN_MS` | 3000 | 1–60000 ms; multiplied by attempt |
| `TENCENT_MAPS_KEY_MIN_INTERVAL_MS` | 0 | 0–60000 ms; 0 disables key pacing |
| `TENCENT_MAPS_CLOCK_GUARD_MS` | 100 | 0–5000 ms |
| `TENCENT_MAPS_LEASE_START_WINDOW_MS` | 10000 | 1000–60000 ms |
| `TENCENT_MAPS_REQUEST_TIMEOUT_MS` | 10000 | 1–60000 ms |

The current development Key's allocations were verified in Tencent's console on
2026-10-04 as **Explore: 5 QPS / 200 calls/day** and **Walking: 5 QPS / 6000 calls/day**.
Both services use a 200 ms service interval. With the 100 ms clock guard on both sides,
effective physical start spacing is at least about 400 ms (~2.5 starts/s), intentionally
leaving roughly 2x QPS headroom. Re-check account/Key allocations before carrying these
defaults to another environment.

## Development deployment status

Development environment work completed on 2026-10-04:

1. `provider_rate_limits` and the `mapProvider` server configuration were used for live smoke tests.
2. `mapProvider -> nearbyPois` succeeded with normalized Tencent POIs.
3. `mapProvider -> walkingRoute` succeeded with normalized distance, duration and decoded polyline.
4. `getNearbyPois -> mapProvider` and `getWalkingRoute -> mapProvider` forwarding succeeded.
5. Mini Program E2E succeeded through Questionnaire -> Tencent POIs -> HY3 waypoint
   selection -> Tencent walking segments -> Route Engine -> deterministic validation
   -> route card/detail. A 30-minute request produced a valid ~24-minute / ~1.6 km route.

### Street preference (#84) development E2E — 2026-10-09 local

The corrected, proportional Street evidence build on
`feature/street-preference-ranking` was deployed as `mapProvider` to the
authorized development CloudBase environment. The matching Mini Program client
was compiled in WeChat Developer Tools. Neither was promoted to production.

- Direct `walkingRoute` returned `success: true`, distance **1213 m**,
  duration **1080 seconds**, `coverageRatio = 0.9967023907666942`,
  and `ordinaryRoadRatio = 1`. Only the two normalized ratios appeared under
  `streetEvidence`; no temporary diagnostic payload, `classificationComplete`
  marker, provider steps, or raw `environmentStats` were returned.
- A real 30-minute, Street-first questionnaire generated an approximately
  **24-minute / 1.6 km** route. Runtime inspection showed
  `coverageRatio ≈ 0.99682741`, `ordinaryRoadRatio = 1`,
  `streetBonus ≈ 0.04984137`, `baseScore = 0.7904`.
- Ranking the real route against a JSON-cloned evidence-free version placed
  the original first in **both input orders**, without mutating displayed
  routes. Two *independent* live routes were not successfully compared.
- Raw route/UI representations had no Street/provider evidence keys. A test
  Walk with trajectory recording disabled created a clean local
  `activeWalkSession`, completed as `ended_early`, produced a clean
  `pendingWalkResult` and cleared both local keys after feedback was skipped.
  This does not delete the completed cloud Walk record.
- Manual Add could not yield a second route: three duration-invalid candidates
  were followed by empty AI batches. The AI-origin empty-plan reproduction
  is documented under **#91**; Add/Replace success and a real confirmed-edit
  Street rerank are not claimed as verified.

CI on feature commit `679ccebd` passed **71 suites / 1484 tests**, and the
local full Jest suite passed. Neither the E2E observation nor normalized
field omission establishes permission to persist Tencent planned-route data.
Pending production deployment and Tencent usage/persistence approval remain
separate release gates.

The later Explore concurrent-admission optimization and the Walking pacing reduction
are covered by automated tests, but must be redeployed before treating their live
CloudBase start-spacing checks as revalidated.

Production release still requires the unresolved Tencent WebService data-use / AI-use /
persistence decision below. Retaining the AMap implementation alone is not an automatic
rollback mechanism; both production callers must switch providers together.

## Manual validation checklist (completed in development on 2026-10-04)

Use an authorized development environment and controlled valid locations. Do not
force quota exhaustion or overload the key. Console synchronous cloud testing can
inspect returned business results; a child log alone does not prove wrapper success.

### A. Direct nearbyPois

Invoke `mapProvider` with `action: 'nearbyPois'`, valid latitude/longitude and a
bounded radius. Development smoke testing returned `success: true` with normalized
category results. Automated tests additionally verify that radius values are clamped
to 200–1000 m and that no raw Tencent fields or `providerMeta` escape.

### B. Direct walkingRoute

Invoke `mapProvider` with `action: 'walkingRoute'` and valid `start`/`destination`.
Check numeric `distanceMeters`, `durationSeconds` and decoded latitude/longitude
polyline. Optional `streetEvidence` may contain only `coverageRatio` and
`ordinaryRoadRatio`; verify there are no `environmentStats`, raw steps,
legacy completion markers or temporary diagnostics in the public response.

### C. Limiter and logs

Filter `[Map Provider]` and `provider_start` across all cloud instances. Check
`tencent:poi-explore` / `tencent:walking` service scopes and key-wide cooldown scope
`tencent:key`, actual start spacing, bounded attempts and queue outcomes. Confirm
logs contain no API key, precise coordinates, raw payload or full URL. Do not copy
test inputs/responses into diagnostic logs or persistent fixtures.

### D. Legacy wrappers

Invoke both wrappers with their existing inputs. Verify `[Map Legacy Wrapper]`
forwarding targets `mapProvider`, business results pass through, and there is no
duplicate wrapper/client provider retry.

### E. Real device

Questionnaire -> Tencent POIs -> AI waypoint selection -> Tencent walking segments
-> Route Engine -> validation -> route display/edit passed in development. Start Walk
remains a separate lifecycle/trajectory flow. Service-unavailable feedback remains
distinct from a genuine route-not-found result.

## Data-use and deployment checkpoint

Tencent Location Service replied on 2026-10-08: **“经核实 Poi 不允许存储，其他没限制。”**
The original inquiry included AI use and provider persistence. Interpret this
conservatively: do not persist Tencent POIs or infer blanket authorization for
provider-derived permanent caches. On 2026-10-09 Tencent separately confirmed
**“经核实这种使用方法是可以的”** to a specific follow-up: temporary **on-device**
POI/route caching only during an active Mini Program Walk, solely to resume an
interrupted Walk, followed by removal after completion. This does not authorize
CloudBase POI persistence, permanent route/segment caches or indefinite local
history. Never add persistent segment L2 caches on this limited confirmation.

`activeWalkSession.route` is stored locally for an active Walk. Home and Walking
reconcile local and CloudBase walk identity on resume. The existing backend
12-hour abandonment boundary is supplemented by a best-effort **cold-launch**
verification of aged local sessions. Valid route snapshots are reconciled
against CloudBase before stale-session removal; device clock age alone and
local pending Feedback metadata never delete a valid Walk lock. When both
local keys remain after a terminal handoff, even for a recent Walk, startup
requests a CloudBase status check; only verified terminal or abandoned status
authorizes deleting the full route. A failed check keeps it recoverable. Missing/corrupt local session snapshots may still be
removed by validation, and offline/background periods cannot complete the
remote check. After CloudBase confirms terminal/abandoned status, the client
attempts full-route deletion independently of optional Feedback metadata writes;
persistent local-storage failures may require a later retry. The terminal
`pendingWalkResult` retains only allowlisted Feedback/recovery metadata:
walkId, application routeId, start/end time, duration, completion state and
optional trajectory flags/time boundary. After upgrading, valid legacy
full-route pending snapshots are rewritten without Route fields. If rewriting
fails, removal of the old snapshot is attempted instead, prioritizing POI
deletion over optional Feedback recovery; if both operations fail, sanitation
retries on next read. Existing optional Feedback submit/skip/leave cleanup remains.

Issue #79's `walkStore` persistence is deliberately narrower:
it stores lifecycle/questionnaire metadata plus a provider-neutral application
`routeId`, but no Tencent POI IDs, route geometry, planned coordinates, or provider
payloads. This does not establish permission to persist a planned-route summary later.
Actual GPS trajectory via Track Cloud is a separate data flow; its separation does not
resolve permission for Tencent planned-route data.

Issue #87 Phase 3A adds a local-only [walk-authorized Track Cloud query](history-trace.md).
It reuses existing credentials/signatures and stores no GPS in CloudBase. Generic
public range searches are retired; review the documented migration, seconds-level
isolation limits and development deployment checks before rollout. No map-provider
configuration or actual deployment is changed by Phase 3A.
