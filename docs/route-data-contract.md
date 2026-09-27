# Route Data Contract

This document defines the shared route data structure used by the WeChatStroll frontend, backend, and future AI route-generation components.

The goal is to make sure every part of the application uses the same field names and data formats.

## 1. Route object

| Field | Type | Required | Description |
|---|---|---:|---|
| `routeId` | string | Yes | Unique identifier for the route |
| `title` | string | Yes | User-facing route title |
| `durationMinutes` | number | Yes | Estimated walking duration in minutes |
| `durationSeconds` | number | For optimized routes | Complete walking duration used for ordering; minutes are rounded up for display |
| `routeOrder` | object | For optimized routes | `orderedWaypointIds` and `source: "optimized"` |
| `candidateWaypointIds` | string[] | For optimized routes | Original AI-selected IDs, before reordering |
| `recommendedWaypointIds` | string[] | For optimized routes | Recommended permutation of the complete candidate set |
| `optimization` | object | For optimized routes | Search strategy, evaluated order count, cost, target error and budget metadata; see [waypoint ordering](waypoint-order-optimization.md) |
| `distanceMeters` | number | Yes | Estimated walking distance in meters |
| `routeType` | string | Yes | Shape/type of the route |
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

## 5. PointOfInterest

```json
{
  "name": "Riverside Viewing Platform",
  "type": "scenic",
  "latitude": 31.2312,
  "longitude": 121.4751
}
```

Fields:

| Field | Type | Required | Description |
|---|---|---:|---|
| `name` | string | Yes | Point-of-interest name |
| `poiId` | string | For optimized routes | Verified POI ID, preserved through route detail navigation |
| `type` | string | Yes | Category such as `scenic`, `park`, `cafe`, or `rest_area` |
| `latitude` | number | Yes | Latitude |
| `longitude` | number | Yes | Longitude |

The POI `type` list does not need to be fully standardized during Week 1. It can be refined when real map data is integrated.

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
      "type": "scenic",
      "latitude": 31.2312,
      "longitude": 121.4751
    }
  ],
  "updatedAt": "2026-08-08T00:00:00+08:00"
}
```

## 9. Notes for later development

This contract is the MVP version.

When real map APIs and AI route generation are integrated, the team can extend the object with additional information such as:

- source/provider information
- accessibility information
- elevation
- route warnings
- richer crowd data
- generated route alternatives

New fields should be added without unnecessarily renaming the existing MVP fields.
