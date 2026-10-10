# Historical preference profile (Issue #81)

`preferenceProfileStore` recomputes a small, versioned, explainable profile from
application-owned durable `walks` and structured `feedback`. It is a soft historical
signal, separate from current questionnaire intent. The current questionnaire is
never changed and takes precedence in AI waypoint planning (Issue #82). Profile
computation remains deterministic; route ranking (#83) and Profile UI (#87) remain
separate.

Issue #87 Phase 2 now calls `refreshProfile()` from the [native Profile page](profile-ui.md)
on entry/re-entry. Independent region states and conservative deterministic wording
explain questionnaire intent and explicit feedback without new AI inference.
The UI rule thresholds, limited-evidence wording and lifecycle are documented there.

Issue #87 Phase 1 [Walking History](walking-history.md) supplies independent
lifetime completed/ended-early counts through owner-scoped CloudBase count queries.
The profile's completedWalkCount and endedEarlyWalkCount describe only its recent
20-walk evidence window and must not be used as lifetime Profile UI statistics.

## AI waypoint planning integration (Issue #82)

`route-generation.generateRoutes()` obtains and validates the current location,
searches nearby POIs using the current requested duration, and builds the verified
POI pool. An empty pool returns before refreshing history. Otherwise it calls
`preference-profile-records.refreshProfile()` once, before creating the route
planning session and entering the AI attempt loop. Refresh is necessary because
saving feedback does not automatically recompute the profile.

The validated public profile is projected into a detached snapshot containing only:

| Field | AI input bounds |
| --- | --- |
| `environmentWeights` | Exactly `park`, `water`, `street`, `shoppingStreet`; finite numbers in [0, 1] |
| `preferredDurationMinutes` | null or 15–120, multiple of 5 |
| `crowdPreferenceSignal` | null or finite number in [-1, 1] |
| `likedTags` | Unique allowed positive tags, at most 4 |
| `dislikedTags` | Unique allowed negative tags, at most 8 |
| `evidenceWalkCount` | Integer 1–20 |

The tag allowlists are the same as the public schema below. No schema metadata,
completed/ended-early/feedback counts, evidence tree, source/fingerprint, timestamps,
ownership fields, raw walks, feedback comments, GPS, geometry or provider payloads
are sent as history. `aiRoutePlanner` treats this client input as untrusted and
independently validates all bounds, drops extra top-level fields, and reconstructs
the six-field object. Invalid required fields or extra environment keys cause the
whole history signal to be ignored, without weakening core input validation.

Missing history, malformed profiles and refresh failures are non-fatal: the AI
request omits `historicalPreferenceProfile`, and the original no-history prompt is
preserved. The refresh failure log contains only a fixed unavailable code, never
the upstream error, profile, prompt or coordinates. Every replanning attempt reuses
the same snapshot; previous-failure observations continue to evolve independently.
A new `generateRoutes()` invocation refreshes again. Background candidate filling
uses cached candidates and does not refresh or call AI again.

With valid history, the prompt labels CURRENT WALK INTENT as highest priority and
HISTORICAL PREFERENCE PROFILE as a secondary soft signal. The prompt explicitly
gives current duration, route type, crowd preference and environment ranking higher
priority than conflicting history; hard downstream validation remains authoritative.
Historical tags and crowd signals describe the user, not verified facts about any
current POI. AI still only selects verified POI IDs; the route contract and Route
Engine remain authoritative for coordinates, walking facts and route geometry.
POI search radius, optimizer target and duration validation use current requested
duration. Deterministic fallback continues to use only the current questionnaire.

Demo evidence should show saved feedback producing a changed refreshed profile
that reaches a later AI prompt. A different final route is not guaranteed: it also
depends on the verified POI pool, current intent and model behavior.

## Canonical history and schema

At most 20 most recent `completed` / `ended_early` walks participate. Ordering is
`endTime DESC, walkId ASC`. Active and abandoned walks do not participate. Both
terminal states count as evidence, with separate completion counters. Invalid
walk identity/end time is discarded, invalid signal fields are ignored, and valid
fields on the same walk remain usable. A walk with no usable signal still contributes
to the terminal-walk counters. With no valid environment rankings all weights are
zero (no evidence); missing duration/crowd evidence is `null`.

Storage: `preference_profiles/{ownerKey}` with the following fixed schema:

| Field | Meaning |
| --- | --- |
| `ownerKey` | SHA-256 of authenticated OPENID; server only |
| `revision` | Monotonically increasing snapshot version; server only |
| `schemaVersion` | `1` |
| `environmentWeights` | `park`, `water`, `street`, `shoppingStreet`: each 0–1 |
| `preferredDurationMinutes` | 15–120, multiple of five, or null |
| `crowdPreferenceSignal` | -1–1 or null |
| `likedTags`, `dislikedTags` | Fixed allowlisted tags with positive counts, sorted by count descending then allowlist order |
| `evidenceWalkCount`, `completedWalkCount`, `endedEarlyWalkCount`, `feedbackCount` | Counts in the selected window; at most 20 |
| `evidence.environment` | Each environment's `firstChoiceCount`, `topTwoCount` |
| `evidence.duration` | `durationGoodCount`, `tooLongCount`, `tooShortCount` |
| `evidence.crowd` | `tooCrowdedCount`, `tooQuietCount`, `quietPositiveCount` |
| `evidence.positiveTagCounts`, `evidence.negativeTagCounts` | Counts for every allowlisted tag, including zeroes |
| `source` | `historyLimit: 20`, `newestWalkEndTime`, `latestFeedbackCreatedAt` (null without feedback), SHA-256 `fingerprint` |
| `lastUpdatedAt` | Server ISO timestamp when the logical snapshot changed |

Public profiles contain all fields above except `ownerKey` and `revision`.
Only the database `_id` is additionally present on database reads. Schema validation
rejects unknown public fields at every object level. Fresh users return `profile: null`
without creating a record. If previously present evidence disappears, refresh
replaces the snapshot with a server-only `{ ownerKey, revision, profile: null }`
tombstone, preserving the concurrency fence. A later walk replaces that tombstone.

## Deterministic calculations

All scoring constants are named in `profile-builder.js`; weights and crowd signals
are rounded to four decimal places.

**Environment:** only complete, unique rankings of `公园`, `水边`, `街道`, `商街`
count, mapped respectively to `park`, `water`, `street`, `shoppingStreet`. Scores
are 1, 0.67, 0.33, 0 by rank, averaged over valid rankings. Rating, recommendation,
`nice_view`, `quiet` and all other feedback do not affect environment weights.
This measures historical questionnaire selection tendency, not observed route
environment. There is no trustworthy durable actual-route environment evidence;
`街道` has no POI category. #84's [Street preference bonus](street-preference-ranking.md)
instead uses runtime walking-route evidence and current questionnaire rank only.
Historical `street` remains excluded from deterministic environment fit, preventing
double counting. No Street route evidence is written into this profile, walks or feedback.

**Duration:** valid requested duration contributes weight 1 (fall back to the
questionnaire duration if the top-level field is invalid). This represents intent
for both terminal states, never evidence that early termination satisfied the
request. Actual duration alone adds nothing. With exactly one duration tag and
valid actual seconds, add weight 2:

| Tag | Additional target in minutes |
| --- | --- |
| `duration_good` | `actualDurationSeconds / 60` |
| `duration_too_long` | `min(requested, actual) - 10` |
| `duration_too_short` | `max(requested, actual) + 10` |

Long/short adjustments also require valid requested duration. Clamp each target to
15–120, compute the weighted mean including the base, then round to the nearest
five minutes (half rounds upward). Contradictory duration tags suppress the extra
adjustment and retain only the base. Distance tags do not adjust duration.

**Crowd:** map low/medium/high to -1/0/+1. Questionnaire crowd adds weight 1.
`too_crowded` adds observed minus one at weight 2; `too_quiet` adds observed plus
one at weight 2, clamped to [-1,1]. These require valid observed crowd.
`quiet` alone adds -1 at weight 2 without needing an observation. `quiet` plus
`too_crowded` uses only the observation-relative `too_crowded` adjustment (no double
counting). `too_quiet` together with either quieter tag is contradictory: all crowd
feedback for that walk is ignored. Counts remain. With no crowd-specific tags,
rating >=4 AND recommendation true accepts valid observed crowd at weight 1.
Poor generic ratings never invert preference. Average all applicable evidence.

**Tags:** count each explicit known tag at most once per feedback record. Unknown
tags are ignored defensively. Positive allowlist order: `nice_view`, `quiet`,
`comfortable_route`, `duration_good`. Negative order: `too_crowded`, `too_quiet`,
`distance_too_long`, `distance_too_short`, `duration_too_long`, `duration_too_short`,
`route_hard_to_walk`, `pois_not_interesting`. Contradictory tags still count for
explainability even when their derived direction is ignored. Comments are not read.

## Recompute, idempotency and concurrency

Refresh first reads the snapshot revision, then queries canonical bounded history,
then runs the pure builder. Its fingerprint hashes only normalized allowlisted
evidence in deterministic order (no comments, provider data or ownership key).
Duplicate IDs do not double-count. Input order does not change the result.

An explicit transaction re-reads the profile document, including a missing-document
read for first creation. It writes only if the revision still matches the revision
read **before** loading history. A revision mismatch or recognized database write
conflict retries the entire history load/build/write, at most four attempts with
jittered exponential backoff (10–19 ms, 20–39 ms, then 40–79 ms). This protects late feedback on an older walk even when both
source maximum timestamps are unchanged; timestamp comparison alone would not.
Matching fingerprints retain the original snapshot, revision and update timestamp.
An older in-flight refresh cannot overwrite a newer committed snapshot.

Walk and feedback history queries are not one atomic database snapshot. Feedback
or a completed walk arriving during a refresh can appear on the next explicit
refresh. This API provides bounded recomputation, not a subscription or transactional
coupling to feedback submission. Profile failures cannot turn saved feedback into
failed submissions. No automatic refresh integration is added in this issue.

## Development CloudBase validation

Manual development E2E on 2026-10-07 validated the deployed collection, indexes,
Cloud Function and real stored history. Before the first persisted snapshot,
`getProfile` returned null. The first refresh loaded five terminal walks plus one
feedback record and created revision 1. Repeating refresh with unchanged history
preserved the public profile, fingerprint, `lastUpdatedAt`, and revision.

A second feedback record was saved through `feedbackStore`. The profile remained
unchanged until explicit refresh. That refresh changed `feedbackCount` from 1 to 2,
added `quiet` to `likedTags`, moved `crowdPreferenceSignal` from 0 to -0.25,
changed the fingerprint/timestamp, and advanced revision from 1 to 2. The following
`getProfile` matched the refresh response.

Direct Mini Program testing also exposed CloudBase-added event metadata. The handler
therefore reads only `event.action`; all other event fields are ignored and cannot
influence authentication, history selection, or profile computation. Live multi-user
isolation and forced transaction-conflict cases were not manually induced; those
remain covered by deterministic automated tests.
## Ownership, queries and data boundaries

OPENID comes only from `cloud.getWXContext()`. The handler reads only
`event.action`; any other event fields, whether injected by CloudBase or supplied
by a caller, are ignored and never participate in identity, history loading or
profile computation. Every query includes the server-derived owner key; builder
and feedback join recheck ownership. Document IDs
must match the persisted walk IDs. Database errors expose normalized messages only.
Both collections and this derived collection must remain server-only / ADMINONLY.

Two walk queries use equality `ownerKey + status`, ordered by `endTime DESC,
walkId ASC`, each limited to 20; their union is reduced to 20 before loading feedback.
Thus at most 40 walk rows and 20 feedback rows are fetched per attempt. Feedback
uses `ownerKey` equality plus `walkId in selected IDs`, limited to 20. Projection
includes only required application metadata. See [manual setup](cloud-setup.md).

No route geometry, polyline, coordinates, POIs/IDs/details, walking segments,
provider metadata, raw Tencent responses, GPS samples, or Tencent Track geometry
are consumed or stored. Actual GPS remains in Tencent Track Cloud. No comments or
raw history are copied into the profile, and there is no growing processed-ID list.
Tencent planned-route persistence/AI-use permission remains separate.
