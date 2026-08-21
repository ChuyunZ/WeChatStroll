# CloudBase Setup

This document describes how CloudBase is configured for the WeChatStroll mini program and how to verify the setup using the `healthCheck` cloud function.

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

The test cloud function is:

```text
cloudfunctions/
└── healthCheck/
    ├── index.js
    └── package.json
```

The `healthCheck` function returns:

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

## 5. Deploying the Cloud Function

In WeChat Developer Tools:

1. Make sure the CloudBase environment is set to `cloud1`.
2. Right-click the `healthCheck` cloud function.
3. Upload and deploy the function.
4. Let the cloud environment install the dependencies defined in `package.json`.

The function uses the `wx-server-sdk` package.

## 6. Testing the Cloud Function

A test page is available at:

```text
pages/cloud-test/cloud-test
```

The page calls the cloud function using:

```javascript
const response = await wx.cloud.callFunction({
  name: 'healthCheck'
})
```

If the request succeeds, the page displays:

- success status
- returned message
- server timestamp

## 7. Error Handling

The cloud function call is wrapped in `try`, `catch`, and `finally`.

If the cloud function call fails, the error is caught and displayed on the test page instead of causing the page to fail silently.

The error handling was tested by temporarily calling a non-existent cloud function and confirming that the error state was displayed correctly.

## 8. Secrets and API Keys

No API secret, private key, or access token is stored in the mini program frontend.

Sensitive credentials required by future third-party services should be stored and used on the backend rather than being embedded in frontend mini program code.
