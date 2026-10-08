# Street preference ranking (#84)

Street means ordinary urban road walking exposure supported by walking-route
classification. It is a route characteristic, not a POI category. Park or Water
POIs can coexist with Street exposure. It makes no claim about scenery,
architecture, safety, quietness, comfort or neighborhood attractiveness.

## Source and limits

Verified on 2026-10-08 against Tencent's official
[walking documentation, section 2](https://lbs.qq.com/service/webService/webServiceGuide/webServiceRoute#3).
The walking response table defines `steps[].type` as 0 ordinary road, 1 footbridge,
2 underground passage and 3 pedestrian crossing. Both step `distance` and route
`distance` are meters; route duration is minutes. No walking-specific `road_class`
meaning is used. AMap `walk_type` and former `environmentStats` are unrelated.

The documentation labels type as required but its illustrative response omits it
and abbreviates intermediate steps. Consequently documentation establishes field
semantics, not universal field availability or complete distance accounting.
Authorized development tests on 2026-10-08 confirmed numeric types on all 8/8
steps for a 1213 m walking route and 10/10 steps for a separate 1252 m route;
the classified step totals were respectively 1209 m and 1247 m. Reverse walking
of the first route reproduced the same 4 m discrepancy. These observations
are consistent with integer-step rounding but do not establish its cause or
guarantee coverage across all routes. Unknown/missing codes remain unclassified,
including numeric strings. Do not
parse instructions/road names or use geometry as substitute evidence.

## Optional capability

Only the cloud walking response may contain an optional allowlisted aggregate:
`streetEvidence: { coverageRatio, ordinaryRoadRatio, classificationComplete? }`.
The optional boolean is present as `true` only for wholly classified integer-
meter step lists whose small distance-accounting shortfall meets the independent
caps described below. It is a confidence gate, not a claim that the measured
coverage is 100%. Unknown is absence on the wire and `null` in the runtime
reader, never a known zero ordinary-road ratio.

For a provider segment, classified meters sum steps with known numeric codes;
ordinary meters sum only type 0. Coverage is classified meters / actual route
meters; ordinary-road ratio is ordinary meters / classified meters. Missing steps,
no classified distance, zero route distance, malformed steps, negative/nonfinite/
nonnumeric step distances, overflowing sums or summed steps exceeding the route
distance make the capability unknown. A shorter step list or unknown types reduce
measured coverage. A positive gap between route and summed-step meters never
changes the measured coverage value. Cloud marks `classificationComplete: true`
only if **every** provided step has type 0–3, all route/step distances are
integers, and the nonzero shortfall is at most all three bounds:
`0.5 m × stepCount`, `0.005 × routeDistanceMeters`, and `10 m`.
This is a conservative empirical accommodation, **not** proof that all missing
distance is rounding; no unclassified type qualifies, and no missing meters are
filled in. A larger shortfall, missing type, fractional distance or overcount
gets no completion marker. Invalid optional evidence does not discard otherwise
valid walking facts.

The client independently validates both finite ratios in [0,1], with positive
coverage. It recognizes only the explicit `classificationComplete: true` boolean
and only if coverage is at least 0.995 and below 1. All other extra fields are
dropped. A missing boolean never qualifies sub-100% coverage for a bonus.
The allowlisted aggregate enters an internal WeakMap; raw provider metadata and
caller-supplied route/segment `streetEvidence` or `environmentStats` properties
are never evidence sources.

For every required directed segment i with real length d_i:

```
D = sum(d_i)
C = sum(d_i * coverage_i)                  // unknown contributes no classified meters
O = sum(d_i * coverage_i * ordinaryRatio_i)
coverageRatio = C / D
ordinaryRoadRatio = O / C                  // C = 0 or D = 0 means unknown
```

Return and reverse edges count separately. Ratios are never averaged without
distance weighting. Missing positive-distance edges reduce coverage and block the
tiny-gap exception regardless of the aggregate numerical ratio; a zero-length
edge contributes no distance. A completed route carries the optional marker only
if **every positive-distance directed segment** is exactly complete or explicitly
qualified by the cloud, and overall coverage remains at least 0.995. Invalid
walking segments still fail normal validation.

## Positive bonus

`STREET_BONUS_CONFIG` names the provisional choices:

- `maxBonus = 0.05`
- `rankStrengths = [1, 0.5, 0, 0]` for current Street rank 1–4
- `minimumCoverage = 1` for exact measured coverage
- `minimumToleratedCoverage = 0.995` **only** with explicit trusted
  `classificationComplete: true` (not a general 99.5% threshold)

```
StreetEvidence = coverageRatio * ordinaryRoadRatio
StreetBonus = 0.05 * PreferenceStrength * StreetEvidence
FinalScore = BaseScore + StreetBonus
```

Unknown, partially classified evidence, uncovered directed edges or absent
Street preference gives zero bonus. A small bounded accounting gap qualifies
only with the explicit completion marker; the actual measured coverage ratio
still scales the bonus.
A known zero ordinary-road ratio is distinguishable from unknown. All base
components missing still yields a null total and no bonus. Score can exceed 1;
clamping would erase differences near the top. Ranking remains downstream of
validation; Street never makes a failed route eligible.

The completion gate is deliberately conservative and not empirically calibrated
beyond two observed routes. The 0.5 m/step, 0.5% and 10 m caps are provisional
heuristics for small integer-meter distance accounting gaps, **not** assumed
Tencent rounding guarantees. An omitted step could still resemble such a gap;
more live diversity testing is required before production confidence.
The coefficient is also provisional: first preference can overcome a base-score
gap below 0.05, second below 0.025. Larger base gaps dominate. Missing evidence
is not presented as low Street quality in the UI.

Duration/current environment/history weights remain 0.50/0.30/0.20, including
existing missing-component renormalization and tie-breaking. The three verified
POI categories retain their scoring semantics. Street stays out of both current
and historical environment formulas; history's `street` weight is not counted
again. There is no new AI planning/replanning or waypoint optimization signal.

## Runtime lifecycle and persistence

WeakMap keys are exact segment/result/route objects, never generated route IDs.
Entries carry a fingerprint of walking facts and active order; mutating those
facts invalidates the evidence. Only internal normalization/formatting operations
explicitly transfer evidence. Copies, JSON round trips, UI projections and restored
snapshots do not inherit it. Internal sidecar helpers are not a public capability
authentication API; production ingestion is exclusively the cloud-response boundary.

The directed session cache retains normalized segment identities. Route assembly
aggregates only the actual traversal. Initial and progressive candidates, manual
Add/Replace and fallback formatters transfer to each final route object. Validated
edits transfer from the newly built traversal, never the old route; reusing routeId
therefore cannot reuse evidence. Existing request/session/cache/operation guards
reject stale async completions. Old work can populate only its own object entries.
Weak references allow discarded objects and their evidence to be collected.

`rankRoutes()` does not modify route objects. No evidence field is added to public
engine segments, generated routes, `activeWalkSession`, `pendingWalkResult`, Walk,
feedback or persisted snapshots. Existing #94 storage behavior is unchanged.
There are no extra provider calls, persistent caches, configuration or quota changes.
Cloud and client updates need a future coordinated release; an older cloud response
simply supplies unknown. Nothing was deployed as part of this local implementation.

## Verification and remaining checks

Focused tests cover provider normalization/leakage, distance weighting, unknown
capability, base-score compatibility, rank strengths, deterministic ordering,
object identity, mutation invalidation, serialization, initial/fallback generation,
progressive arrival, Add/Replace and stale completions. Existing validation,
editing and lifecycle suites remain authoritative too.

Run `npm test -- --runInBand` (`npm.cmd` under restrictive PowerShell policy).
The first live CloudBase provider tests showed 4 m/8-step and 5 m/10-step
shortfalls, with zero missing or unknown type codes. The final corrected cloud +
client ranking path has **not** yet been redeployed or device-E2E verified.
Before release, verify the optional completion marker on the two measured test
routes, real ranking changes and unchanged storage snapshots in authorized
WeChat Developer Tools/device checks. Do not make live provider calls without
authorization. Official type 0
is a walking facility classification, not independent proof of urban land use.

## Proposed Issue #84 description corrections (not applied remotely)

Replace **Existing Signal** with:

> Tencent migration removed the former AMap environmentStats fields. Walking facts
> are distanceMeters, durationSeconds and polyline. #84 adds an optional normalized
> streetEvidence aggregate derived only from documented Tencent walking type and
> step distance fields. Absent or unreliable evidence is unknown. The aggregate
> is runtime-only and never a Route/Walk persistence field.

Replace the provider-migration requirement with:

> Consume provider-independent coverageRatio and ordinaryRoadRatio through an
> object-identity runtime sidecar. Do not restore AMap fields or infer road_class
> semantics. Validate and distance-weight every required segment; unknown segments
> reduce coverage. Exact coverage permits a bonus; bounded gaps permit it only
> with explicit cloud-verified classificationComplete evidence that every step
> has a known type and the integer-meter distance discrepancy meets all three
> strict caps (0.5 m/step, 0.5% of route distance, 10 m).

Replace the ranking requirement with:

> Preserve the 0.50/0.30/0.20 base formula and normalization. Add a positive-only
> bonus of 0.05 × current Street rank strength × coverageRatio × ordinaryRoadRatio
> for exact or explicitly verified bounded-gap coverage; strengths are
> 1, 0.5, 0, 0. These constants are provisional.
> Street is ordinary road walking exposure, with no scenic or safety implication.
> Keep Street out of current/historical POI environment formulas.

Replace the first acceptance criterion with:

> With trustworthy complete evidence, current Street rank 1/2 affects otherwise
> tied valid route ranking. Missing/partial evidence earns no bonus and is not
> labeled poor Street quality. Live data establishes small distance-accounting
> shortfalls with all step types classified; post-fix end-to-end ranking remains
> an authorized E2E check.

Add an acceptance criterion:

> Initial/progressive, Add/Replace, fallback and validated edit flows preserve
> evidence identity without attaching it to snapshots. Reused IDs and late results
> cannot alter another route/session's scores. No extra provider calls or persistence.
