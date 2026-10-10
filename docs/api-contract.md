# Frontend APIs

The historical HTTP and location/current-preference proposals below are not the
Issue #81 personalization contract. The implemented historical profile API is
`preferenceProfileStore` (`getProfile` / `refreshProfile`), documented below.

These APIs are called by the WeChat mini program frontend.

---

# Users (all fields are required)

## User Object

```json
{
  "userId": "string",
  "username": "string"
}
```

---

## GET /user/profile

Returns the profile of the current user.

### URL Params

None

### Data Params

None

### Headers

Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content:**

```json
{
  "success": true,
  "data": {
    "userId": "user_001",
    "username": "Tom"
  }
}
```

### Error Response

#### Unauthorized

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

---

## POST /user/questionnaire

Save current user's answers to questionnaire at current location.

### URL Params
None

### Data Params

```json
{
  "answers": [
    {
      "questionId": "q1",
      "answer": "I prefer quiet places with trees"
    },
    {
      "questionId": "q2",
      "answer": "Around 30 minutes"
    }
  ],
  "location":{
    "latitude":31.2304,
    "longitude":121.4737
  }
}
```

### Headers

Content-Type: application/json
Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content**

```json
{
  "success": true
}
```
### Error Response

#### Bad Request

**Code:** 400 Bad Request

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"INVALID_REQUEST",
   "message":"Invalid request parameters."
 }
}
```

#### Unauthorized

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

---

## preferenceProfileStore Cloud Function (Issue #81)

Call `wx.cloud.callFunction` with `name: 'preferenceProfileStore'`, via
`miniprogram/services/preference-profile-records.js`:

| Service method | Exact data | Behavior |
| --- | --- | --- |
| `getProfile()` | `{ "action": "getProfile" }` | Read saved snapshot, without recalculating |
| `refreshProfile()` | `{ "action": "refreshProfile" }` | Load bounded own canonical history, recompute and conditionally save snapshot |

Both return `{ "success": true, "profile": null }` when no snapshot/evidence
exists, otherwise `{ "success": true, "profile": { ... } }`. The service unwraps
and strictly validates the public profile. It sends no history or computation
inputs. The handler reads only `event.action`; all other event fields
(including CloudBase-injected metadata or caller-supplied ownerKey, OPENID, walk IDs,
records, weights, profile or history) are ignored and cannot influence identity,
history loading or profile computation. Authentication is exclusively server context
via `cloud.getWXContext()`.

The [version-1 public schema](preference-profile.md#canonical-history-and-schema)
contains bounded environment/duration/crowd signals, ordered tag arrays, evidence
counts, nested explainability, source metadata and `lastUpdatedAt`. It never
contains ownerKey, revision, comments, raw history, geometry or provider data.
The client rejects unknown/malformed fields, including any public ownerKey.

Failures use `{ "success": false, "error": { "code", "message" } }` with codes
`UNAUTHENTICATED`, `INVALID_ACTION`, or `PREFERENCE_PROFILE_STORE_FAILED`. Database details are not exposed. Conflict
exhaustion is a normalized storage failure; callers may retry refresh later.
Unchanged history preserves the saved timestamp and values. Concurrent refreshes
use a revision fence and reread history on conflicts. No feedback transaction,
current-questionnaire update or UI integration is part of this API. Route planning
consumes `refreshProfile()` as described below.

## aiRoutePlanner historical input (Issue #82)

The existing `startPoint`, `preferences`, `nearbyPois` and optional
`replanningContext` inputs now accept an optional `historicalPreferenceProfile`:

```js
{
  environmentWeights: { park, water, street, shoppingStreet }, // each finite 0–1
  preferredDurationMinutes, // null or 15–120, multiple of 5
  crowdPreferenceSignal, // null or finite -1–1
  likedTags, // unique positive allowlisted tags, at most 4
  dislikedTags, // unique negative allowlisted tags, at most 8
  evidenceWalkCount // integer 1–20
}
```

Positive tags: `nice_view`, `quiet`, `comfortable_route`, `duration_good`.
Negative tags: `too_crowded`, `too_quiet`, `distance_too_long`, `distance_too_short`,
`duration_too_long`, `duration_too_short`, `route_hard_to_walk`, `pois_not_interesting`.

`generateRoutes()` refreshes once after finding nearby POIs and before the AI loop,
then projects the validated public profile into these six fields. Replanning reuses
that snapshot. Missing/malformed/unavailable profiles, including refresh errors,
are non-fatal: omit the history field entirely rather than sending null. No raw
evidence, source metadata, ownership, timestamps, other counts, history records,
feedback comments, historical location/geometry or provider data are sent to AI.

The cloud prompt builder independently normalizes this untrusted optional input.
Extra top-level fields are stripped; malformed required fields, unknown or duplicate
tags, oversized arrays and non-exact environment keys cause history to be ignored.
They do not produce `INVALID_AI_ROUTE_INPUT`; core inputs retain strict validation.
Without valid history, the original prompt remains unchanged.

The AI prompt explicitly instructs the planner to prioritize the current duration,
route type, crowd preference and environment ranking over conflicting history. This
is prompt-level guidance for soft waypoint selection; hard downstream validation and
Route Engine facts remain authoritative. History is only a secondary personalization
signal, never current POI/crowd/walkability facts. The prompt also explains the
direction of environment/crowd signals and treats smaller evidenceWalkCount values as
weaker history. Output schema and verified POI ID validation are unchanged. Current
requested duration still controls POI discovery, optimization and route validation;
deterministic fallback does not consume history.

## feedbackStore Cloud Function (Issue #80)

Call wx.cloud.callFunction with name "feedbackStore" and the data below, through
miniprogram/services/feedback-records.js. This replaces the historical HTTP
feedback endpoint. Identity comes from server-side cloud.getWXContext().OPENID;
no OAuth header, userId, ownerKey, routeId, or route snapshot is sent.

### getFeedback

Input: { "action": "getFeedback", "walkId": "walk_001" }.
Success: { "success": true, "feedback": null } when absent, or the public
feedback object when already saved. The walk must exist and belong to the caller.

### submitFeedback

~~~json
{
  "action": "submitFeedback",
  "walkId": "walk_001",
  "rating": 4,
  "observedCrowdLevel": "medium",
  "wouldRecommend": false,
  "positiveTags": ["nice_view"],
  "negativeTags": ["too_crowded"],
  "comment": "A pleasant walk."
}
~~~

Required: valid walkId, integer rating 1-5, observedCrowdLevel low/medium/high,
real boolean wouldRecommend, and both tag arrays (empty allowed). Comment is
optional, trimmed, empty becomes null, maximum input length 500 characters.
Positive tags: nice_view, quiet, comfortable_route, duration_good.
Negative tags: too_crowded, too_quiet, distance_too_long, distance_too_short,
duration_too_long, duration_too_short, route_hard_to_walk, pois_not_interesting.
Duplicates and wrong-group tags are rejected. walkId uses 1-200 ASCII letters,
digits, underscore, period, colon, or hyphen. Unknown request fields are ignored.

Success: { "success": true, "feedback": { ... }, "created": true }.
Existing submissions return the original object with created: false, including
response-loss retries and concurrent requests. Values are never overwritten.
Public feedback contains exactly walkId, routeId, rating, observedCrowdLevel,
wouldRecommend, positiveTags, negativeTags, comment, schemaVersion: 1, and
server-generated ISO createdAt. ownerKey is never returned; routeId is copied
from the authoritative walk.

Only completed/ended_early walks accept submissions. Ownership checks, eligibility,
and deterministic feedback/{walkId} creation occur in one transaction.
No feedback operation changes the walk lifecycle. Skip is local-only and calls no
feedback write API. Local pending results are cleared only after confirmed success
or explicit Skip, and only if their walkId matches.

Errors: { "success": false, "error": { "code": "...", "message": "..." } }.
Codes: UNAUTHENTICATED, INVALID_ACTION, INVALID_INPUT, WALK_NOT_FOUND
(same for missing/another user's walk), FEEDBACK_NOT_ALLOWED (active/abandoned),
and FEEDBACK_STORE_FAILED (normalized database failure; safe to retry).
See [the implemented schema](database-schema.md#5-feedback-collection).

---

# Walking History (Issue #87 Phase 1)

Cloud Function `walkStore` accepts `{ action: 'listHistory', limit: 10, cursor: null }`.
Success returns `{ success: true, items, nextCursor, totals }`. Limits are 1–20;
subsequent pages pass the returned cursor and receive `totals: null`. See the
[complete History contract](walking-history.md) for exact item/cursor fields,
count semantics, errors, validation, privacy and concurrency limits. Phase 2's
[Profile UI](profile-ui.md) consumes this unchanged action for lifetime statistics
and paginated history, and independently calls `refreshProfile()` for explainable
preferences. History Detail and GPS display remain Phase 3B.

## Historical GPS query (Issue #87 Phase 3A, local implementation)

`trackProvider` accepts only `{ action: 'searchWalkTrace', walkId }` as application
fields, authorizes the persisted owner/terminal state/consent and derives the time
range from startTime and the fixed completion endTime. Mutable trajectoryEndTimeMs
cannot extend this range; later cleanup metadata makes the result partial and
post-completion samples are omitted. It returns `{ success: true, trace }`;
the dedicated `history-trace.searchWalkTrace({ walkId })` Service returns the
validated trace with bounded empty-result retries. Generic public `searchTrace`
range requests are retired. See the [complete trace contract](history-trace.md)
for exact point/metric fields, errors, boundary filtering, shared-Entity isolation
limitations and legacy migration. No UI integration or deployment is included.

# Walk (all fields are required)

`endTime` is nullable while the walk is in progress.

## Walk Object

```json
{
  "walkId": "string",
  "userId": "string",
  "routeId": "string",
  "durationMinutes": "number",
  "distanceMeters": "number",
  "completed": "boolean",
  "startTime": "string",
  "endTime": "string"
}
```

---

## POST /walks

Creates a walk when current user starts to walk.

### URL Params

None

### Data Params
```json
{
  "routeId": "route_143"
}
```

### Headers

Content-Type: application/json
Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content:**

```json
{
  "success": true,
  "data": {
    "walkId": "w001"
  }
}
```

### Error Response

#### Bad Request

**Code:** 400 Bad Request

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"INVALID_REQUEST",
   "message":"Invalid request parameters."
 }
}
```

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

