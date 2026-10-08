# Route Data Contract

This document defines the shared route data structure used by the WeChatStroll frontend, backend, and future AI route-generation components.

The goal is to make sure every part of the application uses the same field names and data formats.

## 1. Route object

| Field | Type | Required | Description |
|---|---|---:|---|
| `routeId` | string | Yes | Application-generated route identity. Generated IDs are provider-neutral and combine a timestamp, local monotonic sequence and random suffix; they must not embed provider POI IDs or coordinates because `routeId` may be persisted as walk lifecycle metadata. |
| `title` | string | Yes | User-facing route title |
| `durationMinutes` | number | Yes | Estimated walking duration in minutes |
| `durationSeconds` | number | For optimized routes | Complete walking duration used for ordering; minutes are rounded up for display |
| `routeOrder` | object | For optimized routes | `orderedWaypointIds` and `source: "optimized"` |
| `candidateWaypointIds` | string[] | For optimized routes | Original AI-selected IDs, before reordering |
| `recommendedWaypointIds` | string[] | For optimized routes | Recommended permutation of the complete candidate set |
| `optimization` | object | For optimized routes | Search strategy, evaluated order count, cost, target error and budget metadata; see [waypoint ordering](waypoint-order-optimization.md) |
| `distanceMeters` | number | Yes | Estimated walking distance in meters |
| `routeType` | string | Yes | Shape/type of the route |
| `returnsToStart` | boolean | For generated routes | Whether the route returns to its start; Route Detail derives this from `routeType` for legacy data when absent, and uses it for the start/return legend |
| `crowdLevel` | string | Yes | Estimated crowd level |
| `tags` | string[] | Yes | Environment/features associated with the route |
| `description` | string | Yes | Longer description shown on the detail page |
| `recommendationReason` | string | Yes | Short explanation of why the route was recommended |
| `startPoint` | LocationPoint | Yes | Route starting location |
| `endPoint` | LocationPoint | Yes | Route ending location |
| `polyline` | GeoPoint[] | Yes | Ordered coordinates used to draw the route on the map |
| `pointsOfInterest` | PointOfInterest[] | No | Interesting places along the route |
| `updatedAt` | string | Yes | Last update time in ISO 8601 format |

## 2. Allowed values

### Runtime recommendation ranking

