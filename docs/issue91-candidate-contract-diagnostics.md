# Issue #91: initial candidate contract diagnostics

## What the real observation establishes

An earlier CloudBase `hy3` experiment used 12 verified POIs, a 30-minute
out-and-back request and five raw candidates per variant. The earlier control
retained five candidates; the initial treatment retained three. These counts
alone do **not** identify
the two removal reasons. No raw user payload has been copied into this repository.
Cloud contract acceptance also does not establish real walking-route validity.

## Behavior preserved

The cloud contract still rejects an invalid top-level shape or more than five
candidates. It normalizes IDs, removes individually invalid candidates, and
selects the largest compatible subset of the remaining batch, with the same
input-order tie-break. Equal sets (including reordered waypoints) and containment
in either direction conflict: `{A}` and `{A,B}` cannot occupy separate slots.
Partial overlap such as `{A,B}` and `{A,C}` is allowed.

No changes to the model, wire response, real walking validator, route generation,
optimizer, cache, map-request path, or correction budgets. Initial geometry ranking
remains shadow-only. No deterministic candidate filling or additional AI retry
was added. Prompt changes may affect model latency and the downstream work needed
to test its proposals; unchanged budgets are not proof of unchanged real latency.

## Aggregate diagnostic schema (version 1)

`parseAndValidateRoutePlanWithDiagnostics` returns `{ result, diagnostics }`.
The legacy parsing/validation APIs retain their result shapes. The cloud entry
point logs one `[AI Route Planner] Contract summary:` and returns its existing
wire response, without adding diagnostics to the plan. It no longer logs raw or
retained POI IDs.

| Field | Meaning |
| --- | --- |
| `rawCandidateCount` | Input array length, or `null` if unavailable |
| `structurallyValidCount` | Individually valid candidates before cross-slot filtering |
| `structurallyValidMultiPoiCount` | Individually valid candidates containing more than one POI |
| `retainedCandidateCount` | Candidates surviving the contract |
| `retainedMultiPoiCount` | Surviving candidates containing more than one POI |
| `removedCandidateCount` | Individually evaluated candidates removed, including batch conflicts |
| `planRejectionReason` | `null` on success; otherwise an allowlisted whole-plan error |
| `removedByReason` | Mutually exclusive primary removal counts below |

Removal codes: `malformed_structure`, `waypoint_count`, `unverified_poi`,
`repeated_id`, `duplicate_set`, `subset_conflict`.

An individually invalid candidate receives its **first failing validation check**
as its primary reason, not every possible defect. For individually valid but
discarded candidates, reasons are relative to the **retained** batch: equality is
`duplicate_set`; otherwise containment is `subset_conflict`. Thus two copies of a
discarded superset can both count as subset conflicts when its smaller component
sets win the maximum-size selection. These are removal counts, not counts of all
conflicting pairs in the raw response.

Whole-plan errors are `invalid_json`, `malformed_plan`, `candidate_count`,
`invalid_poi_pool`, `no_valid_candidates`, or the defensive
`no_compatible_candidates`. For failures before candidate evaluation, per-candidate
counts remain zero; do not interpret this as zero data loss. An explicit empty
batch is successful with zero counts and `planRejectionReason: null`. For evaluated
batches, the removal reason counts sum to `removedCandidateCount` and raw equals
retained plus removed.

Diagnostics contain only counts, a version number and fixed codes, never raw
model text, POI IDs/names, precise coordinates, credentials or user profile data.
This change is not a general audit of every existing mini-program debug log.

## Prompt change

A final silent self-check follows the verified pool and any replanning context.
The model is asked to construct the batch together, reserve singleton IDs against
other slots, permit partial overlap between multi-POI sets, check containment both
ways, and revise conflicting slots before emitting JSON. A five-slot compatible
example is explicitly illustrative, uses placeholder letters, and is tested
against the real contract. Neither mixed set sizes nor five candidates are forced
when useful compatible proposals cannot be formed. Duration uncertainty alone
does not justify an empty or underfilled batch.

## Offline verification

