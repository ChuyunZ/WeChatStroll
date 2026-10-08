// Internal runtime sidecar. Never attach evidence to serializable route objects.
const evidenceByObject = new WeakMap()
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1
// Independent guard against accepting an arbitrarily low coverage value with
// a forged/malformed completion flag. The cloud additionally enforces step counts.
const MIN_TOLERATED_COVERAGE = 0.995

function fingerprint(route) {
  return JSON.stringify([route.distanceMeters, route.durationSeconds, route.polyline,
    route.routeType, route.routeOrder, route.startPoint, route.endPoint,
    route.pointsOfInterest, route.waypoints])
}

function rememberStreetEvidence(target, evidence) {
  evidenceByObject.delete(target)
  if (evidence && !Array.isArray(evidence) && unit(evidence.coverageRatio) &&
      evidence.coverageRatio > 0 && unit(evidence.ordinaryRoadRatio) &&
      Number.isFinite(target.distanceMeters) && target.distanceMeters > 0) {
    evidenceByObject.set(target, { fingerprint: fingerprint(target), evidence: Object.freeze({
      coverageRatio: evidence.coverageRatio,
      ordinaryRoadRatio: evidence.ordinaryRoadRatio,
      ...(evidence.classificationComplete === true &&
        evidence.coverageRatio >= MIN_TOLERATED_COVERAGE && evidence.coverageRatio < 1
        ? { classificationComplete: true } : {})
    }) })
  }
  return target
}

function getStreetEvidence(target) {
  const entry = evidenceByObject.get(target)
  return entry && entry.fingerprint === fingerprint(target) ? entry.evidence : null
}

function transferStreetEvidence(source, target) {
  return rememberStreetEvidence(target, getStreetEvidence(source))
}

function aggregateStreetEvidence(segments) {
  let total = 0
  let classified = 0
  let ordinary = 0
  let everyPositiveSegmentComplete = true
  for (const segment of segments) {
    if (!Number.isFinite(segment.distanceMeters) || segment.distanceMeters < 0) return null
    total += segment.distanceMeters
    const evidence = getStreetEvidence(segment)
    if (segment.distanceMeters > 0 && (!evidence ||
        (evidence.coverageRatio !== 1 && evidence.classificationComplete !== true))) {
      everyPositiveSegmentComplete = false
    }
    if (evidence) {
      const covered = segment.distanceMeters * evidence.coverageRatio
      classified += covered
      ordinary += covered * evidence.ordinaryRoadRatio
    }
  }
  if (!Number.isFinite(total) || total <= 0 || classified <= 0 || classified > total) return null
  const coverageRatio = classified / total
  return {
    coverageRatio,
    ordinaryRoadRatio: ordinary / classified,
    ...(everyPositiveSegmentComplete && coverageRatio >= MIN_TOLERATED_COVERAGE &&
      coverageRatio < 1 ? { classificationComplete: true } : {})
  }
}

module.exports = { rememberStreetEvidence, getStreetEvidence, transferStreetEvidence, aggregateStreetEvidence }