---

## PATCH /walks/{walkId}/finish

Finishes a walk when current user ends the walk.

### URL Params

walkId

### Data Params
```json
{
  "durationMinutes": 10,
  "distanceMeters": 1000
}
```

### Headers

Content-Type: application/json
Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content:**

```json
{
  "success": true,
  "data": {
    "completed": true
  }
}
```

### Error Response

#### Bad Request

**Code:** 400 Bad Request

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"INVALID_REQUEST",
   "message":"Invalid request parameters."
 }
}
```

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

---

## GET /user/walk-history (historical proposal — not implemented)

The HTTP endpoint and example fields below are an old proposal, **not** the current
Mini Program history API. Use `walkStore.listHistory` as documented in
[Walking History](walking-history.md). In particular, the current API does not
persist or return planned-route distances or user IDs.

The original proposal described returning the walking history of the current user.

### URL Params

None

### Data Params

None

### Headers

Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content:**

```json
{
  "success": true,
  "data": {
    "walkHistory": [
      {
        "walkId": "123",
        "userId": "cyuName",
        "routeId": "route_12",
        "durationMinutes": 32,
        "distanceMeters": 1232.4,
        "startTime": "2026-08-10T10:00:00Z",
        "endTime": "2026-08-10T10:30:00Z",
        "completed": true
      },
      {
        "walkId": "23",
        "userId": "cyuName",
        "routeId": "route_118",
        "durationMinutes": 12,
        "distanceMeters": 800,
        "startTime": "2026-08-04T11:00:00Z",
        "endTime": "2026-08-04T11:12:00Z",
        "completed": false
      }
    ]

  }
}
```

### Error Response

#### User Not Found

**Code:** 404 Not Found

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User does not exist."
  }
}
```

