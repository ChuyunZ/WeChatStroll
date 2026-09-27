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

At or below `EXACT_ORDERING_MAX_WAYPOINTS` (3), the engine prefetches all required directed edges and the optimizer evaluates every permutation. A failed edge invalidates only orders that traverse it. No valid permutation returns `NO_FEASIBLE_ORDER` for the session's resolved segment results.

Above the threshold, deterministic nearest-neighbor coordinates, their reverse, and sorted POI IDs supply at most three distinct seeds. Straight-line proximity only seeds the search. Relocation and pair-swap neighbors are explored in a fixed order, round-robin across seeds, including failed seeds. There are at most 24 distinct complete evaluations and two improvement rounds. Failed evaluations consume the same budget. The best discovered feasible order is returned; `SEARCH_NO_FEASIBLE_ORDER_FOUND` means the bounded search found none, not that no route exists.

With a target, compare absolute duration error in seconds, then total seconds, distance, and lexicographic ID sequence. Without a target, start with total seconds. ID sequences are compared element by element without locale-dependent sorting or delimiter concatenation. Duration is a soft target: a 44-minute route beats a 30-minute route for a 45-minute request; the optimizer does not apply an acceptance cutoff.

Success includes `recommendedWaypointIds` and `optimization` with `strategy`, `waypointCount`, `evaluatedOrderCount`, `seedCount`, `improvementRounds`, `budgetExhausted`, `durationSeconds`, `distanceMeters`, and `targetErrorSeconds`. Evaluated orders are not provider-call counts: segment caching deduplicates successful, failed and in-flight requests.

## Generation and lifecycle

Both `generateRoutes` and the routes page call `buildOptimizedCandidateRoute` to claim an unused candidate, optimize, build once, and settle success/failure. Original IDs stay on the cache entry; the route also retains original IDs, recommended IDs, optimization metadata, `routeOrder`, and POI IDs. The old `generateFirstRoute` single-POI compatibility path remains supported; it has no ordering choice.

The page ignores duplicate replacement clicks and results belonging to an unloaded or replaced session. Service exceptions mark the candidate failed, and page cleanup releases the click guard. A replacement reuses the existing session; a fresh planning request or unload ends its page ownership. In-flight work may finish against its captured old cache, but cannot update the new page or session. This change does not cancel outstanding provider requests.

No POIs, a legal empty plan, or no successful route enters the existing empty UI with a neutral suggestion to adjust duration/preferences. Malformed AI responses and AI request errors retain the error path. Walking segment failures make affected orders unavailable.

## Verification

Run `npm test -- --runInBand` (`npm.cmd` in PowerShell when script execution policy blocks `npm.ps1`). Tests use mocked segment resolvers/cloud calls, not live AI or AMap. They cover directed costs for all route types, seconds-based ranking, exact/heuristic boundaries, deterministic budgets, invalid inputs, cached failures, cross-candidate reuse, metadata, empty/error distinctions, duplicate clicks and stale results.

Real device rendering and live provider behavior still require a WeChat Developer Tools check. Membership, editing UI, persistent caching and final duration acceptance/fallback remain outside #66.
