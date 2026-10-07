# CloudBase Setup

This document describes how CloudBase is configured for the WeChatStroll mini program and how to verify the setup using the `cloudHealthCheck` and `dbHealthCheck` cloud functions.

## 1. CloudBase Environment

The project uses the following CloudBase development environment:

- Environment name: `cloud1`
- Environment ID: `cloud1-d0g0q6wm2e49d23d0`

The environment is currently used for development and technical validation.

## 2. Project Configuration

The project uses the following cloud function root in `project.config.json`:

```json
{
  "cloudfunctionRoot": "cloudfunctions/"
}
```

This tells WeChat Developer Tools that cloud functions are stored in the `cloudfunctions` directory.

## 3. CloudBase Initialization

CloudBase is initialized when the mini program launches.

In `miniprogram/app.js`:

```javascript
wx.cloud.init({
  env: 'cloud1-d0g0q6wm2e49d23d0',
  traceUser: true
})
```

The environment ID identifies which CloudBase environment the mini program should use.

## 4. Cloud Function Structure

Cloud functions are stored under:

```text
cloudfunctions/
```

Current planned-route cloud architecture:

- `mapProvider`: provider-neutral `nearbyPois` and `walkingRoute` actions backed by Tencent Maps.
- `getNearbyPois` and `getWalkingRoute`: legacy wrappers forwarding to `mapProvider`.
- `aiRoutePlanner`: verified POI selection; real route facts come from the map provider and Route Engine.
- `amapProvider`: historical/rollback implementation, not the current planned-route provider.
- `trackProvider`: separate actual GPS trajectory flow through Track Cloud.
- `walkStore`: durable walk lifecycle persistence for Issue #79. It owns the
  `walks` and `active_walks` collections, derives ownership from
  `cloud.getWXContext().OPENID`, and stores only allowlisted lifecycle/questionnaire
  metadata. It does not store planned-route geometry, POIs, raw provider responses,
  or GPS samples.

- **feedbackStore**: Issue #80 structured post-walk feedback. Actions getFeedback
  and submitFeedback own feedback/{walkId}, derive ownership from authenticated
  OPENID, read authoritative walks, and transactionally prevent duplicate writes.
  Feedback contains only allowlisted metadata, with no geometry/POIs/GPS.

Issue #80 development rollout status:

1. The `feedback` collection has been created in the development CloudBase
   environment and configured as server-only / ADMINONLY.
2. `cloudfunctions/feedbackStore` has been deployed with its locked dependencies.
   It uses DYNAMIC_CURRENT_ENV, needs no new environment variables or custom query
   indexes, and requires the existing `walks` collection.
3. Manual development E2E validation confirmed authenticated lookup, real
   `ended_early` feedback persistence, duplicate-submit immutability,
   response-loss recovery, and `completed`-walk Skip behavior.
4. The validation did not change Tencent Maps or Track Cloud configuration.

See [map provider deployment](map-provider-deployment.md) for server configuration,
shared limiter state, the 2026-10-04 development smoke/E2E validation record and the
still-unresolved data-use/AI/persistence release checkpoint.

Before releasing the Issue #79 client changes, create `walks` and
`active_walks` in the intended CloudBase environment, configure both for
server-only access, and deploy `cloudfunctions/walkStore` with its locked
dependencies. `walkStore` uses `DYNAMIC_CURRENT_ENV`, requires no new
environment variables, and uses document IDs rather than custom query indexes.

The project also includes two health-check cloud functions:

```text
cloudfunctions/
├── cloudHealthCheck/
│   ├── index.js
│   └── package.json
└── dbHealthCheck/
    ├── index.js
    ├── index.test.js
    └── package.json
```
`cloudHealthCheck` verifies that Cloud Functions can run successfully in the configured CloudBase environment.

`dbHealthCheck` verifies database connectivity by writing a temporary document, reading it back, and deleting it afterward.

The `cloudHealthCheck` function returns:

- a success status
- a short message
- a server timestamp

Example response:

```json
{
  "success": true,
  "message": "Cloud function is working",
  "timestamp": "2026-08-21T05:21:14.978Z"
}
```

## 5. Deploying the Health Check Functions

In WeChat Developer Tools:

1. Make sure the CloudBase environment is set to `cloud1`.
2. Right-click `cloudHealthCheck` and upload and deploy the function.
3. Right-click `dbHealthCheck` and upload and deploy the function.
4. Let the cloud environment install the dependencies defined in each function's `package.json`.

Both functions use the `wx-server-sdk` package.

## 6. Testing the Health Check Functions

### 6.1 Cloud Function Health Check

A test page is available at:

```text
pages/cloud-test/cloud-test
```

The page calls the cloud function using:

```javascript
const response = await wx.cloud.callFunction({
  name: 'cloudHealthCheck'
})
```

If the request succeeds, the page displays:

- success status
- returned message
- server timestamp

### 6.2 Database Health Check

`dbHealthCheck` verifies database connectivity by writing a temporary document to the `users` collection, reading the same document back, and deleting it afterward.

A successful response indicates that database write, read, and delete operations are working.

The function can be invoked directly from the CloudBase console during development.

## 7. Error Handling

The `cloudHealthCheck` call from the test page is wrapped in `try`, `catch`, and `finally`.

If the cloud function call fails, the error is caught and displayed on the test page instead of causing the page to fail silently.

The error handling was tested by temporarily calling a non-existent cloud function and confirming that the error state was displayed correctly.

`dbHealthCheck` also handles database failures with `try/catch`. If an error occurs after the temporary document has been created, the function attempts to remove the document before returning an error response.

## 8. Secrets and API Keys

No API secret, private key, or access token is stored in the mini program frontend.

`TENCENT_MAPS_API_KEY`, `TENCENT_MAPS_SECRET_KEY` and provider configuration belong
only in the `mapProvider` server environment. The Secret Key is used to compute
Tencent WebService GET request signatures (`sig`) and must never be exposed to the
Mini Program. Provider credentials must never be committed or logged. The wrappers
use runtime cloud credentials and do not need the provider credentials. See
[server-side variables](map-provider-deployment.md#server-side-configuration).
