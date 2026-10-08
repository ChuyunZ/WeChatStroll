# Waypoint order optimization (#66)

AI selects sets of verified POI IDs. The application chooses their visit order using complete, directed walking routes. It never adds, removes or replaces points to reach the requested duration.

## Limits and deployment boundaries

- Each nonempty candidate contains 1–8 distinct verified POIs. Eight is a temporary product limit, not a VIP entitlement check.
- AI can return 0–5 candidates. Only an explicit, correctly shaped `{"candidates":[]}` is a normal no-result response. Invalid candidates are filtered as before; if every supplied candidate is invalid, the response remains an error. Equal or subset candidate sets remain incompatible.
- Initial generation displays at most three successful routes and stops processing as soon as three are displayed. Remaining candidates are retained for manual alternatives. This display count is separate from the waypoint limit and the exact-search threshold.
- `miniprogram/config/route-planning.js` holds client limits. `cloudfunctions/aiRoutePlanner/routePlanContract.js` holds the independently deployed cloud contract. A test keeps `MAX_WAYPOINTS` aligned; there is no cross-deployment runtime import. Deploy both updated components together.

## Shared session and evaluation

`createRoutePlanningSession` owns the verified waypoint registry and directed segment Promise cache. `getWaypointSearchData(ids)` validates the candidate scope and returns copies of trusted IDs and coordinates for seeding. `evaluateRouteOrder` and `buildRouteForOrder` share validation, traversal and segment resolution. Evaluation returns only complete duration/distance or a failure; it does not assemble a polyline for every permutation.

For start S and order A, B, C:

- `point_to_point`: S → A → B → C
- `loop`: S → A → B → C → S
- `out_and_back`: S → A → B → C → B → A → S

There is no fixed destination parameter. Reverse segments have their own costs and failures. The engine continues to allow ordered subsets for future editing; the optimizer always searches complete permutations of the selected set.

## Search and scoring

`optimizeWaypointOrder({ session, waypointIds, requestedDurationMinutes })` rejects invalid scopes, more than eight points, and invalid supplied durations. An omitted duration means minimize walking time. Zero points returns `NO_WAYPOINTS`; one point still requires a reachable complete route.

At or below `EXACT_ORDERING_MAX_WAYPOINTS` (4), the engine prefetches all required directed edges and the optimizer evaluates every permutation: 1–4 points use exact search, including all 24 permutations for four points. A failed edge invalidates only orders that traverse it. If no complete feasible order exists in the session's resolved segment results, the public error is `WAYPOINT_ORDER_NOT_FOUND`.

For 5–8 points, the bounded heuristic follows this flow:

1. Generate at most three distinct deterministic seeds: nearest-neighbor coordinates, their reverse, and sorted POI IDs. Evaluate the seeds using real walking costs.
2. Generate each frontier's relocation (remove one item and insert it at another index), swap (exchange a pair), and 2-opt (reverse an inclusive contiguous interval) candidates. Skip the unchanged order and deduplicate by complete ID sequence. If multiple moves produce the same order, retain canonical metadata by move type (`relocation`, `swap`, `two_opt`), source index, target index, then ID sequence.
3. Take one resolved-cost snapshot per round, shared by all frontiers. Estimate each complete candidate traversal using cached directed duration/distance where available. Missing or pending edges use great-circle distance and a fixed 1.4 meters/second conversion for estimated time; no provider request or waiting is involved. Known failed edges remain failures and candidates with fewer such edges take priority.
4. Sort each frontier's unique candidates by failed-edge count, estimated absolute target-duration error (when supplied), estimated duration, estimated distance, then canonical move metadata. All three move types use this same whole-traversal estimator, including every reversed internal edge in 2-opt and the return edges required by the route type. No symmetric edge-cost shortcut is used.
5. Evaluate candidates round-robin across frontiers, including failed seeds, using `evaluateRouteOrder`, until the current round's quota is reached or all iterators are exhausted. Global deduplication prevents overlapping frontiers from consuming budget twice. Retain each frontier's best real result for the next improvement round and return the best feasible result discovered across all evaluations.

