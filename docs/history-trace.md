# Historical trajectory API — Issue #87 Phase 3A

The Phase 3B handoff reports Phase 3A development CloudBase/Tencent E2E success.
[History Detail](history-detail.md), explicit “查看实际轨迹” and native map presentation
are now implemented locally; native UI acceptance is still pending. Profile
loading does not fetch GPS. Historical feedback remains read-only through
the unchanged `feedbackStore.getFeedback(walkId)` API.

## Request, authorization and storage

Cloud Function `trackProvider` accepts:

```javascript
{ action: 'searchWalkTrace', walkId: 'walk-1' }
```

Only those two application fields are accepted. The ID must match
`^[a-zA-Z0-9_.:-]{1,200}$`. Unexpected fields (including ownerKey, OpenID, entityId,
startTimeMs, endTimeMs, trajectoryPartial and consent flags) are rejected.
The entry adapter discards CloudBase's `userInfo` and `tcbContext` transport fields;
it is never an identity source, even when forged. The action handler itself keeps
an exact application-field allowlist. The client Service accepts only `{ walkId }`.

The handler reads `cloud.getWXContext().OPENID` once, derives its SHA-256 owner key,
and uses an injected `walkStore.getWalk(walkId)` data-access boundary. This is one
projected `walks.doc(walkId).get()` read with `throwOnNotFound: false`; it preserves
the persisted `_id` for validation. There is no client-supplied ownership filter.

Before any Tencent entity preparation or trace search, require:

- The document exists and its owner matches. Missing and foreign records both
  return `WALK_NOT_FOUND`, regardless of the foreign record's other fields.
- `_id == walkId == requested ID`, `schemaVersion === 1`, status is completed or
  ended_early, and `completionStatus === status`.
- `trajectoryEnabled === true` and `trajectoryPartial` is a Boolean. A valid owned
  terminal walk with explicitly false consent returns `TRACK_NOT_ENABLED`.
- Canonical positive UTC ISO start/completion timestamps, start <= completion,
  safe integer completion <= trajectoryEndTimeMs <= server now (and year 9999),
  positive formal query span, and formal span <= the existing 24-hour limit.

The historical interval is exclusively `[Date.parse(walk.startTime), Date.parse(walk.endTime)]`.
Completion fixes `endTime`; later metadata updates cannot extend it. Mutable
`trajectoryEndTimeMs` is still validated and stored by the unchanged lifecycle,
but never expands the historical query or returned point range. Post-completion
final samples are deliberately omitted to reduce cross-walk mixing.

There is no separate 60-second cleanup limit. Completion response-loss retries may
retain the original confirmation while cleanup finishes minutes later. Such records
remain readable over their formal interval; even cleanup metadata more than 24 hours
after start does not invalidate an otherwise valid query. The 24-hour cap applies
to startTime through endTime. Future or inconsistent metadata still fails validation.
A lifecycle regression covers completion response loss, retry five minutes later,
and cleanup metadata update: only pre-completion samples are returned. No lifecycle,
final sampling, upload, recovery or metadata writer is changed by this fix.

Only after authorization is the existing HMAC-derived per-user Tencent Entity
ensured and searched through the existing signed client. The entity cache cannot
bypass authorization. Upload/entity actions retain their previous lifecycle and
do not acquire a new database dependency.

No GPS, planned route, POI, provider response, ownership key or credential is
persisted by this flow. GPS stays in Tencent Track Cloud and is returned transiently.
Server projections read only the lifecycle fields needed for authorization. New
action failure logs contain only fixed action/error codes, no walk IDs or points.

## Normalized response

Success envelope and client return:

```javascript
// Cloud Function
{ success: true, trace: {
  points: [],
  mileageMeters: null,
  durationSeconds: null,
  available: false,
  retryable: true,
  partial: false
} }
// history-trace.searchWalkTrace({ walkId }) returns the trace object itself.
```

