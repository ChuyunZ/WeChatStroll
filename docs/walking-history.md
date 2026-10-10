# Walking History backend — Issue #87, Phase 1

This phase adds a read-only `walkStore.listHistory` action and the Mini Program
`services/walk-records.listHistory` service. Phase 2 now consumes this API in the
[native Profile UI](profile-ui.md); History Detail and GPS maps remain Phase 3.
No persistence schema changes are needed.

## Request and response

Call Cloud Function `walkStore` with:

```javascript
{ action: 'listHistory', limit: 10, cursor: null }
```

`limit` defaults to 10 and must be an integer from 1 through 20 (invalid values
are rejected, not clamped). Missing `cursor` means null. For subsequent pages,
pass the previous `nextCursor` unchanged; the page size may change.
Only action, limit and cursor are read. Client-supplied ownerKey/OpenID and other
top-level fields never affect authentication or selection.

Successful Cloud Function response (example with `limit: 1`):

```javascript
{
  success: true,
  items: [{
    walkId: 'walk-001',
    status: 'completed',
    startTime: '2026-10-09T00:00:00.000Z',
    endTime: '2026-10-09T00:30:00.000Z',
    actualDurationSeconds: 1800,
    routeType: 'loop',
    requestedDurationMinutes: 30,
    trajectoryEnabled: true,
    trajectoryPartial: false,
    trajectoryEndTimeMs: 1791505805000,
    rating: 5
  }],
  nextCursor: {
    version: 1,
    endTime: '2026-10-09T00:30:00.000Z',
    walkId: 'walk-001'
  },
  totals: { completedWalkCount: 32, endedEarlyWalkCount: 7 }
}
```

`nextCursor` is null when no further matching row was observed, including an
exactly full final page. Empty history returns `items: []`, `nextCursor: null`
and zero totals. Subsequent pages always return `totals: null` and do not execute
count queries. The client service removes `success` and returns
`{ items, nextCursor, totals }`, rejecting malformed responses.

Before creating a public history item, the server also checks the persisted
`schemaVersion === 1` and `completionStatus === status` for each terminal walk,
including the anchor used for a continuation cursor. These fields are read only
for internal validation and are not included in the public item.

All item fields are required, with these constraints:

| Field | Contract |
| --- | --- |
| walkId | 1–200 ASCII letters/digits or `_ . : -`; persisted `_id` must match |
| status | `completed` or `ended_early` only |
| startTime / endTime | Canonical UTC ISO strings with milliseconds, years 1970–9999; end >= start |
| actualDurationSeconds | Nonnegative safe integer, equal to floor((endTime - startTime) / 1000); uses the stored server-computed lifecycle value |
| routeType | `loop`, `out_and_back`, or `point_to_point` |
| requestedDurationMinutes | Integer 15–120, from the walk questionnaire |
| trajectoryEnabled | Boolean consent captured at start; does not guarantee GPS availability |
| trajectoryPartial | Boolean; must be false when trajectoryEnabled is false |
| trajectoryEndTimeMs | Safe integer >= endTime, <= 253402300799999; query boundary metadata, not walking end or duration |
| rating | null when no matching feedback exists, otherwise integer 1–5 |

Totals have exactly the two documented nonnegative safe integer fields. Response
objects and items use strict field allowlists. The client verifies order, unique
IDs, request-cursor advancement, page size and next-cursor equality with the last
item. It rejects unknown fields rather than passing unexpected private data to UI.

Failure envelope:

```javascript
{ success: false, error: { code: 'WALK_STORE_FAILED', message: 'Walk storage is temporarily unavailable.' } }
```

Other codes are `UNAUTHENTICATED`, `INVALID_INPUT` (invalid limit/request), and
`INVALID_HISTORY_CURSOR` (malformed/unsupported/stale cursor). The cursor error
message is `History cursor is no longer valid. Reload history.` The client rejects
with the error code. No failed or partial query becomes empty history, zero counts
or a missing rating. Invalid database records and duplicate IDs fail the whole page
with the fixed `WALK_STORE_FAILED` message; raw database errors are never returned.

## Pagination and query bounds