#### Unauthorized

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

# Route (Refer to docs/route-data-contract.md for required and optional fields)

## POST /route/recommend

Returns route recommendations for the current user using preferences from getUserPreferences().

The route-planning engine does not hardcode a maximum recommendation count. Any product-level limit on how many recommendations a user may receive or switch between is enforced outside the route engine.

### URL Params

None

### Data Params

```json
{
  "location":
  {
   "latitude": 31.2304,
   "longitude": 121.4737
  }
}
```

### Headers

Content-Type: application/json
Authorization: Bearer <OAuth Token>

### Success Response

**Code:** 200 OK

**Content:**

```json
{
  "success": true,
  "data": {
    "routes": [
      {
        "routeId": "route_001",
        "title": "Riverside Relaxing Walk",
        "durationMinutes": 32,
        "distanceMeters": 2600,
        "routeType": "loop",
        "crowdLevel": "medium",
        "tags": [
          "river",
          "trees"
        ],
        "description": "A quiet riverside route.",
        "recommendationReason": "This route matches your preference.",
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
          },
          {
            "latitude": 31.2304,
            "longitude": 121.4737
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
        "updatedAt": "2026-08-11T15:00:00+08:00"
      },
      {
        "routeId": "route_002",
        "title": "Shopping Busy Walk",
        "durationMinutes": 32,
        "distanceMeters": 2600,
        "routeType": "loop",
        "crowdLevel": "high",
        "tags": [
          "shopping_mall",
          "cafe"
        ],
        "description": "A lively walking route through shopping streets and nearby cafes.",
        "recommendationReason": "This route provides a more lively walking environment while matching your preferred duration.",
        "startPoint": {
          "name": "Central Shopping Street Entrance",
          "latitude": 31.2289,
          "longitude": 121.4721
        },
        "endPoint": {
          "name": "Central Shopping Street Entrance",
          "latitude": 31.2289,
          "longitude": 121.4721
        },
        "polyline": [
          {
            "latitude": 31.2289,
            "longitude": 121.4721
          },
          {
            "latitude": 31.2298,
            "longitude": 121.4740
          },
          {
            "latitude": 31.2289,
            "longitude": 121.4721
          }
        ],
        "updatedAt": "2026-08-11T15:00:00+08:00"
      }
    ]
  }
}
```

