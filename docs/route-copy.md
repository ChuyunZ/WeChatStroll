# Grounded route copy (Issue #86)

Route copy is a presentation-only enhancement after a real route has been
validated and displayed. Hunyuan `hy3` freely writes `title`, `description` and
`recommendationReason`; it does not select templates or change route facts.
Until all three fields pass validation, the existing deterministic copy remains.

## Integration and ownership

`routes.js` binds the current business routes to an in-memory copy session. Its
`setData` rendering-complete callback admits surfaced routes to the queue. The
copy promise is never awaited by generation, progressive filling, manual
alternatives, editing, navigation or Start Walk.

`route-copy.js` owns the session registry, fact projection, stable fingerprint,
queue, budget and subscriptions. The cloud function is independently deployable;
the pure contract is mirrored in the Mini Program and checked for equality in
Jest. No imports cross cloud-function deployment directories.

Routes passes only the copy session ID in a separate EventChannel event. Detail
subscribes to the same session and reads the current copy immediately, closing
the response-before-subscription race. A reply patches only the three strings
and `copySource`, never the map, ranking or business Route reference.

The AI badge is shown only for `copySource === 'ai'`. Detail displays a badge beneath both
its route introduction and recommendation reason; the full disclaimer appears
once, beneath the introduction. Detail also shows:

> AI 生成内容可能存在不准确之处。路线距离、时长以地图计算结果为准，实际环境请以现场为准。

## Cloud contract

Call `routeCopyGenerator` with `{ payload }`. The payload has exactly:

```js
{
  schemaVersion: 1,
  routeFacts: {
    routeType, returnsToStart, distanceMeters,
    durationSeconds, durationMinutes,
    orderedPois: [{ ref: 'P1', name, category }]
  },
  preferences: {
    durationMinutes, routeType, crowdPreference, environmentPreferences
  },
  historicalPreferenceProfile: null // or the existing six-field projection
}
```

Only the active route order selects POIs, not the editable pool containing
removed stops. The projection excludes provider IDs, coordinates, addresses,
geometry, steps, raw responses, street evidence, identity, feedback text and
walk history. Profile refresh is not repeated: the snapshot already returned by
`generateRoutes()` is reused. Invalid optional history is discarded as a whole.
Current questionnaire intent takes priority over history; neither constitutes
evidence of actual crowd conditions, scenery, safety or accessibility.

Server authentication uses `cloud.getWXContext().OPENID`, never a client identity
field. OPENID is not sent to the model. The payload is limited to 16 KiB UTF-8;
the enclosing event to 32 KiB, allowing platform metadata without forwarding it.
There are 1–8 ordered POIs and each name has 1–120 Unicode code points. Unknown
business fields, control characters, invalid enums and inconsistent metrics are
rejected. Questionnaire minutes are integers from 15–120. Actual edited route
metrics have independent bounds (1,000 km / 7 days), not questionnaire tolerance.

The model receives serialized, delimited data and explicit instructions not to
obey instructions inside names. No tools are registered and `maxSteps: 1` prevents
multi-step generation. There is no application retry or repair-model call.

Success: `{ success: true, copy: { title, description, recommendationReason } }`.
Failure: `{ success: false, error: { code, message } }`, using fixed messages.
`COPY_EXECUTION_UNKNOWN` additionally returns `executionState: 'unknown'`.
Raw model output and upstream errors are never returned to the client. Normal
cloud logs include only a fixed rejection category (and one of the three fixed
field names), never model transport errors, the prompt or identity.

### Development-only rejection diagnostics

`COPY_INVALID_OUTPUT` now emits `ROUTE_COPY_REJECTED` with a fixed `reason`
and optional `field` (examples: `INVALID_JSON`, `INVALID_LENGTH`,
`INVALID_ORIGIN_OR_INTERIOR`, `UNSUPPORTED_FACT`, `WRONG_MEASUREMENT`,
`INVALID_POI`, `WRONG_POI_ORDER`). The user-facing contract and
one-model-send/no-retry behavior are unchanged. A rejection from the existing
deployment *before this change* cannot be reconstructed from old logs.

To include a bounded, partly redacted `modelTextRedacted` snippet **only in a
controlled development Cloud Function**, explicitly set BOTH function env vars:
`ROUTE_COPY_DEPLOYMENT_STAGE=development` and `ROUTE_COPY_DEBUG_TEXT=1`.
They default to OFF: deployment without both variables records category only.
Production must not set the development stage; `production` blocks the snippet
even if the other flag is accidentally set. No source code changes are needed
to switch the debug snippet off; remove the debug flag before public release.

