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

Only the cloud walking response may return an allowlisted
`streetEvidence: { coverageRatio, ordinaryRoadRatio }`. Absent or invalid
evidence is unknown (`null` in the runtime reader), not known zero quality.

Tencent walking `steps[].type` codes 0–3 identify classified walking facilities.
Only numeric code 0 is ordinary road. The cloud computes:

```
classifiedMeters = sum(step.distance for known type 0..3)
ordinaryMeters = sum(step.distance for type 0)
coverageRatio = classifiedMeters / route.distance
ordinaryRoadRatio = ordinaryMeters / classifiedMeters
```

Unknown, missing and numeric-string types remain unclassified; they never
become ordinary roads. Missing steps, malformed/negative/nonfinite distances,
zero route distance, no classified meters, overflow, or summed step distances
greater than route distance make the optional evidence unknown. Otherwise,
valid partial lists or steps with unknown codes merely reduce measured coverage.
No distance is substituted, and **no provider rounding/completeness assumption,
`classificationComplete` marker, or coverage cutoff is used**.

The client validates both ratios as finite in [0,1] and coverage as positive,
discards any extra fields, and retains the allowlisted values only in an internal
WeakMap. Caller-supplied raw steps, route metadata, legacy `environmentStats`
and UI route objects are not alternate evidence sources.

For an assembled route of directed walking segments `i` with distance `d_i`:

```
D = sum(d_i)
C = sum(d_i * coverage_i)                  // unknown segment contributes zero
O = sum(d_i * coverage_i * ordinaryRatio_i)
coverageRatio = C / D
ordinaryRoadRatio = O / C                  // C = 0 or D = 0 means unknown
```

These are distance-weighted, including distinct return/reverse edges. Missing
positive-distance segments contribute zero confirmed meters, not guesses or a
hard failure. Invalid walking segments still fail normal route validation.
Combining these values gives confirmed ordinary-road meters / total route meters.

## Positive bonus

`STREET_BONUS_CONFIG` keeps provisional `maxBonus = 0.05` and
`rankStrengths = [1, 0.5, 0, 0]` for Street ranks 1–4. There is no
minimum coverage percentage.

```
StreetBonus = 0.05 * PreferenceStrength * coverageRatio * ordinaryRoadRatio
            = 0.05 * PreferenceStrength * confirmedOrdinaryMeters / totalRouteMeters
FinalScore = BaseScore + StreetBonus
```

For first-ranked Street, 20% confirmed ordinary-road distance earns +0.010,
90% earns +0.045, and 100% earns +0.050. Unknown road distance earns nothing:
this is conservative **partial credit**, not an estimate of the unknown portion.
A route with 20% coverage is not asserted to be only 20% ordinary road overall.
Even slight observed changes in coverage result in proportional changes in bonus;
there is no sudden 90%, 95%, or 100% scoring discontinuity.

Unknown evidence, zero ordinary-road ratio, missing Street preference, or no
available base components means no bonus. This signal never penalizes routes or
allows invalid routes to pass validation. Totals can exceed 1 (no clamping).
The +0.05 coefficient is provisional, not empirically tuned for all providers.
A first-ranked Street preference can overcome base differences below 0.05;
partial-data comparisons may under-credit routes with unknown road categories.

Existing duration/environment/history weights remain 0.50/0.30/0.20, with
missing-component renormalization and deterministic ties unchanged. Street does
not become a POI category and is excluded from current and historical POI
environment formulas, avoiding double-counting history. No new AI planning,
waypoint optimization, or provider calls are introduced.

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

Cloud/provider and client tests include the observed 4 m / 8-step and
5 m / 10-step discrepancies, low 20% and 90% partial classification, unknown
types, malformed inputs and route-distance overcounts, directed route
aggregation, scoring, stale-state handling and no persistence. The observed
values do not prove 0.5 m/step rounding, and the implementation no longer
assumes any such provider rule.

Run `npm test -- --runInBand` (`npm.cmd` where appropriate). The
updated cloud + mini-program behavior still needs a coordinated development
deployment and a real questionnaire → candidate → ranking → Add/Replace/edit
E2E check. Verify snapshots/Walk data stay unchanged; avoid unauthorized
production deployment.

## Proposed Issue #84 description corrections (not applied remotely)

Replace the original AMap-specific `environmentStats` assumption with
Tencent walking-route `steps[].type` 0–3 and `distance` as the source. Missing
or malformed evidence is unknown. Only two ratios pass the cloud contract:
`coverageRatio` and `ordinaryRoadRatio`; raw steps and provider metadata
never enter public routes or persisted snapshots.

Acceptance criteria should state:

- Validate route/step distances and types; no invalid/overcounted raw route
  evidence is accepted, and unknown code/type distances earn no ordinary credit.
- Use distance-weighted, directed aggregation with unknown edges contributing
  zero classified meters. No minimum coverage gate or provider-rounding guess.
- Keep 50/30/20 base ranking and a positive-only Street bonus of
  `0.05 × currentRankStrength × coverageRatio × ordinaryRoadRatio` using
  strengths [1, 0.5, 0, 0], with the measured ratio and no extrapolation.
- Initial/progressive, Add/Replace, fallback and validated edits keep private
  runtime evidence without attaching it to persisted fields or snapshots.
- Live provider tests observed short step sums despite all returned types
  being classified. Final app ranking still requires a post-change E2E check.
