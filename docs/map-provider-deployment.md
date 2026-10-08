# Map provider deployment (#94)

This describes the current repository implementation and the development validation
completed on 2026-10-04. Direct CloudBase smoke tests, legacy-wrapper forwarding and
a Mini Program end-to-end route-generation check passed in the development environment.
Technical API functionality does not establish permission for data use, AI processing
or persistence; that remains a separate release checkpoint.

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
    // streetEvidence: { coverageRatio, ordinaryRoadRatio } // optional, runtime only
  }
}
```

The adapter converts duration to seconds and decodes the polyline. There is no
`environmentStats`, raw Tencent steps, `type` or `road_class` in the response.
#84 optionally normalizes documented walking types and step meters into
`streetEvidence`; missing or malformed evidence is omitted. The client moves it
into a runtime-only sidecar, not public segments or Route snapshots. See
[Street source, coverage and limitations](street-preference-ranking.md).
This extension is local until a future release; the earlier development smoke
tests below do not verify its live availability. No configuration changes are needed.

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
polyline. Ensure no `environmentStats` or raw steps are returned.

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

Until Tencent confirms the intended WebService data-use terms, do not add raw
provider response/payload persistence or a persistent segment L2 cache. Planned-route
persistence and AI-use policy remain subject to confirmation. Normalization removes
raw fields but does not itself confer permission to store or process derived data.

`activeWalkSession` currently stores a route snapshot locally. That existing behavior
is unchanged and must be reviewed as a deployment/data-policy checkpoint, not treated
as an approved exception. Issue #79's `walkStore` persistence is deliberately narrower:
it stores lifecycle/questionnaire metadata plus a provider-neutral application
`routeId`, but no Tencent POI IDs, route geometry, planned coordinates, or provider
payloads. This does not establish permission to persist a planned-route summary later.
Actual GPS trajectory via Track Cloud is a separate data flow; its separation does not
resolve permission for Tencent planned-route data.
