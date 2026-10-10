# Walking History Detail — Issue #87 Phase 3B

Native Mini Program implementation. The P1 handoff reports initial native E2E for
navigation, metadata/read-only feedback, single marker, empty GPS, expanded history
and scroll restoration, plus Phase 3A CloudBase/Tencent validation. New P1 rate limits
remain local and require the [quota collection and rollout](history-trace.md).
Remaining native/device acceptance is separate from Jest evidence.

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

## Manual acceptance after review

1. Home → 我的散步 → history row: verify date/time, status and planned/elapsed duration.
2. Verify existing feedback, all labels, long comments and empty feedback; no edit action.
3. Inspect network: entry and feedback loading must not call trackProvider.
4. Click 查看实际轨迹 on the handoff's approximately 12-minute Walk: one returned
   sample must show exactly one marker and no line. On the approximately 22-second
   Walk, zero samples plus partial must show the truthful empty/neutral wording.
5. GPS-disabled walks show no query button or provider request. Test independent
   feedback/GPS failures, retry, offline behavior and loading double taps.
6. Expand/paginate Profile, scroll, open detail and return: retain list/cursor/scroll.
   Normal Home re-entry must refresh. Test rapid back/forward and hide/unload races.
7. Use synthetic multi-point responses to inspect gaps, same-second groups, jumps,
   bounds and large-trace truncation on the actual native map.
8. Check small screens, long text, safe areas, marker assets and map gesture behavior.
9. After the dedicated development quota collection and revised function are ready,
   test old/recent empty queries, 60-second cooldown, two manual retries across
   errors/empty states, hide/show budget preservation and server rate-limit messaging.
   Confirm no automatic page-entry queries or upload/finalization regression.

The handoff reports seven real historical Walks, two with GPS, plus existing
feedback. Initial native acceptance is reported in the P1 handoff; this local
limiter revision still needs its own E2E. Continuous trajectory rendering still
needs a separate real-device walk.