### Error Response

#### Bad Request

**Code:** 400 Bad Request

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"INVALID_REQUEST",
   "message":"Invalid request parameters."
 }
}
```

**Code:** 401 Unauthorized

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are unauthorized to make this request."
  }
}
```

#### Route Not Found

**Code:** 404 Not Found

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "NO_ROUTE_FOUND",
    "message": "No suitable routes found."
  }
}
```

#### Location Unavailable

**Code:** 422 Unprocessable Entity

**Content:**

```json
{
  "success": false,
  "error": {
    "code": "LOCATION_UNAVAILABLE",
    "message": "Unable to obtain the current location."
  }
}
```

### Database Connection Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"DATABASE_ERROR",
   "message":"Unable to access database."
 }
}
```

### Cloud Function Error

**Code:** 500 Internal Server Error

**Content:**

```json
{
 "success":false,
 "error":{
   "code":"CLOUD_FUNCTION_ERROR",
   "message":"Cloud function failed."
 }
}
```

# Internal Cloud Functions

These functions are used internally by backend services.

---

## getUserPreferences() (historical proposal; not Issue #81)

Returns the user's saved walking preference associated with the current location. If no preference is found within the configured matching radius, returns the user's most frequently used preference.

### Input

```json
{
  "location":{
    "latitude":31.2304,
    "longitude":121.4737
  }
}
```

### Output

