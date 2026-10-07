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
inputs. CloudBase-injected `event.userInfo` is ignored and is never used for
identity. Other additional request fields (including ownerKey, walk IDs, records,
weights, profile or OPENID) are rejected. Authentication is exclusively server
context via `cloud.getWXContext()`.

The [version-1 public schema](preference-profile.md#canonical-history-and-schema)
contains bounded environment/duration/crowd signals, ordered tag arrays, evidence
counts, nested explainability, source metadata and `lastUpdatedAt`. It never
contains ownerKey, revision, comments, raw history, geometry or provider data.
The client rejects unknown/malformed fields, including any public ownerKey.

Failures use `{ "success": false, "error": { "code", "message" } }` with codes
`UNAUTHENTICATED`, `INVALID_ACTION`, `INVALID_INPUT`, or
`PREFERENCE_PROFILE_STORE_FAILED`. Database details are not exposed. Conflict
exhaustion is a normalized storage failure; callers may retry refresh later.
Unchanged history preserves the saved timestamp and values. Concurrent refreshes
use a revision fence and reread history on conflicts. No feedback transaction,
current-questionnaire update, planning or UI integration is part of this API.

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

## GET /user/walk-history

Returns the walking history of the current user.

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
