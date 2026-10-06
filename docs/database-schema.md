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

# 3. Routes Collection (historical proposal; persistence blocked)

**This section is not authoritative permission to persist planned routes.** The examples
below describe an earlier proposal, not an implemented/approved CloudBase collection.
Tencent WebService persistence and AI-use remain blocked pending written confirmation
under #94. See [data policy](route-data-contract.md) and
[deployment checkpoint](map-provider-deployment.md#data-use-and-deployment-checkpoint).
Issue #79 does not write this collection or planned-route/POI data.

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

# 4. Walk lifecycle collections (Issue #79, schema version 1)

The walkStore Cloud Function owns **walks** and **active_walks**. Authentication
comes only from cloud.getWXContext().OPENID; no user provisioning is required.
The owner key is the SHA-256 hex digest of that authenticated OpenID. It is not
returned to clients and raw OpenID is never used as a document ID.

| Walk field | Stored value |
| --- | --- |
| _id / walkId | Random opaque 128-bit identifier of the same lifecycle document |
| ownerKey | Server-derived user hash used for ownership checks |
| status | active, completed, ended_early, or abandoned |
| routeId | Application route identity; not a reference to a persisted Routes snapshot |
| preferences | Allowlisted questionnaire: durationMinutes, routeType, crowdPreference, environmentPreferences |
| requestedDurationMinutes / routeType | Copied from the questionnaire, not provider estimates |
| startTime | Server-generated ISO timestamp |
| endTime | Null while active or abandoned; user-confirmed timestamp for completed / ended_early |
| actualDurationSeconds | Zero while active; server-computed for completed / ended_early; null when abandoned because the real end is unknown |
| completionStatus | Null while active; completed / ended_early after user completion; abandoned after stale-session cleanup |
| trajectoryEnabled | Explicit consent choice captured at start |
| trajectoryPartial | Conservative quality flag; true for opted-in walks pending trajectory cleanup |
| trajectoryEndTimeMs | Null while active or abandoned; confirmation/query boundary for completed / ended_early |
| schemaVersion | 1 |
| createdAt / updatedAt | Server-generated ISO timestamps |

A deterministic active_walks/{ownerKey} document holds { walkId }.
Start transactionally reads that lock, returns its existing active walk, or creates
a walk and sets the lock atomically. Completion checks ownership, updates the same
walk, and clears only its matching lock to { walkId: null }. This tombstone
continues to provide a deterministic transaction fence. There is no query-then-add
race and no dependency on a process-local mutex. Explicit transactions retry only
recognized conflicts, at most four attempts with bounded backoff.

Allowed terminal transitions are **active -> completed**, **active -> ended_early**,
and server-driven **active -> abandoned** after 12 hours. `abandoned` means the
user never supplied a trustworthy Finish / End Early boundary: `endTime`,
`actualDurationSeconds`, and `trajectoryEndTimeMs` therefore remain null instead
of fabricating a 12-hour walk. Repeating the same user terminal status returns the
original record without changing its time; a different terminal status is rejected.
Database failures return normalized errors. Navigation and Track Cloud failures
cannot reactivate any terminal walk.

The four actions are startWalk, getActiveWalk, getWalk and completeWalk.
All read/write operations are scoped to authenticated ownership. The response is
{ success: true, walk } (null only for no active walk), or
{ success: false, error: { code, message } }.

## Local recovery and trajectory boundary

Local activeWalkSession version 2 stores walkId, the LOCAL route snapshot,
questionnaire, original cloud start time and tracking choice. v1/malformed sessions
are discarded and their stale tracking is stopped; they are never treated as durable.
The 12-hour active-walk limit is enforced by `walkStore` using server time, not
by deleting only the local session. `getActiveWalk`, `getWalk`, `startWalk`,
and late `completeWalk` access all converge stale active records to `abandoned`.
`startWalk` may abandon an expired lock and create its replacement atomically in the
same transaction. Track Cloud keeps its independent 12-hour tracking expiry.

Before resuming, the client checks the specific cloud walk. completed / ended_early
stops stale tracking, clears the local active lock and reconstructs the local pending
Feedback result when the route is available. abandoned stops stale tracking and
clears the local lock but deliberately does **not** create a Feedback payload. Missing local geometry plus a cloud
active walk blocks a second walk. The current route can restore it only if its ID
matches and map geometry is available; cloud reconstruction is not implemented.

The client saves its completion intent (state and confirmation time) with the local
active session before requesting completion. Database failure leaves it retryable.
After cloud success the local pending result is saved, the active session is cleared,
and the existing Track Cloud final flush runs. Local quality and trajectory query
boundary are then updated without changing the logical end time. The cloud record
remains conservative: this issue does not write back post-flush quality; consumers
must not interpret its partial flag or an empty trace query as proof of no trajectory.
Feedback navigation failure retains the terminal result for later recovery. Issue #80
Feedback authoring remains out of scope.

## Data excluded from CloudBase

No full route, polyline, POI records/IDs, selectedWaypointIds, providerMeta, raw provider
response, walking segments, planned coordinates or GPS samples are uploaded by this
flow. Questionnaire data is user input. The existing complete route snapshot stays
local for map rendering, subject to the existing data-policy checkpoint. Actual GPS
geometry remains exclusively in Tencent Track Cloud; no segment cache is introduced.

## Manual rollout later (not performed by this change)

1. Create walks and active_walks in the intended CloudBase environment.
2. Configure these collections for server-only access (deny direct Mini Program reads
   and writes); ownership enforcement is in walkStore. No custom query index is
   required: operations use document IDs.
3. Deploy cloudfunctions/walkStore with its locked dependencies, then release the
   client changes together. It uses DYNAMIC_CURRENT_ENV and needs no new variables.
4. On a test account, verify Start/retry, concurrent Start, app recreation, Finish/End
   Early, 12-hour abandonment/replacement, offline retry, missing local route and
   Feedback navigation failure.

These are future operator steps only. This implementation does not deploy functions,
change console permissions/environment variables or mutate live documents. It does
not establish Tencent planned-route persistence approval.

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

The currently implemented Issue #79 ownership/lifecycle relationship is:

```text
authenticated OPENID
    ↓ SHA-256 (server only)
ownerKey
    ↓
active_walks/{ownerKey}.walkId
    ↓
walks/{walkId}
```

`walks.routeId` is an application route identity only. It is **not** a foreign key
to a persisted `routes` collection while planned-route persistence remains blocked
under the Tencent data-use checkpoint.

The Users, Preferences, Routes, and Feedback sections above include historical/future
schema proposals that are not all implemented today. In particular, Issue #79 does
not write `walks.userId`, and the blocked Routes proposal must not be treated as an
implemented relationship. Future Feedback should reference the durable `walkId`
without weakening the server-side ownership checks introduced by `walkStore`.