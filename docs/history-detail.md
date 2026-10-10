# Walking History Detail — Issue #87 Phase 3B

Native Mini Program implementation. Development WeChat Developer Tools E2E
has verified navigation, real Walk/read-only feedback, real one-point and
empty GPS views, Profile expansion/scroll restoration, 60-second cooldown
and safe error UI. The revised quota-limited `trackProvider` and ADMINONLY
collection were deployed and tested **in development**. Other environments
still require [their own collection rollout](history-trace.md). Physical-
device continuous multi-point traces and selected live cloud race/failure
scenarios remain pending.

## Entry and data

Profile rows open `/pages/history-detail/history-detail?walkId=...`, with only a
validated, encoded ID belonging to the already loaded list. Repeated taps are
guarded. Expand/collapse/pagination controls are outside the tappable row.

The detail page independently reads `walk-records.getWalk(walkId)` and
`feedback-records.getFeedback(walkId)`. Existing service validation is retained;
the display projection additionally checks the terminal history-item fields.
Only real local-time start date, translated route/status, requested minutes and
actual elapsed duration are shown. Elapsed duration is not verified exercise time.
No route title, distance, POIs, calories, planned geometry or speed is inferred.

Feedback is read-only: rating, crowd, recommendation, translated allowlisted
positive/negative tags and optional plain-text comment. The current service
contract represents absent tag choices as empty arrays and missing comments as
null; malformed payloads fail safely. Null feedback shows “这次散步还没有留下评价。”
There is no submission, editing or navigation into the editable feedback form.

## Independent states and lifecycle

- Walk: loading, ready, error, unavailable. Fixed Chinese errors and independent retry.
- Feedback: loading, ready, empty, error. Its failure does not hide Walk or trigger GPS.
- GPS: idle, loading, ready, empty, error, disabled. No consent means no query button.

GPS is queried only by “查看实际轨迹” or its explicit manual retry controls, using
`history-trace.searchWalkTrace({walkId})`. Neither onLoad/onShow nor other loads
start a trace query. A validated Walk completion within the past five minutes
(inclusive) enables the Service's 500/1000ms empty retries, at most three calls.
Older, invalid or future completion times enable no automatic retry. Only successful
empty/retryable responses retry; no error does. The retry option never enters the
Cloud Function request or authorization fields.

Initial click plus at most two manual retries are allowed per page instance,
across empty and error states. Each accepted click starts a 60-second cooldown;
its internal service calls count as one manual attempt. Disabled buttons and fixed
Chinese hints explain cooldown/exhaustion. A single boundary timeout replaces any
countdown polling. Hide clears the timer, show recomputes it without resetting the
budget, and unload releases it. Already sent service calls may finish and consume
server quota while hidden. A new page instance resets only the local budget.
Server quota exhaustion displays “定位记录查询过于频繁，请稍后再试。” Infrastructure
failure uses the generic safe query-error message. Both consume the local attempt,
neither triggers an automatic retry, and no exact server retry time is promised.
The frontend is a usability/cost control; authoritative protection is the server's
transactional 20-reservations-per-rolling-hour limit. Native comment selection uses
`user-select` instead of the deprecated `selectable` attribute.

Per-area request generations, busy flags and ID checks prevent double requests
and stale success/error/finally callbacks. Hide invalidates pending work; show
resumes interrupted metadata/feedback loads but resets interrupted GPS to idle
without querying. Completed map data may remain while hidden, and is released on
unload. No GPS storage, console logging, current-location calls or shared trace cache.
Already sent service requests cannot be cancelled; their late results are ignored.

The opener EventChannel receives a coordinate-free `historyDetailClosed` event
on unload. Only the matching navigation token allows Profile's next onShow to
retain its rows, expansion, cursor, totals and settled AI content. In-flight
pagination is invalidated and can retry the retained cursor. Interrupted AI loads
resume independently. Best-effort pageScrollTo restores the recorded scroll offset.
Without a matching close event, ordinary hide/re-entry refreshes both regions as
before. No persistent UI navigation cache is introduced. Device event ordering and
scroll restoration must be manually checked; unsupported/missing close events
fall back to normal refreshing.