- Full Jest: **78 suites, 1,561 tests passed** (41 additional tests).
- All 2,401 ordered four-slot batches over three synthetic POIs agree with an
  independent bit-mask maximum-compatible-size oracle.
- Regression fixtures distinguish two different causes of five-to-three
  filtering; cover malformed responses, individual candidate defects, normalized
  duplicate sets, both directions of containment, non-greedy selection, legitimate
  empty batches, and preservation of five compatible mixed-size candidates.
- Cloud entry-point tests assert exactly one mocked model call, unchanged wire
  responses and no sensitive sentinels in logs, including error paths.
- A cloud-contract-to-generation integration uses the actual generation pipeline,
  optimizer, session and strict route validator with external boundaries mocked.
  Five synthetic candidates become three due to two subset conflicts; the second
  retained singleton yields a valid 1,800-second route after **one mocked AI call
  and four mocked directed segment requests**. No speculative pair is built.
- Existing correction benchmark, 250 fixtures per scenario: balanced 247,
  needle-in-haystack 73, directional 206, impossible 0, partly-cached 248 successes.
  Maximum newly requested mock segments stays at or below 12.
- Existing initial-candidate benchmark: 0/244, 197/219, 250/250 baseline/hypothetical
  hybrid successes. This still evaluates the **disabled experimental policy**;
  it is not the active runtime and is not evidence for this prompt change.

Commands: `npm test -- --runInBand`,
`node tests/benchmarks/issue91-route-correction.cjs`,
`node tests/benchmarks/issue91-initial-candidates.cjs`.
All benchmark outcome/request metrics match the prior recorded synthetic results.
No real model or map improvement is claimed.

## Completed exploratory provider tests (2026-10-10)

After the earlier five-raw-to-three-retained result, the prompt was refined with
whole-batch self-check guidance. An authorized, temporary CloudBase deployment
of `aiRoutePlannerIssue91AB` was used for **live** `hy3` prompt A/B tests
and Tencent Walking API evaluations in WeChat DevTools. The separately deployed
test function is **not** the production `aiRoutePlanner`.

In four model-only draws per variant using the same nominal 12 verified Guangzhou
POIs and 30-minute out-and-back request, the pinned prior-prompt control
(`72f8155`) retained 11/20 raw sets (4 multi-POI), while the whole-batch
self-check treatment (`3f0134a`) retained 20/20 (18 multi-POI). Retention
means structural cloud-contract acceptance, **not** that a walking route passes
real duration validation. In an excluded-set stress test, 3/15 treatment
proposals still repeated previously excluded complete sets across rounds.

Three additional live HY3/Tencent first-route DevTools trials per prompt variant
recorded mean generation-to-first-valid-route latency of **22.709 s control vs
17.135 s treatment**. The first AI candidate succeeded in 2/3 control runs and
3/3 treatment runs; all six sessions obtained a valid route with one initial HY3
request each. These are descriptive small, nonrandomized samples: provider
latencies and model draws vary, and the control is an **older experimental prompt
on this PR**, not a pinned `develop` implementation. This is neither a causal
performance estimate nor end-user screen-paint latency.

A separate sparse-POI simulated-location check found one verified park POI and
produced a valid 20-minute loop request (18-minute / 1,202-meter route). At a
nearby starting point, the only POI was approximately 4 meters away; its
8-meter loop had zero reported duration and failed the unchanged validator.
This is a route-coverage boundary case, not evidence for relaxing validation.

## Remaining acceptance and rollout conditions

The exploratory provider tests above **have been run**, but device acceptance,
broader durations, controlled `develop` versus PR comparisons, and a production
rollout decision are still outstanding. The PR is ready for **code review**, not
approved for production deployment or merge on the strength of these samples.
The production `aiRoutePlanner` has **not** been deployed with this PR's prompt;
the temporary `aiRoutePlannerIssue91AB` was deployed and invoked only for
the separate tests described above. Preserve strict validation and provider
budgets; keep raw prompts, POI identifiers and precise locations out of shared
test reports. See the PR description for the full test matrix, caveats, and
temporary-function cleanup requirements.
