# Issue #91: pinned temporary CloudBase prompt A/B (v2)

This reproducible setup is **local only**. It does not deploy, call a model, alter
the existing shared `aiRoutePlanner`, or touch the tracked original cloud function.

## Input versions

- Baseline prompt: **previous experimental treatment `72f8155`** (`cloudfunctions/aiRoutePlanner/routePlanningPrompt.js`); this is the version that returned 5 raw candidates but retained only 3 in the prior live experiment.
- Treatment prompt: PR #108 commit `3f0134a`, adding the whole-batch self-check. This isolates the incremental self-check change; the original `develop` prompt `0944584` is an earlier reference, **not** this run's baseline.
- Both variants use the **same treatment-revision validator**, API client, SDK,
  model, output schema, POI pool and preferences. The test wrapper changes only
  prompt selection, health-check and reporting.
- Production always returns `{ success, plan }`; the **temporary test-only**
  wrapper adds `abVariant` and `abDiagnostics` to successful responses.

## Prepare local files (no cloud access)

From the existing WeChat DevTools checkout with its local untracked
`cloudfunctions/aiRoutePlannerIssue91AB` test directory:

```sh
git fetch origin develop fix/issue-91-correction-benchmark
node scripts/issue91-prepare-ab-v2.js
node --check cloudfunctions/aiRoutePlannerIssue91AB/index.js
git status --short
```

The script reads the two **pinned Git commits**, fails closed if expected source
anchors change, syntax-checks the generated JS, and backs up the preexisting
test-only files under the local OS temporary directory. It never checks out a
branch or writes into `cloudfunctions/aiRoutePlanner`.

## Controlled shared-cloud deployment: explicit approval required

Only after obtaining approval for modifying the existing temporary function,
upload **`aiRoutePlannerIssue91AB` only**, with **cloud installation of npm
dependencies**. Confirm the function has `wx-server-sdk` installed. Do not
deploy the production `aiRoutePlanner` or merge PR #108.

Use the DevTools console for a test-only, non-model-generating probe:

```js
wx.cloud.callFunction({
  name: 'aiRoutePlannerIssue91AB',
  data: { __issue91DiagnosticProbe: true }
}).then(res => res.result, err => ({ error: err.errMsg }))
```

Check the Network response (not just a possibly stale Promise preview):
`success: true`, `diagnosticVersion: 2`, `aiCalls: 0`,
`treatmentCommit: '3f0134a'`. Failure means **stop**; do not perform paid A/B
requests.

## Paid live A/B (separate explicit approval required)

Before requests, confirm a fresh verified POI pool, stable Guangzhou location
and 30-minute `out_and_back` preferences. Fix a model-call budget first.
Alternate baseline/treatment ordering across repeated trials with identical
input and the same `hy3` backend. Disable retries in the test driver; stop if
any response fails, the expected diagnostics are missing, or the test
environment appears inconsistent.

Persist and report **aggregate only**:

- `rawCandidateCount`, `structurallyValidCount`,
  `retainedCandidateCount`, `removedCandidateCount`
- `removedByReason`: `malformed_structure`, `waypoint_count`,
  `unverified_poi`, `repeated_id`, `duplicate_set`, `subset_conflict`
- `structurallyValidMultiPoiCount`, `retainedMultiPoiCount`
- errors (allowlisted codes), empty batches, elapsed model-call time.

Do **not** publish raw model output, personal identifiers, exact coordinates,
POI IDs, or cloud credentials. Never infer real walking-route quality from
contract diagnostics alone. Real Tencent Walking API E2E and first-route
latency comparison remain separate experiments requiring permission.

Delete the temporary shared-cloud test function when the owner approves
cleanup. Keep the PR Draft until real-model and real-map evidence is adequate.
