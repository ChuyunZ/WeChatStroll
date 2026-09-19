// Create a cache for candidate waypoints
function createWaypointCandidateCache(
  candidates = []
) {
  const entries =
    Array.isArray(candidates)
      ? candidates.map(
          (candidate, index) => ({
            candidateId:
              `candidate-${index + 1}`,

            waypointIds:
              candidate.waypoints.map(
                waypoint =>
                  waypoint.poiId
              ),

            status: 'unused',

            route: null
          })
        )
      : []

  // 在 entries 这个 cache array 里，找到指定 candidateId 对应的那一条记录
  function findEntry(candidateId) {
    return entries.find(
      entry =>
        entry.candidateId ===
        candidateId
    )
  }

  function getAllCandidates() {
    return entries.map(entry => ({
      ...entry,
      waypointIds: [
        ...entry.waypointIds
      ]
    }))
  }

  function getUnusedCandidates() {
    return getAllCandidates().filter(
      entry =>
        entry.status === 'unused'
    )
  }

  function markBuilding(candidateId) {
    const entry =
      findEntry(candidateId)

    if (!entry) {
      return false
    }

    entry.status = 'building'

    return true
  }

  function markSuccess(
    candidateId,
    route
  ) {
    const entry =
      findEntry(candidateId)

    if (!entry) {
      return false
    }

    entry.status = 'success'
    entry.route = route

    return true
  }

  function markFailed(candidateId) {
    const entry =
      findEntry(candidateId)

    if (!entry) {
      return false
    }

    entry.status = 'failed'
    entry.route = null

    return true
  }

  function getSuccessfulRoutes() {
    return entries
      .filter(
        entry =>
          entry.status === 'success'
      )
      .map(
        entry =>
          entry.route
      )
  }

  return {
    getAllCandidates,
    getUnusedCandidates,
    markBuilding,
    markSuccess,
    markFailed,
    getSuccessfulRoutes
  }
}

module.exports = {
  createWaypointCandidateCache
}