```json
{
  "preferences": {
      "durationMinutes":30,
      "crowdPreference":"medium",
      "environmentPreferences":[
          "park",
          "river"
      ],
      "routeType":"loop"
  }
}
```

---

## updateOrCreateUserPreferences() (historical proposal; not Issue #81)

Updates current user preferences after AI analysis.

### Input

```json
{
  "preferences": {
      "durationMinutes":30,
      "crowdPreference":"medium",
      "environmentPreferences":[
          "park",
          "river"
      ],
      "routeType":"loop"
  },
  "location":{
    "latitude":31.2304,
    "longitude":121.4737
  }
}
```

### Output

```json
{
  "success": true
}
```

---

## analyzeQuestionnaire()

Use AI to analyze user's answers to questionnaire.

### Input
```json
{
  "answers": [
    {
      "questionId": "q1",
      "answer": "quiet places"
    },
    {
      "questionId": "q2",
      "answer": "Around 30 minutes"
    }
  ],
    "location":{
    "latitude":31.2304,
    "longitude":121.4737
  }
}
```

### Output

```json
{
  "preferences": {
      "durationMinutes":30,
      "crowdPreference":"medium",
      "environmentPreferences":[
          "park",
          "river"
      ],
      "routeType":"loop"
  }
}
```

---

## updatePreferenceFromFeedback() (historical proposal; not Issue #81)

Update preferences for current route.

### Input
```json
{
  "walkHistory": [
    {
      "routeId": "route_12",
      "durationMinutes": 32,
      "distanceMeters": 1232.4,
      "completed": false
    }
  ],
  "feedback": {
    "rating":3,
    "feedbackTags":[
      "too_crowded",
      "too long"
    ]
  }
}
```

### Output

None

---

## generateRoutes()

Generate route recommendations based on current user preferences.

The mini-program service signature is `generateRoutes(preferences)`. Its success
result contains `status`, `source`, `routes`, `location`, `routePlanningSession`,
`waypointCandidateCache`, `planningMetadata`, and `historicalPreferenceProfile`.
The history field is the same compact snapshot used by all AI planning attempts
in this invocation (or `null` when unavailable), including fallback success. It
is runtime-only. The Routes page keeps it in `_historicalPreferenceProfile`,
outside `data`, and clears it on reload/unload; ranking never reloads the profile.

