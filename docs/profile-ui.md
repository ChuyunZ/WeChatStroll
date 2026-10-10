# 我的散步 — Issue #87 Phase 2

The native Mini Program Profile page now displays lifetime walk counts,
explainable preference summaries and walking history. Home's “我的散步” button
opens `/pages/profile/profile` with `wx.navigateTo`; planning navigation remains
available and no TabBar is introduced. UI uses Chinese labels, white rounded cards,
the existing green palette, rpx spacing and safe-area bottom padding.

## Data and interaction

- On first `onShow`, independently request `walk-records.listHistory({ limit: 10,
  cursor: null })` and `preference-profile-records.refreshProfile()`.
- Lifetime completed/ended-early cards read **only first-page totals**. Loading
  and errors display unavailable/loading text rather than invented zero counts.
  A successfully loaded empty history displays genuine zero counts.
- Show the first three fetched walks by default. “查看全部” reveals already fetched
  rows without another request; “收起” restores the three-row view. “加载更多”
  requests ten rows with the retained cursor. Continuation `totals: null` never
  replaces first-page totals. Null `nextCursor` ends pagination.
- Each history row uses its start date/time in the device's local timezone,
  Chinese route/status labels, requested minutes, exact actual elapsed seconds
  formatted as hours/minutes/seconds, and rating or “尚未评价”. Planned and actual
  durations are separate. No fabricated route names, locations or distances appear.
- History rows now open the [Phase 3B History Detail page](history-detail.md) with
  only a validated walkId. GPS loads only after an explicit click inside detail.
- AI content uses the validated refresh result, transformed by the pure
  `profile-insights.js` module. No `aiRoutePlanner`, new model inference,
  third-party API, cloud function or database change is involved.

## Deterministic insight rules

These are conservative presentation heuristics, not statistical significance,
medical advice or predictions of current route conditions.

| Topic | Rule and wording |
| --- | --- |
| Environment | At least 3 evidence walks; leader was first choice at least twice and in at least half of evidence walks; its first-choice count exceeds every competitor; weight lead over runner-up is at least 0.15. Compare four-decimal weights as integers for threshold stability. Say “你在问卷中经常优先选择…”, and show first/top-two counts. Otherwise “目前还没有明显的环境偏好”。 |
| Duration | Use server `preferredDurationMinutes` unchanged. Below 3 evidence walks, explicitly show limited sample size and “暂约”; otherwise use neutral wording “根据过去的散步记录…时长倾向约为…”, since the presence of duration feedback tags alone does not prove they changed the computed preference. Null produces an insufficient-evidence message. Show exact duration tag counts when present; never treat actual time or the derived preference as a verified optimum. |
| Crowd | At least 3 evidence walks and signal <= -0.35 or >= +0.35. A negative conclusion additionally requires `max(tooCrowdedCount, quietPositiveCount) >= 2`; positive requires `tooQuietCount >= 2`. Do not sum overlapping negative tag counts. Any opposite-direction explicit tag suppresses the conclusion. Missing, near-zero, insufficient or contradictory evidence remains neutral. |
| Tags | Translate the fixed allowlists, retain service ordering and exact counts. One occurrence is “曾提到 1 次”; repeated tags say “提到 N 次”, never an unqualified “经常”. Both positive and negative experiences are visible. No comments are consumed. |
| Scope | Show actual evidenceWalkCount/feedbackCount, followed by “基于最近最多 20 次有效散步及对应反馈，不代表全部历史记录。” These counts never populate lifetime statistics. |

Crowd evidence is deliberately stricter than the builder's numeric signal:
questionnaire-only history can provide a server signal, but the public aggregate
schema does not expose the number of valid crowd questionnaires or per-walk tag
overlap. The UI therefore requires repeated explicit directional feedback and
suppresses aggregate contradictions, including opposing tags on different walks.
It can withhold a plausible tendency rather than overstate evidence.

`refreshProfile() === null` shows the introductory “AI 正在慢慢了解你…” message.
A non-null profile with no feedback still shows questionnaire-derived insights and
explains that questionnaires also provide evidence; it never labels the user as
having no preferences. Environment rankings describe selected intent, not places
visited. Duration feedback counts are reported as past experiences, not proof that
every tag participated in the builder's adjustment (contradictory tags may not).

## State, retry and lifecycle

History and AI each have `loading / ready / empty / error` states. They launch in
parallel and settle independently. Each retry button retries only its failed area.
Fixed Chinese error text prevents provider messages from leaking into the UI.
There is no automatic error retry or refresh triggered by `setData`.

Pagination has separate idle/loading/error/invalid states. In-flight guards prevent
double-click duplicate requests. Errors retain rows, totals and cursor, allowing a
retry of that exact page. `INVALID_HISTORY_CURSOR` explains that history may have
changed and offers “重新加载历史”, which clears the old pagination generation and
reloads page one. Pagination neither recomputes totals nor refreshes AI.

`onLoad` initializes instance fields; `onShow` runs one refresh per visible session.
Repeated `onShow` while already active does not duplicate requests. `onHide` and
`onUnload` invalidate both independent request versions. Re-entry starts a fresh
first page and preference refresh, except a matching normal return from the
read-only History Detail page: retain loaded rows/expansion/cursor and settled AI,
restore scroll where supported, and resume only interrupted non-GPS loads.
Old successes, errors and finally handlers
cannot mutate a newer generation or reset its busy flags. Unloaded pages never
receive later `setData` calls. No cancellation API is assumed: network work already
sent can finish, but its stale results are discarded.

Only presentation rows are kept in page-instance memory; the cursor is private to
the page. Entire history/Profile objects are not written to storage. The existing
services enforce identity/field/order validation; append also deduplicates walk IDs.
No ownership fields, comments, POIs, route geometry or GPS are rendered.

## Validation and remaining acceptance

Jest covers empty/one/seven/more-than-twenty histories, lifetime/window separation,
expansion and collapse, last page, duplicate requests, failed/replayed pagination,
cursor recovery, independent region errors, malformed real-service responses,
return/unload/old-response races, thresholds and Chinese navigation/bindings.

The Phase 2 handoff reports Phase 1 live CloudBase validation, including status
counts, three pages without duplicate/missing IDs, ratings and invalid-cursor
errors. That backend validation is separate from this UI's automated tests.
Before Phase 3, complete code review and an actual WeChat Developer Tools iPhone
and device smoke test: small screens/large text, safe areas, Home navigation,
long-history scrolling, offline retries and returning after feedback submission.
Jest does not prove native layout or WXML compilation. Long expanded histories
remain in memory for the visible session; no virtualized list is added in this phase.

No add/commit/push/PR, cloud deployment or configuration change is part of Phase 2.