Each point has `latitude` (-90..90), `longitude` (-180..180), and a positive safe
integer `timestampMs` divisible by 1000, no later than year 9999. Optional fields:
`accuracy`/`speed` are finite nonnegative numbers, `direction` is 0..360, `altitude`
is finite (may be negative), and `type` is a nonnegative safe integer. Values must
not exceed safe numeric magnitude. Server numeric strings from Tencent may be
normalized; null/blank/Boolean values are not coerced into coordinates or metadata.
Unknown provider point fields are not returned. The client rejects unknown public
fields, invalid points, flag inconsistencies, duplicates and out-of-order points.

- `available` is exactly `points.length > 0`; `retryable` is exactly its opposite.
- `partial` includes persisted trajectoryPartial, trajectoryEndTimeMs > endTime
  (the cleanup interval is deliberately omitted), detected point loss/filtering,
  duplicate removal and same-second queries omitted below. False does not certify
  GPS authenticity, absence of sampling gaps or complete session coverage.
- Summary metrics are nonnegative finite numbers or null. Missing provider metrics
  stay null. If any point is discarded/deduplicated, both summaries become null:
  the provider aggregate cannot be attributed to the retained point set. No path
  mileage or exercise duration is computed or fabricated. Even numeric metrics
  describe only the queried formal interval, including when later cleanup was
  deliberately omitted. They are not verified full-Walk totals or walking exercise;
  walking elapsed time
  remains the Walk's `actualDurationSeconds`.

The client retains the existing raw-query settings (`optimize: 0`, `get_fields: 1`),
signatures, endpoints and credentials. It follows up to 20 pages and now caps the
aggregate at 10,000 raw points. Repeated/invalid tokens, a missing/non-array track,
invalid metrics and later-page failures reject the whole query. No truncated
success or malformed response is silently transformed into an empty trace.
An explicit empty `track: []` is a valid successful response.

## Seconds, final samples and isolation limits

Existing uploads use `floor(timestampMs / 1000)`. The query uses the persisted
start/end floored to seconds via the existing range validator; returned points
are independently filtered. A point timestamp `t` is kept only if its entire
possible millisecond bucket fits: `t >= startTimeMs && t + 999 <= Date.parse(walk.endTime)`.
This conservatively excludes a shared second between adjacent non-overlapping
walks, and rejects provider points outside the authorized time interval. It may
discard legitimate first/final samples in those ambiguous seconds. Detected
discarding sets partial. Cleanup samples after endTime are never returned, even
when the provider returns them despite the bounded query. No interpolation is performed.
Positive intervals whose start/end floor to the same second return an empty,
partial, retryable trace with null metrics after authorization, without Entity or
provider calls. No end-time extension is used to manufacture a positive provider
query. The unchanged client may retry this empty result within its existing budget.
Zero-duration intervals remain invalid.

Points are sorted by timestamp, then latitude/longitude for deterministic same-second
ordering. Identical timestamp/coordinate samples are deduplicated; optional metadata
differences choose a deterministic representative and mark partial. Same-second
distinct points retain their coordinates, but their subsecond order is unknowable.
Invalid samples alongside retained valid samples cause partial and unknown metrics;
if invalid samples leave no valid in-range points, return `TRACK_INVALID_RESPONSE`.
Valid points all excluded by the boundary produce an explicitly partial, empty,
retryable trace, not a provider failure.

**The current per-user Entity and timestamps do not guarantee perfect per-walk
point attribution.** Adjacent non-overlapping ranges are conservatively filtered,
but truly overlapping formal intervals, concurrent devices, inaccurate or forged
device timestamps or historical
uploads can still produce same-user cross-walk mixing *inside* the authorized
interval. This implementation does not query neighboring walks or relabel such
samples. Existing uploads are authenticated per Entity but are not bound to a
durable walk ID at Tencent. No stronger isolation is claimed. Complete attribution
requires a separately reviewed per-walk provider identity/session tagging and
upload/finalization migration; it cannot be reconstructed from current timestamps.

## Client retry and errors

`miniprogram/services/history-trace.js` validates the request, reuses
`callCloudFunction`, validates each response and returns a detached trace. Only a
successful, validated, empty/retryable trace receives another request, after 500ms
then 1000ms: at most three queries. Nonempty results stop immediately; authorization,
provider and schema errors are not automatically retried. After exhaustion the
empty/retryable result remains retryable for a later explicit user action.
The Service neither starts tracking nor uploads, changes active sessions, queries
on Profile load, or writes local/CloudBase GPS data.