There are at most 32 distinct complete evaluations, including seeds, and three improvement/search rounds. At the start of zero-based round `round`, set its quota to `ceil((32 - evaluated.size) / (3 - round))`. With three seeds and enough unseen neighbors, the rounds evaluate 10, 10 and 9 new orders. With two seeds they can evaluate 10, 10 and 10. Unused capacity is redistributed using actual counts at the next round boundary. Only NEW distinct complete-order evaluations consume quota; globally cached order results do not, while failed evaluations do. Both the round quota and global bound are checked before each frontier gets a turn, preventing overshoot within a round-robin cycle.

No improvement alone does not stop the search: newly settled directed costs can change the next round's priorities even when the frontier stays unchanged. Each next round rebuilds neighbors and priorities from one fresh, fixed settled-cost snapshot. Search ends when a round evaluates zero new distinct orders, the total budget is exhausted, or three rounds have run. An improved frontier can therefore expose second-hop neighbors that no original seed could reach with one move. The estimator never selects the winning frontier; only the real-cost comparator does.

The public error `WAYPOINT_ORDER_NOT_FOUND` means the bounded search found none, not that no feasible permutation exists. Diagnostic `optimization` metadata retains strategy, counts and budget state. Validation errors and `NO_WAYPOINTS` remain distinct.

`getCachedSegmentCosts()` is a synchronous session API returning copied scalar records: directed `edgeKey`, `success`, and successful `durationSeconds`/`distanceMeters`. It exposes neither the mutable Promise cache nor provider payloads. Pending segments are omitted; successful and failed settled requests retain existing cache reuse. `getWaypointSearchData(ids)` also returns the session's route type for topology construction.

There is no randomness: identical trusted inputs, requested duration and cache facts at the round boundaries produce identical priorities, evaluation order and recommendation. Lists are not resorted mid-round as new segments resolve. A later search with more cached facts may explore in a different order. Geometry and the fixed speed are only exploration estimates; neither contributes to the final route score. Missing-edge estimates can be optimistic and the bounded heuristic does not guarantee a global optimum. Whole-traversal estimation adds small local computation (at most eight waypoints) without extra provider calls for sorting.

Four-point prefetch resolves up to 16 directed edges for point-to-point routes, or 20 for loop/out-and-back routes, on an empty session cache. The concurrency limit remains 4. Exact search still exhaustively evaluates all 24 four-point permutations independently of heuristic budgets. Upfront prefetch may increase initial latency versus lazy edge loading; subsequent evaluations and final builds reuse cached segments. No complete graph is prefetched for 5–8 points.

With a target, compare absolute duration error in seconds, then total seconds, distance, and lexicographic ID sequence. Without a target, start with total seconds. ID sequences are compared element by element without locale-dependent sorting or delimiter concatenation. Duration is a soft target: a 44-minute route beats a 30-minute route for a 45-minute request; the optimizer does not apply an acceptance cutoff.

Success includes `recommendedWaypointIds` and `optimization` with `strategy`, `waypointCount`, `evaluatedOrderCount`, `seedCount`, `improvementRounds`, `budgetExhausted`, `durationSeconds`, `distanceMeters`, and `targetErrorSeconds`. The added `evaluationBudget` is 32 in heuristic mode and `null` in exact mode. `roundEvaluationCounts` reports actual new distinct evaluations in each executed round, including a final zero if exhaustion stopped the search. Its length equals `improvementRounds`; in heuristic mode its sum plus `seedCount` equals `evaluatedOrderCount`. Exact mode reports `roundEvaluationCounts: []` and zero search rounds. Evaluated orders are not provider-call counts: segment caching deduplicates successful, failed and in-flight requests.

## Generation and lifecycle

`generateRoutes()` returns immediately after the first successful candidate (skipping failed candidates). It returns the same runtime planning session and candidate cache for continuation. The page enters `success` immediately and keeps the first route usable while appending further unseen successes, up to three displayed routes. No second AI request is made. `isLoadingMoreRoutes` shows a lightweight progress message; manual controls are hidden until initial fill settles (three displayed routes or the captured unused batch exhausted). Handlers also reject programmatic manual actions during fill.