The snippet masks all exact known POI names, URLs, emails, phone patterns,
coordinate-like numbers and long identifiers, then truncates to 1,000 chars.
This is **best-effort, not complete anonymization**: unknown or generated place
names, location clues and user-supplied text could survive. Restrict access to
CloudBase logs, use a short retention policy appropriate to permissions, and
never enable content snippets where provider storage rights are unclear.
Prompt, OpenID, route geometry, raw upstream error objects and user input are
not logged. No changes to actual CloudBase env vars/deployment are made by this PR.

## Output checks and limits

Only an exact three-string JSON object is accepted, with no code fences or extra
fields. Lengths after trimming, including punctuation, are:

| Field | Unicode code points |
| --- | --- |
| title | 6–22 |
| description | 30–100 |
| recommendationReason | 20–80 |

The parser caps raw output at 4,096 UTF-16 code units. Long POI names need not
appear in the title; the existing ordered POI list still displays full names.
Card titles retain their existing single-line ellipsis, while Detail shows the
full title.

Validation also rejects assertions that a named waypoint is the GPS starting
point or that the walking path entered a venue/traversed an inferred inner path
or quiet corner. Ordered POIs alone do not prove these geographic details.
A sentence such as “从当前位置出发，途经人民公园” remains allowed; “从人民公园出发，沿着园里的小径” is rejected unless future verified route facts explicitly support it.

Validation rejects identifiable unknown destination references, temporary P
references in prose, conflicting numbers with common Chinese/metric units,
explicit reversed visits, inconsistent return-to-start claims, navigation turns,
recognisable unsupported environment/facility/safety assertions, and substantial
field duplication. Known names are masked before numeric checks so names such as
“一号公园” are not interpreted as route metrics. Explicit numbers must match real
metrics or the app's displayed rounding. The prompt prefers omitting numbers.

This is not a general Chinese fact checker or a proof of safety. Indirect place
references, unrecognised proper names, complex grammar, unusual numerical
expressions and novel claims may evade the checks. Conversely, some valid prose
may fall back. Wishes and conditionals are distinguished from observable claims
where recognised; expressions such as “悠闲漫步”, “探索街角”, “换换心情” and
“十分悠闲” remain valid. Prompt injection defenses reduce risk but cannot prove
that an LLM ignores every instruction-shaped name. The AI disclaimer is required.

The server validates supplied facts structurally and checks copy against them.
It cannot independently prove that a caller's route came from Tencent; the
normal application's existing route validation establishes that provenance.

## Server-side budget (required before deployment)

The Cloud Function reserves an **atomic** daily quota before `generateText`:
24 sends per authenticated OpenID in production (150 in explicitly configured
development Cloud Functions), and 200 sends globally per UTC calendar day
(00:00 UTC reset). The counters share a single CloudBase database transaction,
using fixed document IDs in `route_copy_quotas`. OPENID is SHA-256 hashed;
the only stored fields are day, count and counter-update timestamp. There is no
persistent prompt, POI, route or model response in the quota documents.

**Deployment prerequisite:** create the `route_copy_quotas` collection in the
target CloudBase environment before deploying this function. This PR creates
code only; it does not create the collection or change a database, cloud
configuration, environment variable or deployment. Missing collection,
transaction conflict exhaustion or uncertain database outcomes **fail closed**
as `COPY_QUOTA_UNAVAILABLE`; an exhausted budget returns
`COPY_QUOTA_EXCEEDED`. Both are ordinary terminal fallback conditions for the
client scheduler, not unknown remote model execution.

Reservations are committed *before* model inference and are never refunded
for invalid output, timeout or unknown upstream completion. Only explicit
rolled-back transaction conflicts may be retried. This protects the send count
across instances; it does not bound provider token pricing or other AI functions.
The per-session client limit of eight remains an independent UX limit; the server
cannot trust a client-provided session as an authorization or billing identity.
Tune the two constants only with an explicit cost/usage decision.
Optionally configure CloudBase's own per-user QPS limit separately for burst
protection; no console QPS setting is changed by this PR.

## Budget, freshness and timeout

