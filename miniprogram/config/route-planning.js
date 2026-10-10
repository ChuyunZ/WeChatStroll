const EXACT_ORDERING_MAX_WAYPOINTS = 4
const SEGMENT_FETCH_CONCURRENCY = 4

// Cloud functions deploy independently; keep MAX_WAYPOINTS in sync via tests.
const MAX_WAYPOINTS = 8
const MAX_FALLBACK_CANDIDATES = 3
const MAX_AI_PLANNING_ATTEMPTS = 3

// Strict deterministic-correction budgets for both initial and manual flows.
// The exact optimizer can prefetch up to 20 edges for four waypoints, so
// corrections are preflighted against the shared session cache first.
const MAX_CORRECTION_CANDIDATES = 6
const MAX_CORRECTION_NEW_SEGMENTS = 12
const MAX_CORRECTION_WAYPOINTS = 4

// First AI batch: no new network calls, no subset-overlapping POI sets.
// Preserve at least 3/5 AI candidates while allowing up to 2 stronger pairs.
const INITIAL_MAX_CANDIDATES = 5
const INITIAL_MAX_SUPPLEMENTAL_PAIRS = 2
const INITIAL_POOL_POI_LIMIT = 18
const INITIAL_PAIR_MIN_SCORE_GAIN = 0.08
// Strong evidence threshold for replacing initial AI singleton slots with pairs.
// Uses only straight-line time; does not claim a route is invalid.
const INITIAL_SHORT_SINGLETON_TRIGGER_RATIO = 0.40

const ORDERING_MAX_SEEDS = 3
const ORDERING_MAX_EVALUATIONS = 32
const ORDERING_MAX_ROUNDS = 3

// Final route duration acceptance.
//
// The optimizer finds the route closest to the user's requested duration.
// These values define whether that best route is actually close enough to
// be shown to the user.
//
// Use a percentage tolerance for normal cases, while keeping a small minimum
// window for short walks and preventing the window from growing without bound
// for very long walks.
const ROUTE_DURATION_TOLERANCE_RATIO = 0.25
const ROUTE_DURATION_MIN_TOLERANCE_SECONDS = 5 * 60
const ROUTE_DURATION_MAX_TOLERANCE_SECONDS = 30 * 60

module.exports = {
  EXACT_ORDERING_MAX_WAYPOINTS,
  SEGMENT_FETCH_CONCURRENCY,
  MAX_WAYPOINTS,
  MAX_FALLBACK_CANDIDATES,
  MAX_AI_PLANNING_ATTEMPTS,
  MAX_CORRECTION_CANDIDATES,
  MAX_CORRECTION_NEW_SEGMENTS,
  MAX_CORRECTION_WAYPOINTS,
  INITIAL_MAX_CANDIDATES,
  INITIAL_MAX_SUPPLEMENTAL_PAIRS,
  INITIAL_POOL_POI_LIMIT,
  INITIAL_PAIR_MIN_SCORE_GAIN,
  INITIAL_SHORT_SINGLETON_TRIGGER_RATIO,

  ORDERING_MAX_SEEDS,
  ORDERING_MAX_EVALUATIONS,
  ORDERING_MAX_ROUNDS,

  ROUTE_DURATION_TOLERANCE_RATIO,
  ROUTE_DURATION_MIN_TOLERANCE_SECONDS,
  ROUTE_DURATION_MAX_TOLERANCE_SECONDS
}