Continuation captures request ID, session, candidate cache, location and duration preference. It checks identities before claiming another candidate and after each await. Reload, unload or changing preferences invalidates ownership, so old work may finish its captured provider calls/cache updates but cannot append to or clear loading state on the current page. Exceptions during background fill leave existing routes visible and allow the next candidate to be tried.

Both `generateRoutes` and the routes page call `buildOptimizedCandidateRoute` to claim an unused candidate, optimize, build once, and settle success/failure. Original IDs stay on the cache entry; the route also retains original IDs, recommended IDs, optimization metadata, `routeOrder`, and POI IDs. The old `generateFirstRoute` single-POI compatibility path remains supported; it has no ordering choice.

### Manual route alternatives

- Settled with one/two displayed routes, remaining budget and an eligible unused candidate: show **增加一个路线**. Each click builds through the bounded remaining candidates until exactly one valid unseen route can be added.
- Settled with three routes under the same conditions: show **换一个路线**. It opens inline card selection with **替换这条路线** and **取消选择**. No route is preselected, including Best Match. The selected original stays visible while building; success replaces only that route and reranks all three using the existing ranker and history snapshot.
- Successful additions and replacements share a maximum of **three actions per planning session**. Failure, duplicates, exhausted candidates, cancellation and stale results cost nothing. Controls are hidden while building or when budget/candidates are exhausted. No-result attempts retain the displayed routes and show a recoverable toast. When no eligible candidate remains, each manual action may request up to three new AI batches, checking each candidate in sequence and stopping at the first valid unseen route. Three exhausted AI batches disable further manual actions for the session. Failed candidates are not retried.

The page's private `_seenWaypointSetKeys` uses the existing `waypointSetKey()` helper: trim verified POI IDs, deduplicate, sort and JSON-encode the complete set. Order, route IDs, titles, timestamps and geometry do not identify alternatives. Partial overlap is allowed. Initial successes and manual successes are recorded; keys remain after replacement. Confirmed edits retain the complete recommendation's identity and also record their active subset. Duplicate candidates are deterministically excluded without building them or consuming budget. Building/failed/successful cache entries are not unused candidates.

`_manualAlternativeActionCount`, the seen set, selection, initial-completion flag and pending-operation token are runtime-only private page fields. New planning requests reset them; unload clears ownership. Only labels/selection/loading state reach `data`; nothing is persisted to local storage or CloudBase. The existing single session's directed segment Promise cache is reused by initial generation, Add, Replace, optimizer evaluation and `buildRouteForOrder()`. Valid hits bypass the resolver/provider; cache misses use the existing provider path. A→B and B→A remain distinct. Cached malformed/failed segments cannot become successful routes. A new batch-local candidate cache is retained for later manual actions; the original directed segment cache and session remain shared. No provider retry policy is introduced.

The page rejects double taps and checks request, session, candidate-cache and operation identity before building and after awaits. A selected route must still be the same displayed object before replacement commits, so an intervening confirmed edit is not overwritten. Old detail callbacks check displayed object membership and cannot edit a replaced route. Old completions cannot unlock newer operations. In-flight work may finish against its captured old cache, but cannot update the new page or session; outstanding provider requests are not cancelled.

An exhausted initial pool still allows Add/Replace while a verified POI pool exists and the manual attempt budget is open. Add/Replace reuse that verified pool and history snapshot when requesting up to three AI batches; they never refetch location/POIs or restart the planning session.

Manual AI requests use `replanningContext: { mode: 'manual', attempt: 1..3,
excludedWaypointSets, previousFailures }`. Initial failure replanning retains its
existing contract and prompt. Before requesting AI, the page consumes unused
candidates from both the original cache and the retained manual batch. The first
manual request already excludes all original candidate sets (including successful,
failed and unused entries), all earlier manual batches, runtime attempted sets,
and every previously surfaced set, including replaced routes. Entire manual
batches are remembered even when processing stops early on success.

Exclusions are not failure observations. They ask for new complete combinations
from the existing verified pool; partial overlap is allowed, reordered identical
sets are not new alternatives. Genuine failures from cached candidates use
observation `attempt: 0`; AI rounds use 1..3, and only earlier observations are
included. Failed cached entries with no recorded reason remain exclusions; no
failure reason is inferred from their status. The cloud prompt allowlists failure
fields and accepts at most 20 manual observations. Initial observation semantics
remain unchanged.

