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

The project includes two health-check cloud functions:

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

Sensitive credentials required by future third-party services should be stored and used on the backend rather than being embedded in frontend mini program code.
