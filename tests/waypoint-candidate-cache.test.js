const {
  createWaypointCandidateCache
} = require(
  '../miniprogram/services/waypoint-candidate-cache'
)

const CANDIDATES = [
  {
    waypoints: [
      { poiId: 'poi-1' },
      { poiId: 'poi-2' }
    ]
  },
  {
    waypoints: [
      { poiId: 'poi-3' }
    ]
  }
]

describe('waypoint candidate cache', () => {
  test('initializes candidates as unused', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    expect(
      cache.getAllCandidates()
    ).toEqual([
      {
        candidateId: 'candidate-1',
        waypointIds: [
          'poi-1',
          'poi-2'
        ],
        status: 'unused',
        route: null
      },
      {
        candidateId: 'candidate-2',
        waypointIds: [
          'poi-3'
        ],
        status: 'unused',
        route: null
      }
    ])

    expect(
      cache.getUnusedCandidates()
    ).toHaveLength(2)
  })

  test('marks a candidate as building', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    expect(
      cache.markBuilding(
        'candidate-1'
      )
    ).toBe(true)

    expect(
      cache.getAllCandidates()[0]
        .status
    ).toBe('building')

    expect(
      cache.getUnusedCandidates()
        .map(
          candidate =>
            candidate.candidateId
        )
    ).toEqual([
      'candidate-2'
    ])
  })

  test('marks a candidate as successful and returns its route', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    const route = {
      routeId: 'route-1'
    }

    expect(
      cache.markSuccess(
        'candidate-1',
        route
      )
    ).toBe(true)

    expect(
      cache.getAllCandidates()[0]
    ).toEqual({
      candidateId: 'candidate-1',
      waypointIds: [
        'poi-1',
        'poi-2'
      ],
      status: 'success',
      route
    })

    expect(
      cache.getSuccessfulRoutes()
    ).toEqual([
      route
    ])
  })

  test('marks a candidate as failed and clears its route', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    const route = {
      routeId: 'route-1'
    }

    cache.markSuccess(
      'candidate-1',
      route
    )

    expect(
      cache.markFailed(
        'candidate-1'
      )
    ).toBe(true)

    expect(
      cache.getAllCandidates()[0]
    ).toEqual({
      candidateId: 'candidate-1',
      waypointIds: [
        'poi-1',
        'poi-2'
      ],
      status: 'failed',
      route: null
    })

    expect(
      cache.getSuccessfulRoutes()
    ).toEqual([])
  })

  test('returns false when updating an unknown candidate', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    expect(
      cache.markBuilding(
        'missing-candidate'
      )
    ).toBe(false)

    expect(
      cache.markSuccess(
        'missing-candidate',
        { routeId: 'route-1' }
      )
    ).toBe(false)

    expect(
      cache.markFailed(
        'missing-candidate'
      )
    ).toBe(false)
  })

  test('returns defensive copies of waypoint IDs', () => {
    const cache =
      createWaypointCandidateCache(
        CANDIDATES
      )

    const firstRead =
      cache.getAllCandidates()

    firstRead[0]
      .waypointIds
      .push('mutated-poi')

    firstRead[0].status =
      'failed'

    const secondRead =
      cache.getAllCandidates()

    expect(
      secondRead[0]
        .waypointIds
    ).toEqual([
      'poi-1',
      'poi-2'
    ])

    expect(
      secondRead[0]
        .status
    ).toBe('unused')
  })
})