## Honest map presentation

Coordinates are existing GCJ-02 samples. No planned route or current-location fallback.

| Input | Display |
| --- | --- |
| 0 samples | Empty state, no arbitrary center/map; manual retry |
| 1 sample | One neutral “定位记录” marker, no line |
| Multiple samples | Conservative segments; singleton segments become neutral markers |

Consecutive samples connect only when time increases by at most 60 seconds,
great-circle separation is at most 150 metres, implied speed is at most 3 m/s,
and longitude does not jump across the antimeridian. These are deterministic
display heuristics, not movement verification. Every same-second group is isolated,
including links entering/leaving the group, because its ordering is unknown.
Invalid coordinates, duplicates or nonmonotonic normalized ordering fail safely.
No intermediate points are synthesized. Repeated isolated coordinates share one
marker; there are no artificial start/end markers.

Validate up to the existing 10,000-point API limit, but render only a chronological
prefix: at most 500 original samples and at most 100 segments/native map objects.
Stop before a new segment would exceed that object limit. There is no downsampling
that reconnects across skipped samples. Bounds use all displayed authentic samples;
center starts at the first displayed coordinate. The UI shows displayed/total counts
and explicitly explains truncation and segmentation. The omitted tail can include
important data; this is a bounded overview, not a full-trace exploration tool.

No provider mileage/duration summaries are displayed as exercise statistics.
Large payload validation is linear; only bounded map data goes into setData.

## Partial wording and limits

When cleanup extends beyond endTime, say “正式结束后的收尾采样不在展示范围内。”
When stored trajectoryPartial is true, separately indicate a possible incomplete
record with unknown cause. For trace.partial, use “显示的是本次散步正式结束前的定位记录，
部分采样可能未展示。” Never equate every partial flag with GPS loss.
Even partial=false does not certify completeness or accuracy.

Backend ownership/consent/formal-end boundaries are unchanged; quota reservation now
precedes any provider request. Shared user Entity,
overlapping formal intervals, multiple devices and inaccurate/forged timestamps
still prevent definitive per-Walk point attribution. Display segmentation is not
an authorization mechanism and cannot reconstruct missing historical evidence.

## Development E2E completed (2026-10-10)

- Home → Profile → History Detail rendered real persisted metadata and read-only
  feedback or the honest absent-feedback state.
- One actual Track Cloud point rendered a marker without a line; a separate
  actual empty trace rendered no invented map or path.
- Profile expansion and scroll position survived Detail return.
- Two synthetic disconnected polylines and an independent marker displayed
  correctly in native `<map>`; this does **not** certify live multi-point GPS.
- The development ADMINONLY quota collection and revised `trackProvider`
  were deployed. Four authorized historical searches produced four bounded
  timestamps. Missing/opted-out Walks returned `WALK_NOT_FOUND` /
  `TRACK_NOT_ENABLED` without quota increments.
- Temporary saturation with 20 valid request timestamps caused
  `TRACK_SEARCH_RATE_LIMITED` on the next authorized request, without
  recording a 21st entry. The original four timestamps were restored.
- Native manual cooldown re-enabled after 60 seconds and remained disabled
  after the initial attempt plus two manual retries. Mocked quota and network
  errors displayed separate safe Chinese messages, without affecting metadata
  or feedback.

## Remaining acceptance and rollout

1. A real continuous **multi-point GPS walk on a physical device**; verify
   segmentation, time/distance/speed gaps, same-second points, long-trace
   truncation and native map behavior from actual samples.
2. Physical-device small-screen, long-comment, map gesture and background/
   resume checks, plus rapid navigation/in-flight request/lifecycle races.
3. Confirm entry makes no implicit GPS request, opted-out sessions cannot
   query, ordinary Home re-entry refreshes, and Profile return retains state.
4. Post-deployment upload/final-flush regression. Live last-slot multi-instance
   contention, CloudBase storage outage and clock-edge scenarios are covered
   by deterministic tests only, not by actual cloud fault injection.
5. Other environments (including production) require the ADMINONLY quota
   collection and dedicated rollout validation **before** function deployment.
   Production deployment is not claimed here.