Sort order is `endTime DESC, walkId ASC`, using binary string ordering. Each status
is queried independently so an empty or much smaller status group cannot hide the
other group's walks. Initial queries each fetch `limit + 1` records. Later pages
use two disjoint ranges per status:

1. `endTime == cursor.endTime AND walkId > cursor.walkId`.
2. `endTime < cursor.endTime`.

Each range fetches at most `limit + 1` rows. Merge all candidates with the same
sort rule, reject duplicate identities, return the first `limit`, and use one
lookahead row to determine continuation. There is no offset, unbounded retry,
collection scan into application memory, or client-side history pagination.

Cursor shape is exactly `{ version: 1, endTime, walkId }`. Before continuation,
an owner-scoped `_id` equality query loads at most one anchor walk. It must still
be a valid terminal walk with matching identity/time. Missing, deleted, changed,
foreign-user or unsupported-version anchors require restarting at page one.
Cursors have **no wall-clock expiry**. They are validated bookmarks, not signed
tokens or authorization: a caller can choose a different valid bookmark among their
own walks, but cannot query another user's data or inject database predicates.
No signing secret, environment variable or persistent cursor collection is added.

At maximum page size, the first page reads at most 42 candidate walks and 21
feedback rows, plus two count queries. Later pages read at most 84 candidates,
one anchor and 21 feedback rows, with no counts. The extra feedback row detects
unexpected duplicate data instead of silently masking it. Empty pages skip feedback.

Normal lifecycle finalization keeps each terminal walk's endTime, status and ID
immutable; trajectory metadata updates do not move rows. Newer walks inserted
between page requests do not shift offsets or repeat already-returned IDs. Newly
finalized backdated walks after the cursor may appear on later pages; those before
it appear on refresh. This is a live keyset traversal, **not a frozen snapshot**.
Administrative mutation/deletion can invalidate cursors and requires refreshing.

## Totals, feedback and isolation

The first page runs CloudBase `count()` separately for
`{ ownerKey, status: 'completed' }` and `{ ownerKey, status: 'ended_early' }`.
These are lifetime database counts, independent of page size and the Preference
Profile's recent-20 evidence window. Active/abandoned/other-user walks are excluded.
Counts assume integrity of server-owned lifecycle data; they do not scan and
revalidate every historical document. Corruption outside the fetched page may
therefore affect counts until repaired administratively.

Only selected page IDs enter a single `feedback` query with server-derived
`ownerKey` and `walkId in IDs`. Validate owner, `_id == walkId`, selected identity,
uniqueness and rating before returning only the rating. There are no per-walk
feedback calls. Query failure or malformed feedback fails the page.

All queries, including cursor-anchor reads and counts, include the SHA-256 owner
key derived solely from `cloud.getWXContext().OPENID`. Both collections remain
server-only / ADMINONLY. Queries project only the required metadata; ownership
and document IDs are checked internally and not exposed. No ownerKey/OpenID,
route snapshot, planned polyline/distance, coordinates, POIs, raw provider data,
GPS points, comments or feedback tags are returned or newly persisted.

The independent walk, count and feedback queries are not a transactionally
consistent snapshot. Concurrent completion/feedback can be reflected on refresh;
counts and items can reflect slightly different moments. Client validation does
not require count equality with page lengths for this reason.

## Indexes and review/deployment boundary

Reuse the Issue #81 indexes documented as present in development:

- `walks`: `ownerKey ASC, status ASC, endTime DESC, walkId ASC`.
- `feedback`: `ownerKey ASC, walkId ASC`.
- Cursor anchor uses the existing `_id` primary index, with owner filtering.

Counts use the walk index's equality prefix. Equality/range queries and ordered
reads use the same compound index; no new custom index is designed for this phase.
See the [CloudBase Node SDK database reference](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)
for query/count semantics. Target-environment index availability and query plans
still need a live smoke test after review; this work changes no indexes, permissions,
environment variables or CloudBase configuration and deploys no function.

The Phase 2 handoff reports successful Phase 1 development CloudBase E2E for
counts, pagination, ratings and invalid cursors. Phase 2 consumes this unchanged
contract in the [Profile UI](profile-ui.md); its native UI acceptance is separate.
Phase 3 remains unimplemented.
