# 1. Users Collection

## Example User Document

```json
{
  "_id": "user_1837",
  "openid": "oAbC123xyz",
  "username": "Tom",
  "totalWalks": 5,
  "createdAt": "2026-08-13T10:00:00+08:00"
}
```

## Fields

| Field | Type | Required | Description | Example |
| --- | --- | ---: | --- | --- |
| `_id` | string | Yes | Unique identifier for the user record in the database | `"user_1837"` |
| `openid` | string | Yes | WeChat OpenID used to identify the user within the mini program | `"oAbC123xyz"` |
| `username` | string | Yes | User-facing display name | `"Tom"` |
| `totalWalks` | number | Yes | Total number of walks created by the user | `5` |
| `createdAt` | string | Yes | Time the user record was created in ISO 8601 format | `"2026-08-13T10:00:00+08:00"` |

---

# 2. Preferences Collection

The `preferences` collection stores location-based walking preferences for each user.

A user may have multiple preference records associated with different locations. When recommending routes, the backend first searches for a preference within 2 km of the user's current location. If no matching preference is found, the user's most frequently used preference is used as the fallback.

Preferences are initially generated from questionnaire answers and may later be updated through walk history and feedback analysis.

## Example Preference Document

```json
{
  "_id": "preference_001",
  "userId": "user_1837",
  "location": {
    "latitude": 31.2304,
    "longitude": 121.4737
  },
  "durationMinutes": 30,
  "crowdPreference": "medium",
  "environmentPreferences": [
    "park",
    "river"
  ],
  "routeType": "loop",
  "usageCount": 5
}
```

## Fields

| Field | Type | Required | Description | Example |
| --- | --- | ---: | --- | --- |
| `_id` | string | Yes | Unique identifier for the preference record | `"preference_001"` |
| `userId` | string | Yes | `_id` of the user who owns this preference | `"user_1837"` |
| `location` | object | Yes | Location associated with this walking preference | See GeoPoint |
| `durationMinutes` | number | Yes | Preferred walking duration in minutes | `30` |
| `crowdPreference` | string | Yes | Preferred crowd level | `"medium"` |
| `environmentPreferences` | string[] | Yes | Preferred environment or route features | `["park", "river"]` |
| `routeType` | string | Yes | Preferred route shape/type | `"loop"` |
| `usageCount` | number | Yes | Number of times this preference has been used for route recommendations | `5` |

### Allowed `crowdPreference` Values

- `low`
- `medium`
- `high`

### Allowed `routeType` Values

- `loop`
- `out_and_back`
- `point_to_point`

`GeoPoint` follows the definition in `docs/route-data-contract.md`.

---

# 3. Routes Collection

The route structure mainly follows `docs/route-data-contract.md`.

## Example Route Document

```json
{
  "_id": "route_001",
  "title": "Riverside Relaxing Walk",
  "durationMinutes": 32,
  "distanceMeters": 2600,
  "routeType": "loop",
  "crowdLevel": "medium",
  "tags": [
    "river",
    "quiet",
    "trees"
  ],
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
  "updatedAt": "2026-09-05T00:00:00Z"
}
```

## Fields

| Field | Type | Required | Description | Example |
| --- | --- | ---: | --- | --- |
| `_id` | string | Yes | Unique identifier for the route | `"route_001"` |
| `title` | string | Yes | User-facing route title | `"Riverside Relaxing Walk"` |
| `durationMinutes` | number | Yes | Estimated walking duration in minutes | `32` |
| `distanceMeters` | number | Yes | Estimated route distance in meters | `2600` |
| `routeType` | string | Yes | Shape/type of the route | `"loop"` |
| `crowdLevel` | string | Yes | Estimated crowd level | `"medium"` |
| `tags` | string[] | Yes | Environment and route features | `["river", "quiet", "trees"]` |
| `description` | string | Yes | Longer description of the route | `"A mostly riverside route with several resting areas."` |
| `recommendationReason` | string | Yes | Explanation of why the route was recommended | `"This route matches your preference."` |
| `startPoint` | object | Yes | Starting location of the route | See LocationPoint |
| `endPoint` | object | Yes | Ending location of the route | See LocationPoint |
| `polyline` | object[] | Yes | Ordered coordinates used to draw the route on the map | See GeoPoint |
| `pointsOfInterest` | object[] | No | Interesting places located along the route | See PointOfInterest |
| `updatedAt` | string | Yes | Last update time in ISO 8601 format | `"2026-09-05T00:00:00Z"` |

