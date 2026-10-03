# Map provider deployment (#94)

This describes the current repository implementation and a future manual deployment
plan. It does not certify that cloud deployment, live API smoke tests or real-device
verification have been completed. Technical API functionality does not establish
permission for data use, AI processing or persistence; that remains a release checkpoint.

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

The runtime ignores caller radius changes. Discovery always uses **1000 meters**
with `auto_extend = 0`, encoded as `boundary=nearby(latitude,longitude,1000,0)`.
It calls Tencent explore (`https://apis.map.qq.com/ws/place/v1/explore`), querying
the three application categories sequentially: `park`, `water`, `shoppingStreet`.
The adapter requests the first page of six entries per category, ordered by distance;
invalid entries are filtered. A category failure stops subsequent category work.

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

Requested duration does not change discovery radius. The local deterministic
fallback ranking heuristic remains duration-aware; real walking segments, waypoint
selection, Route Engine, optimization and final validation determine route duration.

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
  }
}
```

The adapter converts duration to seconds and decodes the polyline. There is no
`environmentStats`, raw Tencent steps, `type` or `road_class`. Client segment and
public route construction preserve normalized facts, without deriving a street score.

## Error semantics

Business failures use `{ success: false, error: { code, message } }`.

| Availability code | Meaning |
| --- | --- |
| `PROVIDER_RATE_LIMITED` | Tencent status 120 exhausted the bounded provider attempt budget |
| `PROVIDER_QUOTA_EXHAUSTED` | Tencent status 121; no retry or artificial short cooldown |
| `PROVIDER_BUSY` | Queue deadline or bounded transaction contention budget exhausted |
| `PROVIDER_GATEWAY_FAILED` | Provider/service, configuration initialization or shared-state infrastructure failure |

All four represent provider/service availability failures, not deterministic
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
attempts. POI categories execute sequentially but each gets its own request deadline.
Admission waits must fit it; an admitted HTTP response and its bookkeeping can finish
after it. HTTP has a separate timeout. There is no durable FIFO queue or fairness
guarantee. Transaction conflict retries are bounded independently of provider attempts.

Coordination assumes backend clocks within the configured guard. Pacing adds twice
the guard; cooldown adds one guard. With defaults, paced starts are at least about
1700 ms apart. The guard is not a database latency budget. No database transaction
can atomically send external HTTP; already-admitted requests cannot be revoked by
a subsequently published cooldown.

One shared-state boundary represents one Tencent key. Other environments/applications
using the key outside this boundary are not coordinated. Do not reset live limiter
rows, add TTL expiry or shorten active leases to accelerate rollout.

## Server-side configuration

Required: `TENCENT_MAPS_API_KEY`, configured only in the `mapProvider` server
environment. Never place keys in the Mini Program, committed files or logs.

| Optional variable | Default | Allowed values |
| --- | --- | --- |
| `TENCENT_MAPS_WALKING_MIN_INTERVAL_MS` | 1500 | 1–60000 ms |
| `TENCENT_MAPS_WALKING_MAX_QUEUE_WAIT_MS` | 12000 | 1–60000 ms |
| `TENCENT_MAPS_WALKING_MAX_ATTEMPTS` | 2 | 1–4 |
| `TENCENT_MAPS_WALKING_COOLDOWN_MS` | 3000 | 1–60000 ms; multiplied by attempt |
| `TENCENT_MAPS_POI_MIN_INTERVAL_MS` | 1500 | 1–60000 ms |
| `TENCENT_MAPS_POI_MAX_QUEUE_WAIT_MS` | 12000 | 1–60000 ms |
| `TENCENT_MAPS_POI_MAX_ATTEMPTS` | 2 | 1–4 |
| `TENCENT_MAPS_POI_COOLDOWN_MS` | 3000 | 1–60000 ms; multiplied by attempt |
| `TENCENT_MAPS_KEY_MIN_INTERVAL_MS` | 0 | 0–60000 ms; 0 disables key pacing |
| `TENCENT_MAPS_CLOCK_GUARD_MS` | 100 | 0–5000 ms |
| `TENCENT_MAPS_LEASE_START_WINDOW_MS` | 10000 | 1000–60000 ms |
| `TENCENT_MAPS_REQUEST_TIMEOUT_MS` | 10000 | 1–60000 ms |

These are conservative implementation defaults, **not Tencent account quota facts**.
Verify actual account limits separately and keep concurrent revisions consistent.

## Future deployment sequence (not executed)

1. Confirm Tencent WebService data-use, AI and persistence boundaries. This remains
   unresolved; successful API calls alone do not grant these permissions.
2. Verify `provider_rate_limits` exists with client rules
   `{ "read": false, "write": false }` and trusted server transaction access.
3. Configure the `mapProvider` server key and environment settings. Review execution
   and caller timeouts against sequential POI queries, queue waits, HTTP timeouts
   and bookkeeping; one queue-wait value is not a whole invocation bound.
4. Deploy `cloudfunctions/mapProvider` with cloud dependency installation.
5. Smoke-test `nearbyPois` directly.
6. Smoke-test `walkingRoute` directly.
7. Deploy/update both `getNearbyPois` and `getWalkingRoute` wrappers with dependency
   installation. They invoke `mapProvider` in the same environment, using runtime
   credentials; SDK retries remain 0. Existing nested transport timeout is 60 s and
   watchdog is 65 s; allow an 80 s wrapper execution timeout and review the entire
   timeout chain before changing limits. The watchdog does not cancel its child.
8. Verify both wrappers' forwarding and returned business results.
9. Release Mini Program production caller changes together, so both operations use
   `mapProvider`. Check old deployed revisions during cutover; retaining AMap files
   alone is not an automatic rollback strategy.
10. Run real-device end-to-end verification before accepting the release.

## Manual smoke test plan (pending)

Use an authorized development environment and controlled valid locations. Do not
force quota exhaustion or overload the key. Console synchronous cloud testing can
inspect returned business results; a child log alone does not prove wrapper success.

### A. Direct nearbyPois

Invoke `mapProvider` with `action: 'nearbyPois'`, valid latitude/longitude and
`radius: 1000`. Check `success: true`, all three category keys, normalized fields
and valid empty arrays where appropriate. Ensure no raw Tencent fields or
`providerMeta` escape. Caller radius must not change the fixed provider policy.

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

Verify Questionnaire -> Tencent POIs -> AI waypoint selection -> Tencent walking
segments -> Route Engine -> validation -> route display/edit -> Start Walk.
Check service-unavailable feedback separately from a genuine route-not-found result.
This document does not claim any of these manual checks have passed.

## Data-use and deployment checkpoint

Until Tencent confirms the intended WebService data-use terms, do not add raw
provider response/payload persistence or a persistent segment L2 cache. Planned-route
persistence and AI-use policy remain subject to confirmation. Normalization removes
raw fields but does not itself confer permission to store or process derived data.

`activeWalkSession` currently stores a route snapshot locally. That existing behavior
is unchanged and must be reviewed as a deployment/data-policy checkpoint, not treated
as an approved exception. Actual GPS trajectory via Track Cloud is a separate data
flow; its separation does not resolve permission for Tencent planned-route data.
