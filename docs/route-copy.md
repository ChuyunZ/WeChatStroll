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

The AI badge is shown only for `copySource === 'ai'`. Detail also shows:

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
Raw model output and upstream error messages are never returned or logged.

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

This product budget is not an abuse-prevention or global cost cap. It cannot
enforce limits across devices, process restarts or modified clients. Global
quotas and any stronger remote-execution guarantee require separate design.

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

- CloudBase model content logs and actual provider retention settings; no
  application logging does not establish platform non-retention.
- The deployed SDK/model behavior, function runtime limit and upstream timeout
  semantics. No cloud settings were changed for this implementation.
- Real `hy3` JSON/length/grounding acceptance rates and long-name handling.
- First-card usability, background/resume behavior, maps, text layout and badge
  visibility on real WeChat devices.
- The 20-second UI deadline and conservative paused-queue experience.

This document records local implementation, not deployment or real-device proof.