`LocationPoint`, `GeoPoint`, `PointOfInterest`, `routeType`, and `crowdLevel` follow the definitions in `docs/route-data-contract.md`.

---

# 4. Walks Collection

## Example Active Walk Document

```json
{
  "_id": "walk_001",
  "userId": "user_1837",
  "routeId": "route_001",
  "durationMinutes": 0,
  "distanceMeters": 0,
  "completed": false,
  "startTime": "2026-08-13T14:30:00+08:00",
  "endTime": null
}
```

## Example Completed Walk Document

```json
{
  "_id": "walk_001",
  "userId": "user_1837",
  "routeId": "route_001",
  "durationMinutes": 32,
  "distanceMeters": 2540,
  "completed": true,
  "startTime": "2026-08-13T14:30:00+08:00",
  "endTime": "2026-08-13T15:02:00+08:00"
}
```

## Fields

| Field | Type | Required | Description | Example |
| --- | --- | ---: | --- | --- |
| `_id` | string | Yes | Unique identifier for the walk | `"walk_001"` |
| `userId` | string | Yes | `_id` of the user who owns the walk | `"user_1837"` |
| `routeId` | string | Yes | `_id` of the route used for the walk | `"route_001"` |
| `durationMinutes` | number | Yes | Actual duration of the walk in minutes | `32` |
| `distanceMeters` | number | Yes | Actual distance walked in meters | `2540` |
| `completed` | boolean | Yes | Whether the walk has been completed | `true` |
| `startTime` | string | Yes | Time the walk started in ISO 8601 format | `"2026-08-13T14:30:00+08:00"` |
| `endTime` | string \| null | Yes | Time the walk ended. `null` while the walk is still active | `"2026-08-13T15:02:00+08:00"` |

A newly created walk should use:

```json
{
  "durationMinutes": 0,
  "distanceMeters": 0,
  "completed": false,
  "endTime": null
}
```

When the walk is finished, the backend updates the duration, distance, completion status, and end time.

---

# 5. Feedback Collection

The `feedback` collection stores feedback submitted after a walk.

Each feedback record is associated with a specific user and walk.

## Example Feedback Document

```json
{
  "_id": "feedback_001",
  "userId": "user_1837",
  "walkId": "walk_001",
  "routeId": "route_001",
  "rating": 4,
  "feedbackTags": [
    "too_crowded",
    "distance_too_long"
  ],
  "comment": "The route was nice but slightly crowded."
}
```

## Fields

| Field | Type | Required | Description | Example |
| --- | --- | ---: | --- | --- |
| `_id` | string | Yes | Unique identifier for the feedback record | `"feedback_001"` |
| `userId` | string | Yes | `_id` of the user who submitted the feedback | `"user_1837"` |
| `walkId` | string | Yes | `_id` of the walk being reviewed | `"walk_001"` |
| `routeId` | string | Yes | `_id` of the route associated with the walk | `"route_001"` |
| `rating` | number | Yes | User rating for the completed walk | `4` |
| `feedbackTags` | string[] | Yes | Structured feedback tags selected by the user | `["too_crowded", "distance_too_long"]` |
| `comment` | string | No | Optional free-text feedback | `"The route was nice but slightly crowded."` |

Rating range:

- `1`
- `2`
- `3`
- `4`
- `5`

Example feedback tags:

- `too_crowded`
- `too_quiet`
- `distance_too_long`
- `distance_too_short`
- `duration_too_long`
- `duration_too_short`
- `nice_view`
- `comfortable_route`

---

# 6. Collection Relationships

The collections are connected using IDs rather than embedding complete related documents.

```text
users._id
    ↓
preferences.userId

users._id
    ↓
walks.userId

routes._id
    ↓
walks.routeId

walks._id
    ↓
feedback.walkId

routes._id
    ↓
feedback.routeId
```