Errors use `{ success: false, error: { code, message } }` with fixed public messages.
The client preserves allowlisted codes and reconstructs safe messages without raw
error bodies or `originalError`. Unknown codes become `TRACK_PROVIDER_FAILED`.

| Code | Meaning |
| --- | --- |
| UNAUTHENTICATED | Missing/invalid authenticated OpenID |
| INVALID_WALK_TRACE_REQUEST | Invalid ID or unexpected application request fields |
| WALK_NOT_FOUND | Missing or foreign Walk |
| TRACK_NOT_ENABLED | Owned terminal Walk did not opt in |
| INVALID_WALK_TRACE_METADATA | Invalid identity/version/state/quality/time |
| TRACK_WALK_READ_FAILED | Authorization document read failed |
| TRACK_WALK_REQUIRED | Retired arbitrary-range query attempted |
| TRACK_RANGE_TOO_LARGE | Formal startTime-to-endTime interval exceeds 24 hours |
| TRACK_INVALID_RESPONSE | Malformed provider/public trace or no usable samples after invalid-data loss |
| TRACK_SEARCH_TOO_LARGE | Page or point budget exceeded |
| TRACK_SEARCH_PAGINATION_FAILED | Invalid/repeated pagination token |
| TRACK_ENTITY_FAILED / TRACK_SEARCH_FAILED | Provider rejected entity/search operation |
| TRACK_PROVIDER_UNAVAILABLE / TRACK_PROVIDER_REJECTED | Normalized transport/provider failure |
| TRACK_PROVIDER_CONFIG_ERROR / TRACK_PROVIDER_FAILED | Fixed configuration/fallback error |

## Legacy caller audit and migration

Repository-wide search before changes found:

1. `miniprogram/services/walking-tracker.js` exports `searchTrace` and sends the
   generic action. **No application page, service, or script invokes that exported
   search helper**. The walking page calls tracking start/finalize/stop, not search.
2. `tests/walking-tracker.test.js` invokes the exported helper in query/retry and
   quality regression tests.
3. `cloudfunctions/trackProvider/handler.js` calls the internal Tencent client's
   `searchTrace`; handler tests exercise the generic action.
4. `cloudfunctions/trackProvider/track-client.test.js` directly exercises the
   internal client. This internal function is retained and reused.

Because no current product flow needs the generic public query, the server now
rejects `action: 'searchTrace'` with `TRACK_WALK_REQUIRED` before provider calls,
even if a walkId accompanies a client range. There is no remaining generic range
read bypass after deploying this version. The exported walkingTracker.searchTrace
name is retained as a deprecated wrapper requiring **only `{ walkId }`**, delegating
to the dedicated Service and preserving its old `{ success: true, trace }` envelope.
Its old range/quality inputs now reject locally. Existing regression tests were
migrated to the authorized action and retain search normalization, quality and
bounded-retry coverage; explicit retirement tests cover the rejected old inputs.

This is an intentional compatibility break for external/manual callers and any
unseen old client using ranges. Such callers must obtain a durable walkId and
migrate; no safe automatic mapping from arbitrary client times is available.
The active upload/finalization API is unchanged. The handoff reports development
deployment/E2E of Phase 3A; other environments must independently verify their version.

## Review and future development rollout

No new index, collection, schema, permission, environment variable or provider
configuration is required. `trackProvider` now needs server-side read access to the
existing ADMINONLY walks collection via its existing SDK identity. Deploy the
updated trackProvider package only after review; publish migrated callers together
if any external consumers exist. No deployment is performed in this phase.

Development E2E must verify CloudBase event metadata, document projection, owner/
consent rejection without provider requests, real Tencent empty-body shape,
pagination/tokens, seconds/boundary inclusivity and final cleanup latency. Test
closely adjacent sessions, delayed retries, shared-Entity overlap and large traces
before defining Phase 3B display promises. Confirm the old arbitrary-range action
is rejected in the deployed environment. No live validation is claimed by Jest.
See the Phase 3B detail checklist for the pending native UI/device acceptance.