Both client and independently deployable cloud prompt normalize exclusions to
sorted, unique, trimmed verified IDs, reject an entire set containing any unknown
ID, and retain the first 100 distinct valid sets of 1–8 input IDs. Overflow is
omitted from the wire/prompt only; complete runtime duplicate rejection remains
authoritative, so an omitted or model-repeated set still cannot reach the builder.
No history is persisted. Three unsuccessful AI rounds exhaust the manual operation
without spending any of the separate three-successful-action budget.

Deployment requires releasing the updated `aiRoutePlanner` prompt together with
the mini-program changes: an older cloud prompt ignores manual attempt-1 history.
No environment-variable, provider configuration or database changes are required.

No POIs, a legal empty plan, or no successful route without provider unavailability enters the existing empty UI with a neutral suggestion to adjust duration/preferences. Malformed AI responses and AI request errors retain the error path. Provider unavailability enters the service-error/retry UI, not the geographic empty-result UI, and is not repaired by AI replanning.

## Walking provider pacing and availability failures

Both POI discovery and walking segments use `mapProvider`, currently implemented with Tencent Maps. Each segment makes one backend call. There is no client request-start scheduler or client-side provider retry. Route Engine still limits logical concurrency to 4 and shares directed Promise results across prefetch, heuristic evaluation, final builds and candidate replacement.

Backend pacing is transactionally coordinated in `provider_rate_limits`, with leases, owner fencing, actual request start accounting and shared cooldown. Only Tencent status 120 permits bounded provider retry; status 121 does not retry. See [map provider deployment](map-provider-deployment.md) for scopes, conservative defaults, deadlines and deployment checks. Configured pacing is not an account quota guarantee.

`PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXHAUSTED`, `PROVIDER_BUSY` and `PROVIDER_GATEWAY_FAILED` propagate as provider availability failures. Session Promise reuse prevents repeated calls for the same edge, but these results are omitted from resolved unreachable-edge costs and do not cause AI replanning. The optimizer propagates provider unavailability instead of treating it as `WAYPOINT_ORDER_NOT_FOUND`. `ROUTE_NOT_FOUND` remains a deterministic walking-route fact. Real-cost scoring, search budgets and final validation are unchanged.

First-route latency avoids waiting for later candidates, but the first candidate still pays its complete optimization cost and backend pacing. Other callers sharing the Tencent key outside the gateway's shared-state boundary are not coordinated by this limiter.

Diagnostics retain raw/validated AI candidate counts and IDs, candidate starts/results, failure stage (`optimization` or `route_build`), compact optimizer counts, failed directed edges and candidate-state summaries. Backend `[Map Provider]` logs expose sanitized scope/timing/status information, never keys, precise coordinates, raw payloads or full URLs. Follow the linked deployment guide to release both provider operations together.

## Map display

Both pages retain every POI in visit order, with compact numbered markers and full names in the text list. Only the final visited POI can share the point-to-point endpoint marker when its coordinate matches the endpoint; earlier colocated POIs stay ordinary markers. If the final POI has invalid or different coordinates, a separate endpoint marker remains. Shared start/end coordinates retain a combined marker. Label text/background contrast is tested at a minimum of 4.5:1.

Route Detail preserves an explicit `returnsToStart` boolean and derives it from `routeType` for legacy data. Point-to-point legends show a start and separate end item; returning routes show a shared start/return item without a separate end item.

## Verification

Run `npm test -- --runInBand` (`npm.cmd` in PowerShell when script execution policy blocks `npm.ps1`). Tests use mocked segment resolvers/cloud calls, not live AI or map-provider APIs. They cover directed costs for all route types, seconds-based ranking, exact/heuristic boundaries, deterministic budgets, invalid inputs, cached failures, cross-candidate reuse, metadata, empty/error distinctions, duplicate clicks and stale results.

Real device rendering and live provider behavior still require a WeChat Developer Tools check. Membership, editing UI, persistent caching and final duration acceptance/fallback remain outside #66.
