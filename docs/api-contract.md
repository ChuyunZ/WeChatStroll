# Frontend APIs

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

## POST /walks/{walkId}/feedback

Save current user's feedback to the walk.

### URL Params
walkId

### Data Params

```json
{
  "routeId": "route_143",
  "rating": 4,
  "feedbackTags": [
    "too_crowded",
    "distance_too_long"
  ]
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

Returns up to three routes for current user, get preferences from getUserPreferences().

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

## getUserPreferences()

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

## updateOrCreateUserPreferences()

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

## updatePreferenceFromFeedback()

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

Generate up to three routes based on current user preferences.

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