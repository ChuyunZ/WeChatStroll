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
5. Evaluate candidates round-robin across frontiers, including failed seeds, using `evaluateRouteOrder`. Global deduplication prevents overlapping frontiers from consuming budget twice. Retain each frontier's best real result for the next improvement round and return the best feasible result discovered across all evaluations.

There are at most 24 distinct complete evaluations and two improvement rounds. Failed evaluations consume the same budget. The public error `WAYPOINT_ORDER_NOT_FOUND` means the bounded search found none, not that no feasible permutation exists. Diagnostic `optimization` metadata retains strategy, counts and budget state. Validation errors and `NO_WAYPOINTS` remain distinct.

`getCachedSegmentCosts()` is a synchronous session API returning copied scalar records: directed `edgeKey`, `success`, and successful `durationSeconds`/`distanceMeters`. It exposes neither the mutable Promise cache nor provider payloads. Pending segments are omitted; successful and failed settled requests retain existing cache reuse. `getWaypointSearchData(ids)` also returns the session's route type for topology construction.

There is no randomness: identical trusted inputs, requested duration and cache facts at the round boundaries produce identical priorities, evaluation order and recommendation. Lists are not resorted mid-round as new segments resolve. A later search with more cached facts may explore in a different order. Geometry and the fixed speed are only exploration estimates; neither contributes to the final route score. Missing-edge estimates can be optimistic and the bounded heuristic does not guarantee a global optimum. Whole-traversal estimation adds small local computation (at most eight waypoints) without extra provider calls for sorting.

Four-point prefetch resolves up to 16 directed edges for point-to-point routes, or 20 for loop/out-and-back routes, on an empty session cache. The concurrency limit remains 4. Although four-point exact search has the same 24-order ceiling as the previous heuristic budget, upfront prefetch may increase initial latency versus lazy edge loading; subsequent evaluations and final builds reuse cached segments. No complete graph is prefetched for 5–8 points.

With a target, compare absolute duration error in seconds, then total seconds, distance, and lexicographic ID sequence. Without a target, start with total seconds. ID sequences are compared element by element without locale-dependent sorting or delimiter concatenation. Duration is a soft target: a 44-minute route beats a 30-minute route for a 45-minute request; the optimizer does not apply an acceptance cutoff.

Success includes `recommendedWaypointIds` and `optimization` with `strategy`, `waypointCount`, `evaluatedOrderCount`, `seedCount`, `improvementRounds`, `budgetExhausted`, `durationSeconds`, `distanceMeters`, and `targetErrorSeconds`. Evaluated orders are not provider-call counts: segment caching deduplicates successful, failed and in-flight requests.

## Generation and lifecycle

Both `generateRoutes` and the routes page call `buildOptimizedCandidateRoute` to claim an unused candidate, optimize, build once, and settle success/failure. Original IDs stay on the cache entry; the route also retains original IDs, recommended IDs, optimization metadata, `routeOrder`, and POI IDs. The old `generateFirstRoute` single-POI compatibility path remains supported; it has no ordering choice.

The page ignores duplicate replacement clicks and results belonging to an unloaded or replaced session. Service exceptions mark the candidate failed, and page cleanup releases the click guard. A replacement reuses the existing session; a fresh planning request or unload ends its page ownership. In-flight work may finish against its captured old cache, but cannot update the new page or session. This change does not cancel outstanding provider requests.

No POIs, a legal empty plan, or no successful route enters the existing empty UI with a neutral suggestion to adjust duration/preferences. Malformed AI responses and AI request errors retain the error path. Walking segment failures make affected orders unavailable.

## Map display

Both pages retain every POI in visit order, with compact numbered markers and full names in the text list. Only the final visited POI can share the point-to-point endpoint marker when its coordinate matches the endpoint; earlier colocated POIs stay ordinary markers. If the final POI has invalid or different coordinates, a separate endpoint marker remains. Shared start/end coordinates retain a combined marker. Label text/background contrast is tested at a minimum of 4.5:1.

Route Detail preserves an explicit `returnsToStart` boolean and derives it from `routeType` for legacy data. Point-to-point legends show a start and separate end item; returning routes show a shared start/return item without a separate end item.

## Verification

Run `npm test -- --runInBand` (`npm.cmd` in PowerShell when script execution policy blocks `npm.ps1`). Tests use mocked segment resolvers/cloud calls, not live AI or AMap. They cover directed costs for all route types, seconds-based ranking, exact/heuristic boundaries, deterministic budgets, invalid inputs, cached failures, cross-candidate reuse, metadata, empty/error distinctions, duplicate clicks and stale results.

Real device rendering and live provider behavior still require a WeChat Developer Tools check. Membership, editing UI, persistent caching and final duration acceptance/fallback remain outside #66.