A questionnaire submission creates a session with eight sends. A Routes retry
advances its generation without resetting that budget. Initial, progressive,
Add, Replace and confirmed edits share it. Failed/expired sends still count;
cancelled unsent tasks do not. There are no automatic retries. Pending tasks can
be promoted when Detail is opened. A fingerprint is canonical JSON of active
local POI IDs plus the entire sanitized payload; IDs remain local. Rank,
timestamps, route ID, old text and edit-source metadata are excluded. Identical
facts can share accepted copy; failed or stale attempts are not sent again.

Each request captures its generation and request version; each route binding
tracks its current object, version and fingerprint. Replacing/removing a binding
detaches obsolete requests. New responses cannot update an old route ID's new
facts. A new questionnaire disposes the old session; no cache crosses sessions.

State progression:

```text
queued -> inFlight -> accepted | rejected | executionUnknown
             |
             +-> expiredInFlight -> rejected | executionUnknown
queued -> cancelled (removed, no budget spent)
inFlight/expiredInFlight -> stale (detached, still occupies transport slot)
```

The shared scheduler admits one call at a time across sessions in this Mini
Program runtime. `COPY_SOFT_TIMEOUT_MS = 20000` is an initial UI deadline to
calibrate in E2E. Deadline checks also use wall-clock time, so delayed background
timers cannot accidentally accept an expired response. Soft expiry stops
display acceptance but does not release the slot. A late definitive response
releases it, without displaying that expired copy.

Transport rejection, malformed envelopes or server-reported unknown execution
pause the scheduler for the runtime's remaining lifetime. The paused gate keeps
the execution slot unavailable; queued tasks are dropped without further sends.
Creating another questionnaire cannot bypass this gate. Routes remain usable.
There is no polling, background retry, database, cancellation endpoint or task
system. The cloud client's 60-second HTTP timeout is not proof of upstream model
termination or stopped token charges.

The eight-send client budget alone is not an abuse-prevention or billing cap.
The server-side daily counters above provide cross-device/instance admission
limits for this Cloud Function, but do not guarantee a monetary ceiling or
protect `aiRoutePlanner`. A stronger remote-execution guarantee would require
separate design.

## Editing, cleanup and persistence

Draft changes never request copy. A valid preview uses its own deterministic
copy even while an earlier request resolves. Cancel reads the latest accepted
copy of the confirmed version. Confirm switches the raw route and binding,
renders the new fallback, then admits new copy work. Restoring identical facts
can reuse accepted session copy after the fallback render. Rebuilding a route
also refreshes deterministic `recommendationReason`, preventing deleted POIs
from surviving in fallback text.

Entering Detail does not end the session. Detail unload removes its listeners;
Routes unload removes its subscription, preferences listener, registry entry,
bindings, cache and pending tasks. A running request's callbacks and payload
references are detached, but its scheduler slot remains held until settlement.
No in-flight callback needs to retain a Page after disposal.

Start Walk continues to use `_confirmedRoute`, never `data.route`. AI text,
fingerprints, source markers and session identifiers are absent from the local
walk snapshot and cloud walk/feedback inputs. No new storage, database, file
cache or logging of prompt/response/POIs is added. The pre-existing raw walk
recovery snapshot remains an independent #94 concern.

## Local verification and deployment follow-up

Jest discovers `cloudfunctions/routeCopyGenerator/index.test.js` alongside the
new contract, controller and connected Routes/Detail tests. Tests use deferred
promises, fake timers, real editing route assembly and a serialization-aware
`setData` double. They cover creative prose and invalid facts, eight sends,
single concurrency, queue cancellation, same-ID edits, preview/cancel/confirm,
restoration, Add/Replace, unknown execution, disposal, first-render admission,
and absence of AI data in actual local walk storage.

Run `npm test -- --runInBand` (`npm.cmd` on Windows when PowerShell blocks the
`npm.ps1` shim). No real model or map calls are needed for Jest.

Before a separately authorized deployment/E2E, verify:

- Confirm that `route_copy_quotas` exists and Cloud Function DB permissions
  permit transactional reads/writes; a missing collection intentionally causes
  deterministic fallback with no AI request.
- Verify same-user daily quota, cross-user global quota and reset behavior in
  the development environment only, without logging raw user identifiers.
- CloudBase model content logs and actual provider retention settings; no
  application logging does not establish platform non-retention.
- The deployed SDK/model behavior, function runtime limit and upstream timeout
  semantics. No cloud settings were changed for this implementation.
- Real `hy3` JSON/length/grounding acceptance rates and long-name handling.
- First-card usability, background/resume behavior, maps, text layout and badge
  visibility on real WeChat devices.