Only complete routes that pass existing route validation reach the pure local
`route-ranking` service. The first valid route is scored and returned immediately,
without waiting for alternatives. Each successful background fill reranks the
currently displayed set, stopping candidate processing at three routes. Once initial
processing settles, Add inserts one route when fewer than three are displayed;
Replace requires the user to select one of three routes and retains it until a
valid replacement is ready. When candidates are exhausted, each manual action can request up to three new AI batches using the same verified POIs and planning session. Both rerank and share a three-successful-action budget
per session. Exact previously surfaced verified POI sets remain excluded regardless
of order or route ID. See [manual alternatives](waypoint-order-optimization.md#manual-route-alternatives)
for availability, runtime state, cache reuse and failure semantics. An edit
must pass the same completeness validator before its confirmed rebuilt route
replaces the original and triggers reranking. Explicit user edits retain their
existing permission to exceed the questionnaire duration, so their validation
omits the requested-duration constraint; generated recommendations still require
the existing duration gate. Failed candidates/previews never enter ranking.
Candidate generation, fallback selection, validation tolerances, provider calls,
and recommendation reasons are unchanged.

### Runtime ranking API (V1)

`scoreRoute(route, { preferences, historicalPreferenceProfile })` returns
`{ totalScore, baseScore, streetBonus, streetEvidence, components, effectiveWeights, tieBreak }`.
`streetEvidence` here is inspectable runtime data (`null` when unknown), never a
property read from or attached to the Route. See [Street ranking](street-preference-ranking.md).
`rankRoutes(routes, context)` returns a new sorted array of the original route
objects, without modifying inputs or attaching score metadata. Neither method
performs I/O or validates candidates; callers own the validation boundary.

- Duration fit: `max(0, 1 - abs(durationSeconds - 60 * targetMinutes) / (60 * targetMinutes))`.
  Current target is `preferences.durationMinutes`; historical target is
  `historicalPreferenceProfile.preferredDurationMinutes`. Missing/nonpositive
  targets or real durations make the component unavailable (`null`). Display
  `durationMinutes` is never used as a substitute for real seconds.
- Environment fit: arithmetic mean over unique verified `pointsOfInterest[].category`
  values (`park`, `water`, `shoppingStreet`) with available weights. Current weights
  use the category's position in the Chinese questionnaire environment list:
  `[1, 0.67, 0.33, 0]`. History uses `environmentWeights` directly. Repeated POIs
  do not amplify a category; missing category weights are excluded, and a valid
  zero weight remains a real zero. No usable categories means `null`.
- History fit: equal mean of the available historical environment and duration
  components; no usable historical components means `null`.
- Base score: weighted mean of available components, with base weights **0.50 current
  duration / 0.30 current environment / 0.20 history**. Missing components are
  excluded and the remaining weights renormalized, never penalized as zero.
  `effectiveWeights` exposes the actual weights; all components absent gives
  `totalScore: null`. Current intent carries more weight than secondary history;
  this is a weighted preference score, not a lexicographic current-intent veto.
- Total: base score plus a positive-only Street bonus, provisionally at most 0.05.
  Current Street rank 1/2/3/4 gives strength 1/0.5/0/0. **Any valid positive
  classified coverage** is eligible: `0.05 * strength * coverageRatio *
  ordinaryRoadRatio` equals `0.05 * strength * confirmedOrdinaryMeters /
  routeMeters`. Unknown types and uncovered segments never count as confirmed
  ordinary road; they scale the bonus down instead of triggering a threshold.
  There is no `classificationComplete` marker or rounding tolerance.
  Malformed/overcounted provider step distances still invalidate the optional
  evidence. All-missing base remains null.
  Totals are not clamped to 1; the original base components and weights are unchanged.

Ties resolve by total score descending, current duration fit descending, current
environment fit descending, history fit descending, absolute current duration
error ascending, canonical waypoint key ascending, then canonical route-fact key
ascending. Unavailable values sort last only at the corresponding tie step.
The waypoint key is a JSON-encoded sorted unique list of `recommendedWaypointIds`,
falling back to verified POI IDs. The final fact key serializes real seconds,
distance, route type, endpoint coordinates, active waypoint order, ordered POI
IDs/categories/coordinates, and polyline coordinates. It handles missing arrays
and distinguishes legacy/fallback routes sharing a waypoint key. Strings compare
by code units, without locale dependence. Geometry is an identity tie-break only,
never a street or quality inference. Routes with identical stable facts remain
equivalent; their random identities are deliberately not ordered. IDs, timestamps,
AI prose and optimizer runtime metadata never break ties.

V1 excludes crowd history, liked/disliked tags, generic quality scores and
diversity penalties because there is no verified route-level contract for those
ranking signals. Street is separate from both current/historical POI environment
fit and only uses the runtime normalized capability. It does not infer quietness,
views, safety or crowding from POI categories or ordinary-road classification.
The derived UI badge `isBestMatch` marks only index zero when two or more routes
exist. Scores, keys, history snapshots and badges are never added to persisted
Route/Walk snapshots. No guarantee is made that history changes the AI output.

The route-planning session supports Route 1, Route 2, ... Route N without a hardcoded recommendation count. Any future Free, VIP, or other product-level recommendation limit belongs to the product or entitlement layer rather than the route engine.

### Input

```json
{
  "location":{
    "latitude":31.2304,
    "longitude":121.4737
  },
  "preferences":{
    "durationMinutes":30,
    "crowdPreference":"medium",
    "environmentPreferences":[
      "park",
      "river"
    ],
    "routeType":"loop"
  }
}
```

### Output

```json
{
  "routes": [
    "<Route Object>"
  ]
}
```