Manual Add/Replace counters, newly requested candidate batches, previously surfaced waypoint-set keys, selection and
pending-operation state belong only to the current planning session on the Routes
page. They are not Route/Walk fields and must never be persisted. Alternative
identity uses the complete normalized verified/recommended POI set, independent
of order and `routeId`; see [manual alternatives](waypoint-order-optimization.md#manual-route-alternatives).

Validated complete routes are ranked progressively: the first valid route is
available immediately, and successful alternatives, replacements and confirmed
validated edits rerank the displayed set. Ranking is distinct from optimizing
waypoint order and never relaxes route validation.

V1 uses real `durationSeconds` and unique verified `pointsOfInterest[].category`
values (`park`, `water`, `shoppingStreet`). Current duration/environment weights
are 0.50/0.30, with 0.20 for secondary history from the same compact snapshot used
by AI planning. Missing components are excluded and weights renormalized. Crowd,
feedback tags and generic quality do not contribute; duplicate POI categories do
not increase their weight. Street remains outside both environment formulas and
adds only the separate positive bonus described in
[Street preference ranking](street-preference-ranking.md), when reliable complete
walking classification exists. Unknown evidence earns no bonus, not a penalty.

`scoreRoute()` exposes scores, components, normalized weights and deterministic
tie-break keys as separate runtime data. `rankRoutes()` returns unchanged route
objects in a new array. No scoring metadata, historical profile or `isBestMatch`
field belongs in the persisted Route/Walk snapshot. The latter is derived only
for the Routes page, and appears only on the first of at least two alternatives.
`recommendationReason` remains unchanged.

Tie-breaking never uses `routeId` or timestamps: score components and duration
error precede a canonical waypoint key, followed by stable route facts for shared
or missing IDs. Fact-identical duplicates remain equivalent. See the
[runtime ranking API](api-contract.md#runtime-ranking-api-v1) for exact formulas,
missing-value handling and tie-break order.

### `routeType`

Use one of:

- `loop` — returns to the starting point using a loop-shaped route
- `out_and_back` — walks to a destination and returns along approximately the same path
- `point_to_point` — starts and ends at different locations

### `crowdLevel`

Use one of:

- `low`
- `medium`
- `high`
- `unknown`

`unknown` should be used when crowd information is unavailable.

## 3. LocationPoint

```json
{
  "name": "Riverside Park Entrance",
  "latitude": 31.2304,
  "longitude": 121.4737
}
```

Fields:

| Field | Type | Required | Description |
|---|---|---:|---|
| `name` | string | Yes | Human-readable location name |
| `latitude` | number | Yes | Latitude |
| `longitude` | number | Yes | Longitude |

## 4. GeoPoint

A GeoPoint is used inside the route polyline.

```json
{
  "latitude": 31.2304,
  "longitude": 121.4737
}
```

The `polyline` array must be ordered from the beginning of the route to the end.

## 5. PointOfInterest / verified waypoint

Current generated route POIs and public Route Engine waypoints use normalized
provider-neutral fields:

```json
{
  "poiId": "verified-poi-id",
  "name": "Riverside Viewing Platform",
  "category": "water",
  "latitude": 31.2312,
  "longitude": 121.4751,
  "distanceInMeters": 500,
  "address": "Example address"
}
```

Fields:

| Field | Type | Required | Description |
|---|---|---:|---|
| `name` | string | Yes | Point-of-interest name |
| `poiId` | string | Yes | Verified POI ID, preserved through route detail navigation |
| `category` | string | Yes | Application category: `park`, `water`, `shoppingStreet` |
| `latitude` | number | Yes | Latitude |
| `longitude` | number | Yes | Longitude |
| `distanceInMeters` | number or null | Yes | Discovery distance when available; not final walking segment distance |
| `address` | string | No | Address when present |

Public waypoint construction and editable copies whitelist these fields. They do
not preserve `providerMeta` or raw provider responses, including from stale inputs.
Legacy/mock `type` labels are not the current provider POI contract.

Walking facts are `distanceMeters`, `durationSeconds` and decoded `polyline`.
Route Engine segments additionally identify `from` and `to`; the public route
aggregates those walking facts. Neither segments nor generated routes expose
`environmentStats` or `streetEvidence`. The cloud's optional normalized Street
capability is consumed into a WeakMap sidecar at the walking boundary. Documented
Tencent walking `type` and step distance support ordinary-road exposure only;
`road_class` is unused. No raw steps or evidence enters persisted Route snapshots.

## 6. Route card

A route card uses a subset of the route object:

- `routeId`
- `title`
- `durationMinutes`
- `distanceMeters`
- `routeType`
- `crowdLevel`
- `tags`
- `recommendationReason`

Example display:

```text
Riverside Relaxing Walk
32 min · 2.6 km
Loop route
Crowd: Medium
River · Quiet · Trees
Recommended because you prefer a quiet 30-minute walk.
```

## 7. Route detail page

The route detail page can use:

- `title`
- `durationMinutes`
- `distanceMeters`
- `routeType`
- `crowdLevel`
- `tags`
- `description`
- `recommendationReason`
- `startPoint`
- `endPoint`
- `polyline`
- `pointsOfInterest`
- `updatedAt`

The following are UI actions, not route data fields:

- Start Walk
- Replace Route

## 8. Complete example

```json
{
  "routeId": "route_001",
  "title": "Riverside Relaxing Walk",
  "durationMinutes": 32,
  "distanceMeters": 2600,
  "routeType": "loop",
  "crowdLevel": "medium",
  "tags": ["river", "quiet", "trees"],
  "description": "A mostly riverside route with several resting areas.",
  "recommendationReason": "This route matches your preference for a quiet 30-minute walk.",
  "startPoint": {
    "name": "Riverside Park Entrance",
    "latitude": 31.2304,
    "longitude": 121.4737
  },
  "endPoint": {
    "name": "Riverside Park Entrance",
    "latitude": 31.2304,
    "longitude": 121.4737
  },
  "polyline": [
    {
      "latitude": 31.2304,
      "longitude": 121.4737
    },
    {
      "latitude": 31.2312,
      "longitude": 121.4751
    }
  ],
  "pointsOfInterest": [
    {
      "name": "Riverside Viewing Platform",
      "poiId": "verified-poi-id",
      "category": "water",
      "distanceInMeters": 500,
      "latitude": 31.2312,
      "longitude": 121.4751
    }
  ],
  "updatedAt": "2026-08-08T00:00:00+08:00"
}
```

## 9. Notes for later development

This contract is the MVP version.

Future contract extensions require verified data support and review of permitted use, for example:

- accessibility information
- elevation
- route warnings
- richer crowd data
- generated route alternatives

New fields should be added without unnecessarily renaming the existing MVP fields.

This shape is not a grant of persistence or AI-use permission. Tencent WebService
data-use boundaries remain unconfirmed; do not add raw response persistence or a
persistent segment L2 cache. `activeWalkSession` currently stores a route snapshot
locally and remains a deployment/data-policy checkpoint. Actual GPS trajectory via
Track Cloud is a separate flow. See [deployment and data boundaries](map-provider-deployment.md).
