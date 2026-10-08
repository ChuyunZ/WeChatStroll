// Internal runtime sidecar. Never attach evidence to serializable route objects.
const evidenceByObject = new WeakMap()
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1

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
      ordinaryRoadRatio: evidence.ordinaryRoadRatio
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
  for (const segment of segments) {
    if (!Number.isFinite(segment.distanceMeters) || segment.distanceMeters < 0) return null
    total += segment.distanceMeters
    const evidence = getStreetEvidence(segment)
    if (evidence) {
      const covered = segment.distanceMeters * evidence.coverageRatio
      classified += covered
      ordinary += covered * evidence.ordinaryRoadRatio
    }
  }
  if (!Number.isFinite(total) || total <= 0 || classified <= 0 || classified > total) return null
  return { coverageRatio: classified / total, ordinaryRoadRatio: ordinary / classified }
}

module.exports = { rememberStreetEvidence, getStreetEvidence, transferStreetEvidence, aggregateStreetEvidence }
