# Street preference ranking (#84)

Street represents **ordinary-road walking exposure identified by the provider's
walking-step classification**, not a claim about ordinary *urban* roads or
scenic street quality. It is a route characteristic, not a POI category.
Park or Water POIs can coexist with Street exposure. It makes no claim about
scenery, architecture, safety, quietness, comfort or neighborhood attractiveness.

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
including numeric strings. Do not parse instructions/road names or use geometry
as substitute evidence.

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
The feature-branch `mapProvider` and matching Mini Program client were deployed/
compiled for authorized **development** E2E. This is not a production rollout;
future releases must coordinate compatible cloud/client versions. An older cloud
response simply supplies unknown.

## Verification and remaining checks

The automated suite covers observed 4 m / 8-step and 5 m / 10-step discrepancies,
20% and 90% partial classification, unknown walking types, malformed inputs and
step-distance overcounts, directed distance-weighted aggregation, deterministic
ranking, lifecycle/stale-state handling and serialization. The observed gaps
do **not** establish a 0.5 m/step rounding rule; none is used.
GitHub Actions passed **71 suites / 1484 tests** on `679ccebd` and the same
branch passed the user's local full Jest suite.

**Authorized development E2E (2026-10-09 local / 2026-10-08 UTC):**

1. The deployed CloudBase `walkingRoute` returned normalized
   `streetEvidence: { coverageRatio: 0.9967023907666942,
   ordinaryRoadRatio: 1 }` for the known 1213 m route. No temporary
   `streetCoverageDiagnostic` or `classificationComplete` field appeared.
2. In the WeChat Developer Tools simulator, a 30-minute questionnaire with
   Street ranked first generated a usable ~24-minute route. Runtime ranking
   inspection showed `coverageRatio ≈ 0.99682741`,
   `ordinaryRoadRatio = 1`, `streetBonus ≈ 0.04984137`,
   `baseScore = 0.7904`. This verifies the real provider → cloud normalization
   → client WeakMap → deterministic scoring integration.
3. An original real route ranked before a JSON-cloned copy without evidence
   regardless of their input order, without modifying displayed routes.
   **This is not a two-independent-live-routes UI ordering test.**
4. The Route object and UI projection contained no Street/raw-provider fields.
   A real non-GPS test Walk stored an `activeWalkSession` snapshot with no
   prohibited evidence, transitioned successfully to `ended_early` and
   produced a clean `pendingWalkResult` snapshot. Skipping feedback cleared
   both local storage keys. The cloud Walk record remains by normal design.

**Still unverified:** two independently generated real routes compared in the
UI; successful Add/Replace and a live confirmed-edit rerank with this evidence.
During E2E, manual Add returned three duration-invalid candidates in its first
round, then two empty candidate batches. At least one cloud log confirmed
`candidates: []` was emitted by AI. This is tracked in **#91** and must not
be “fixed” by weakening final route validation or changing this Street bonus.

**Data policy:** the checks above prove field exclusion in the tested runtime
and local snapshots, **not** Tencent authorization to persist planned routes or
process provider data through AI. Production permission, provider deployments
and real-device behavior remain separate release checks.

## Issue tracking

Issue [#84](https://github.com/ChuyunZ/WeChatStroll/issues/84) now contains
the current Tencent source/semantics, conservative partial-credit formula,
acceptance criteria and bounded E2E record; the former AMap-era description
and speculative coverage gate have been superseded.