- The 20-second UI deadline and conservative paused-queue experience.

This document records local implementation, not deployment or real-device proof.

### Time-expression validation precision

A live development benchmark case (`C001`, 2026-10-09) exposed a
`WRONG_MEASUREMENT` false positive: route duration was 1,756 seconds
(29m16s, displayed as 30 minutes) and the model said “半小时”.
Hour-based time claims now compare against both precise seconds and
`routeFacts.durationMinutes` (the UI/display minutes), **not**
`preferences.durationMinutes` (the user's requested length).
Contradictory hour claims still fail validation. Mirrored cloud and client
contracts, and negative tests, remain in sync. The fix requires redeploying
`routeCopyGenerator` and recompiling the mini program.

The live C004 fail-fast POI-pool benchmark (2026-10-09) also exposed
`INVALID_POI` on “途经几处公园慢慢晃” when the simulated route contained
four park POIs. The landmark detector now distinguishes quantified generic
category phrases (e.g. `几处公园`, `两座公园`) from a new proper name.
It still rejects clear invented names, including after a generic mention,
and does not silently permit “走进几个公园” without venue-entry facts.
A small quantitative grounding check additionally rejects `几处公园`
when fewer than two ordered POIs are parks, or `四处公园` when there
are fewer than four. This avoids turning the false-positive fix into a
false-negative for quantity claims.
Matched evidence was preserved as an exact C004 regression and paired
positive/negative tests; mirrored cloud/client contracts stay identical.

A normal Routes E2E request (`a52ddb9d-a5c3-40a5-92f1-5d0255b08f6d`)
was rejected for `WRONG_MEASUREMENT` on “用大概半小时散散步”.
The displayed route in the accompanying screenshot was about 24 minutes.
Explicitly approximate minute/hour expressions (`约`, `大概`,
`大约`, `差不多`, `大致`, `左右`, `上下`, `前后`)
now allow a deviation no greater than the smaller of **6 minutes and
20% of the claimed duration**. Unqualified time expressions still
require the exact seconds or displayed minutes; the questionnaire target
cannot validate an actual-time claim. Tests cover actual-style prose and
nearby rejection boundaries.

A later live stress-test stopped at C006 (after five accepted outputs) with
`COPY_EXECUTION_UNKNOWN` in 850 ms, rather than a validator failure or
the 20-second UI deadline. The model SDK threw during `generateText()`,
but the thrown object's payload was intentionally never logged. Developer
diagnostics now whitelist only a fixed model-exception category and an
optional numeric HTTP status; no raw SDK error, stack, response, POI,
identity or prompt is stored. For an opted-in development benchmark, this
limited metadata appears in `upstream` in the JSON report. Unknown
execution still pauses the run; no automatic retry or quota refund is
introduced. This does not identify the cause of the already-captured C006.

The third live failure (`C041`, request
`0b75e1bf-47b9-40ef-ab81-6c2b9112270a`) occurred after **40
consecutive accepted outputs**. The model correctly wrote “用不到半小时”
for a simulated 1,672-second/28-minute point-to-point route, but the
validator had treated “半小时” as exact equality. Time-quantity
inequalities now use the displayed route duration with strict
(`不到`, `不足`, `未满`, `少于`, `超过`, `大于`)
and inclusive (`不超过`, `以内`, `至少`, `不少于`,
`以上`) semantics. They run **before** equality or approximate
tolerance checks; the user's preferred duration is never used as a
route fact. Tests include C041's complete model output, threshold
boundaries at 29/30/31/40 minutes, and both sign directions.

## Development-only Tencent POI copy stress-test

The Cloud Test panel runs explicitly in WeChat DevTools only. **Its source
is the POI candidate pool from Tencent Maps' `nearbyPois` search**:
`generateRoutes()` calls `searchNearbyPois()`, flattens category results
using `buildPoiCandidates()`, and returns `verifiedWaypointPool` to Routes.
This pool is obtained **before AI waypoint selection or walking validation**.
The name `verifiedWaypointPool` refers to structurally normalized POIs,
not confirmed navigable sequences. The benchmark does not call map APIs.

1. Generate one ordinary route in Routes, then enter the existing Cloud Test
   page in AppService Console:
   `wx.navigateTo({url:'/pages/cloud-test/cloud-test'})`.
   The Routes page must remain alive, including its in-memory
   `_verifiedWaypointPool`. No extra map/AI-planning requests are made.
2. Choose 30 or 60 minutes (maximum time window, not promised run length).
   From **all eligible map-returned POIs**, the harness shuffles and rotates
   through the whole pool, selects random combinations of **1–8 POIs**,
   varies target duration (15–120m), crowd, environment order and route type.
   Every input POI name/category comes from the already fetched Tencent
   candidate pool, never an AI-generated selection. Duplicates and malformed
   POIs are excluded, and the run is reproducible using its seed.
3. **Simulated facts:** for each combination, the harness generates internally
   consistent distance/time and return-type metadata to satisfy the existing
   cloud contract. These are invented test measurements, **not true walking
   calculations or evidence that this route can be walked**. Do not present
   model outputs as factual public-route recommendations. This tests grounding,
   JSON formats and validator false positives, **not genuine route E2E**.
4. Requests are **serial**, with **15 seconds between settled requests**;
   no auto retries; max **500 sends per run**, stopping at first rejection,
   invalid client copy, unknown execution, soft UI deadline or quota issue.
   The original **production** quota remains **24 sends/OpenID/day and
   200 globally/day**. **Only Cloud Functions explicitly deployed with
   `ROUTE_COPY_DEPLOYMENT_STAGE=development`** have higher quotas:
   **1000 sends/OpenID/day, 2000 sends globally/day (UTC day)**.
   Client-provided `benchmarkDebug` cannot elevate limits. Previous
   counters continue at their current values; no reset/migration required.
   The 30/60-minute run-time windows and fail-fast stop remain unchanged.
5. With BOTH `ROUTE_COPY_DEPLOYMENT_STAGE=development` and
   `ROUTE_COPY_DEBUG_TEXT=1`, the `benchmarkDebug: true` request receives
   `debug` on failed validation: reason, field and best-effort-POI-redacted
   model output. Normal UI/production receives fixed error responses only.
6. Each result checkpoints to
   `wx.env.USER_DATA_PATH/route-copy-benchmark.json` when possible. After
   **the first failure**, click **复制 JSON 报告** and send it directly for
   analysis. The report includes scenario mode, input duration, simulated
   timing, POI counts/categories/name lengths (not actual names), reason,
   field and redacted model reply. Treat reports as potentially sensitive:
   generated prose might contain indirect location clues. Production should
   disable and remove this developer-only panel and debug flags.

A 2026-10-09 fail-fast run accepted 26 consecutive `hy3` outputs and stopped
at C027 with `COPY_EXECUTION_UNKNOWN` and the development SDK diagnostic
`RATE_LIMIT` (no HTTP status was exposed). This is **not** a grounded-copy
validation failure, and not proof of a specific HTTP 429 status. Tencent's
CloudBase documentation says even serial / below-environment-concurrency
clients may be throttled when the **shared model resource pool** is busy.
The benchmark therefore reduces its self-generated request pressure from
a 5-second to a **15-second post-response cooldown**. This is a conservative
engineering choice, **not a published `hy3` RPM requirement or a guarantee**
against future `RATE_LIMIT` failures. The runner still stops at first
provider uncertainty with no retry or quota refund. More generous daily dev
quotas do not change provider rate limits.

A further run after the 15-second pacing change stopped on **C001**
(`2026-10-09T03:25:57.656Z`, Request ID
`63d98221-9c60-4262-ac93-b27c44d97cc8`) in 946 ms with
`COPY_EXECUTION_UNKNOWN` and generic `RATE_LIMIT`.
Because this was the first request of the run, changing the *inter-request*
cooldown cannot directly fix this failure. No HTTP status or raw SDK code was
captured, and earlier diagnostics had collapsed `RESOURCE_EXHAUSTED` and
several rate-limit signals to one category. We cannot prove the precise
provider cause from this report.

For future calls only, development-only opt-in diagnostics now retain a
**fixed allowlist of error.code strings** in `upstream.providerCode`,
distinguishing `EXCEED_CONCURRENT_REQUEST_LIMIT`,
`EXCEED_TOKEN_QUOTA_LIMIT`, `RESOURCE_EXHAUSTED`, and known rate-limit
codes. Arbitrary provider errors, stacks and messages remain prohibited.
The normal/prod response contract, no-retry/fail-fast policy, and daily
quotas are unchanged. If the known code is still absent, contact Tencent
CloudBase support with the UTC time and Request ID rather than making
rapid repeat calls.

This test can deplete today's development quota; **never reset database
counters** to bypass it. The Tencent map usage is limited to the single
ordinary route setup step; no map provider API is called by the sampler.
