# Waypoint order optimization (#66)

AI selects sets of verified POI IDs. The application chooses their visit order using complete, directed walking routes. It never adds, removes or replaces points to reach the requested duration.

## Limits and deployment boundaries

- Each nonempty candidate contains 1–8 distinct verified POIs. Eight is a temporary product limit, not a VIP entitlement check.
- AI can return 0–5 candidates. Only an explicit, correctly shaped `{"candidates":[]}` is a normal no-result response. Invalid candidates are filtered as before; if every supplied candidate is invalid, the response remains an error. Equal or subset candidate sets remain incompatible.
- Initial generation displays at most three successful routes. Remaining candidates are retained for replacement. This display count is separate from the waypoint limit and the exact-search threshold.
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

`generateRoutes()` returns immediately after the first successful candidate (skipping failed candidates). It returns the same runtime planning session and candidate cache for continuation. The page enters `success` immediately and keeps the first route usable while appending further successes, up to three displayed routes. No second AI request is made. `isLoadingMoreRoutes` shows a lightweight progress message and disables replacement until initial fill settles; the handler also rejects programmatic/duplicate replacement clicks during fill.

Continuation captures request ID, session, candidate cache, location and duration preference. It checks identities before claiming another candidate and after each await. Reload, unload or changing preferences invalidates ownership, so old work may finish its captured provider calls/cache updates but cannot append to or clear loading state on the current page. Exceptions during background fill leave existing routes visible and allow the next candidate to be tried.

Both `generateRoutes` and the routes page call `buildOptimizedCandidateRoute` to claim an unused candidate, optimize, build once, and settle success/failure. Original IDs stay on the cache entry; the route also retains original IDs, recommended IDs, optimization metadata, `routeOrder`, and POI IDs. The old `generateFirstRoute` single-POI compatibility path remains supported; it has no ordering choice.

The page ignores duplicate replacement clicks and results belonging to an unloaded or replaced session. Service exceptions mark the candidate failed, and page cleanup releases the click guard. A replacement reuses the existing session; a fresh planning request or unload ends its page ownership. In-flight work may finish against its captured old cache, but cannot update the new page or session. This change does not cancel outstanding provider requests.

No POIs, a legal empty plan, or no successful route without temporary throttling enters the existing empty UI with a neutral suggestion to adjust duration/preferences. Malformed AI responses and AI request errors retain the error path. If no initial route succeeds and an exhausted throttle was encountered, generation throws `AMAP_RATE_LIMITED` and enters the error/retry UI, not the geographic empty-result UI.

## Walking provider pacing and temporary failures

Each planning session owns a FIFO request-start scheduler. `WALKING_PROVIDER_MIN_INTERVAL_MS = 400` spaces new resolver starts by at least 400 ms (approximately 2.5 starts/second). Responses can overlap; the existing concurrency limit remains separate from QPS. Exact prefetch, heuristic evaluations, final builds, background fill and replacement all share the scheduler and directed Promise cache. Cache hits bypass scheduling, and concurrent duplicate edges share the same pending Promise including its retry sequence. Synthetic offline fixtures explicitly set `providerMinIntervalMs: 0`; production sessions use the configured interval.

AMap `10021` / `CUQPS_HAS_EXCEEDED_THE_LIMIT` becomes the application code `AMAP_RATE_LIMITED` in `getWalkingRoute`. `walking-segment`, engine, optimizer and generation preserve that classification. A genuine zero-route response stays `ROUTE_NOT_FOUND`; malformed responses become `INVALID_WALKING_ROUTE_RESPONSE`, while other provider/network failures remain `WALKING_ROUTE_FAILED`. Logs retain only safe codes and directed node IDs, not raw payloads, coordinates, URLs, keys or polylines.

Only `AMAP_RATE_LIMITED` is retried: `WALKING_PROVIDER_RETRY_DELAYS_MS = [500, 1000]` permits at most three attempts per directed edge. Each retry waits its backoff and then passes through the same scheduler, so queued work can delay it further. Intermediate throttles are not settled edge facts. Eventual success is cached normally. Exhausted throttles are retained as explicitly temporary session results to prevent each permutation/candidate from starting another retry loop; they are omitted from unreachable-edge priority snapshots. A new planning session can retry them. If no feasible evaluated route is found and a temporary failure occurred, the optimizer reports `AMAP_RATE_LIMITED`, not `WAYPOINT_ORDER_NOT_FOUND`. Real-cost scoring and all search budgets remain unchanged.

The reported 3-QPS quota belongs to the AMap key. A per-session limiter reduces single-session bursts but cannot guarantee aggregate quota compliance across users, overlapping sessions, or variable cloud dispatch latency. TODO for production scale: obtain a higher key quota or introduce centralized provider throttling/queueing. This PR does not introduce a distributed lock. First-route latency avoids waiting for later candidates, but the first candidate still pays its complete optimization cost and provider pacing.

Diagnostics retain raw/validated AI candidate counts and IDs, candidate starts/results, failure stage (`optimization` or `route_build`), compact optimizer counts, failed directed edges and candidate-state summaries. `[Route Segment] Rate limited` records attempt and next backoff separately from permanent/provider failures. Deploy the updated `getWalkingRoute` cloud function with the client so the application rate-limit code is available; deploy `aiRoutePlanner` to pick up its diagnostic improvements.

## Map display

Both pages retain every POI in visit order, with compact numbered markers and full names in the text list. Only the final visited POI can share the point-to-point endpoint marker when its coordinate matches the endpoint; earlier colocated POIs stay ordinary markers. If the final POI has invalid or different coordinates, a separate endpoint marker remains. Shared start/end coordinates retain a combined marker. Label text/background contrast is tested at a minimum of 4.5:1.

Route Detail preserves an explicit `returnsToStart` boolean and derives it from `routeType` for legacy data. Point-to-point legends show a start and separate end item; returning routes show a shared start/return item without a separate end item.

## Verification

Run `npm test -- --runInBand` (`npm.cmd` in PowerShell when script execution policy blocks `npm.ps1`). Tests use mocked segment resolvers/cloud calls, not live AI or AMap. They cover directed costs for all route types, seconds-based ranking, exact/heuristic boundaries, deterministic budgets, invalid inputs, cached failures, cross-candidate reuse, metadata, empty/error distinctions, duplicate clicks and stale results.

Real device rendering and live provider behavior still require a WeChat Developer Tools check. Membership, editing UI, persistent caching and final duration acceptance/fallback remain outside #66.
