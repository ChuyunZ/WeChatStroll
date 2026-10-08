const { createWalkingHandler } = require('./walking')
const input = { start: { latitude: 31.1230004, longitude: 121.4560004 },
  destination: { latitude: 31.13, longitude: 121.47 } }
const validRoute = () => ({ distance: 1250.5, duration: 12.5,
  polyline: [31.123, 121.456, 7000, 14000, -1000, -2000],
  steps: [{ type: 1, road_class: 2, road_name: 'private road', direction: 'north' }],
  providerMeta: { secret: true }, environmentStats: { normalRoadRatio: 1 }, request_id: 'private-id' })
let request
let handler

test.each([
  ['complete', [{ type: 0, distance: 750 }, { type: 1, distance: 250 }], 1000, { coverageRatio: 1, ordinaryRoadRatio: 0.75 }],
  ['known non-road', [{ type: 2, distance: 500 }, { type: 3, distance: 500 }], 1000, { coverageRatio: 1, ordinaryRoadRatio: 0 }],
  ['partial list', [{ type: 0, distance: 250 }], 1000, { coverageRatio: 0.25, ordinaryRoadRatio: 1 }],
  ['partial types', [{ type: 0, distance: 250 }, { distance: 750 }], 1000, { coverageRatio: 0.25, ordinaryRoadRatio: 1 }],
  ['unknown type', [{ type: 99, distance: 1000 }], 1000, null],
  ['string type', [{ type: '0', distance: 1000 }], 1000, null],
  ['missing', undefined, 1000, null],
  ['empty', [], 1000, null],
  ['malformed', {}, 1000, null],
  ['overcount', [{ type: 0, distance: 1001 }], 1000, null],
  ['overflowing total', [{ type: 0, distance: 1e308 }, { type: 0, distance: 1e308 }], 1e308, null],
  ['zero route', [{ type: 0, distance: 0 }], 0, null],
  ['zero step', [{ type: 0, distance: 0 }], 1000, null],
  ...[undefined, null, -1, NaN, Infinity, '1000', {}, true].map(distance =>
    ['invalid distance', [{ type: 0, distance }], 1000, null]),
  ['null step', [null], 1000, null],
  ['array step', [[]], 1000, null]
])('Street evidence: %s retains only the normalized optional capability', async (_, steps, distance, expected) => {
  request.mockResolvedValue({ data: { status: 0, result: { routes: [{ ...validRoute(), steps, distance,
    streetEvidence: { coverageRatio: 1, ordinaryRoadRatio: 1 } }] } } })
  const result = await handler(input)
  expect(result.success).toBe(true)
  expect(result.route.streetEvidence || null).toEqual(expected)
  expect(Object.keys(result.route).sort()).toEqual([
    'distanceMeters', 'durationSeconds', 'polyline', ...(expected ? ['streetEvidence'] : [])
  ].sort())
  expect(JSON.stringify(result)).not.toMatch(/steps|road_class|road_name|environmentStats|private/)
  expect(request).toHaveBeenCalledTimes(1)
})
beforeEach(() => {
  request = jest.fn().mockResolvedValue({ data: { status: 0, result: { routes: [validRoute()] } } })
  handler = createWalkingHandler({ apiKey: 'private-key', request })
})

test('requests only key/from/to with six-decimal latitude,longitude and normalizes the first route', async () => {
  const route = validRoute()
  const raw = [...route.polyline]
  Object.freeze(route.polyline)
  request.mockResolvedValue({ data: { status: 0, request_id: 'private-id', result: { routes: [route, null] } } })
  const result = await handler(input)
  expect(request).toHaveBeenCalledWith('https://apis.map.qq.com/ws/direction/v1/walking/', { params: {
    key: 'private-key', from: '31.123000,121.456000', to: '31.130000,121.470000'
  } })
  expect(result).toEqual({ success: true, route: {
    distanceMeters: 1250.5, durationSeconds: 750,
    polyline: [
      { latitude: expect.closeTo(31.123, 8), longitude: expect.closeTo(121.456, 8) },
      { latitude: expect.closeTo(31.13, 8), longitude: expect.closeTo(121.47, 8) },
      { latitude: expect.closeTo(31.129, 8), longitude: expect.closeTo(121.468, 8) }
    ]
  } })
  expect(route.polyline).toEqual(raw)
  expect(JSON.stringify(result)).not.toMatch(/durationMinutes|environmentStats|providerMeta|steps|road_class|request_id|private/)
})

test('missing key fails before HTTP', async () => {
  expect(await createWalkingHandler({ request })(input)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  expect(request).not.toHaveBeenCalled()
})

test.each(['start', 'destination'])('invalid or missing %s never calls HTTP', async field => {
  for (const point of [undefined, null, [], 'point', {}, { latitude: 0 },
    { latitude: '30', longitude: 120 }, { latitude: 30, longitude: '120' },
    { latitude: NaN, longitude: 120 }, { latitude: 30, longitude: Infinity },
    { latitude: 91, longitude: 120 }, { latitude: -91, longitude: 120 },
    { latitude: 30, longitude: 181 }, { latitude: 30, longitude: -181 }]) {
    expect(await handler({ ...input, [field]: point })).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  }
  expect(await handler()).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  expect(request).not.toHaveBeenCalled()
})

test.each([undefined, null, {}, [], [30, 120], [30, 120, 1], [30, 120, 1, 2, 3],
  [30, 120, NaN, 0], [30, 120, 0, Infinity], [30, 120, '1', 0], [30, 120, null, 0],
  [NaN, 120, 0, 0], [30, '120', 0, 0], [91, 120, 0, 0], [30, -181, 0, 0],
  [90, 180, 1, 0], [-90, -180, 0, -1], [30, 120, 0, 0, 100000000, 0], new Array(4)
])('rejects malformed compressed polyline %p', async polyline => {
  request.mockResolvedValue({ data: { status: 0, result: { routes: [{ ...validRoute(), polyline }] } } })
  expect(await handler(input)).toMatchObject({ error: { code: 'PROVIDER_GATEWAY_FAILED' } })
})

test.each([{ status: 378 }, { status: 0, result: { routes: [] } }])('no route %p does not fabricate geometry', async data => {
  request.mockResolvedValue({ data })
  expect(await handler(input)).toEqual({ success: false, error: {
    code: 'ROUTE_NOT_FOUND', message: 'No walking route was found'
  } })
})

test.each([{ status: 0 }, { status: 0, result: null }, { status: 0, result: {} },
  ...[null, {}, 'routes'].map(routes => ({ status: 0, result: { routes } })),
  ...[null, [], 'route', {}].map(route => ({ status: 0, result: { routes: [route, validRoute()] } }))
])('rejects malformed claimed success %p', async data => {
  request.mockResolvedValue({ data })
  expect(await handler(input)).toMatchObject({ error: { code: 'PROVIDER_GATEWAY_FAILED' } })
})

test.each(['distance', 'duration'])('rejects invalid %s without coercion or defaults', async field => {
  for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, '10', {}, true]) {
    request.mockResolvedValue({ data: { status: 0, result: { routes: [{ ...validRoute(), [field]: value }] } } })
    expect(await handler(input)).toMatchObject({ error: { code: 'PROVIDER_GATEWAY_FAILED' } })
  }
})

test('rejects duration conversion overflow but accepts explicit zero route facts', async () => {
  request.mockResolvedValueOnce({ data: { status: 0, result: { routes: [{ ...validRoute(), duration: Number.MAX_VALUE }] } } })
  expect(await handler(input)).toMatchObject({ error: { code: 'PROVIDER_GATEWAY_FAILED' } })
  request.mockResolvedValueOnce({ data: { status: 0, result: { routes: [{ ...validRoute(), distance: 0, duration: 0 }] } } })
  expect(await handler(input)).toMatchObject({ success: true, route: { distanceMeters: 0, durationSeconds: 0 } })
})

test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_BUSY', 'PROVIDER_GATEWAY_FAILED'])('preserves normalized %s without leaking error details', async code => {
  request.mockRejectedValue({ code, message: 'private-key payload 31.123000', response: validRoute() })
  expect(await handler(input)).toEqual({ success: false, error: { code, message: 'Unable to generate walking route' } })
})

test.each([null, {}, { status: '0' }, { status: 110, message: 'private-key' }, { status: 999 }])('other invalid/business responses %p are safe gateway failures', async data => {
  request.mockResolvedValue({ data })
  expect(await handler(input)).toEqual({ success: false, error: {
    code: 'PROVIDER_GATEWAY_FAILED', message: 'Unable to generate walking route'
  } })
})

test('adapter emits no raw payload, key or coordinate logs on failures', async () => {
  const spies = ['log', 'info', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}))
  try {
    request.mockRejectedValueOnce(new Error('private-key 31.123000 raw payload'))
    expect(await handler(input)).toMatchObject({ error: { code: 'PROVIDER_GATEWAY_FAILED' } })
    request.mockResolvedValueOnce({ data: { status: 0, result: { routes: [{ ...validRoute(), polyline: [] }] } } })
    await handler(input)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally { spies.forEach(spy => spy.mockRestore()) }
})


test('temporary PR #105 Street diagnostics are opt-in, aggregate-only and preserve the normal route contract', async () => {
  const providerRoute = {
    ...validRoute(), distance: 1213,
    steps: [
      { type: 0, distance: 600, road_name: 'private road' },
      { type: 1, distance: 609, road_class: 2 }
    ]
  }
  request.mockResolvedValue({ data: { status: 0, result: { routes: [providerRoute] } } })
  const normal = await handler(input)
  const wrongFlagType = await handler({ ...input, __streetCoverageDiagnostic: 1 })
  const diagnostic = await handler({ ...input, __streetCoverageDiagnostic: true })

  expect(normal.streetCoverageDiagnostic).toBeUndefined()
  expect(wrongFlagType.streetCoverageDiagnostic).toBeUndefined()
  expect(diagnostic.route).toEqual(normal.route)
  expect(diagnostic.streetCoverageDiagnostic).toEqual({
    routeDistanceMeters: 1213,
    stepDistanceMeters: 1209,
    classifiedDistanceMeters: 1209,
    unclassifiedTypeDistanceMeters: 0,
    routeMinusStepsMeters: 4,
    stepsPresent: true,
    stepCount: 2,
    classifiedStepCount: 2,
    missingTypeStepCount: 0,
    unknownTypeStepCount: 0,
    invalidDistanceStepCount: 0
  })
  expect(JSON.stringify(diagnostic.streetCoverageDiagnostic))
    .not.toMatch(/road_name|road_class|private|request_id|polyline|latitude|longitude|providerMeta|"steps":/)
  expect(request).toHaveBeenCalledTimes(3)
})

test('temporary diagnostics distinguish missing classifications from route-step distance gaps', async () => {
  request.mockResolvedValueOnce({ data: { status: 0, result: { routes: [{
    ...validRoute(), distance: 1213,
    steps: [{ type: 0, distance: 1209 }, { distance: 4 }]
  }] } } })
  const result = await handler({ ...input, __streetCoverageDiagnostic: true })
  expect(result.route.streetEvidence).toEqual({
    coverageRatio: 1209 / 1213, ordinaryRoadRatio: 1
  })
  expect(result.streetCoverageDiagnostic).toMatchObject({
    routeDistanceMeters: 1213,
    stepDistanceMeters: 1213,
    classifiedDistanceMeters: 1209,
    unclassifiedTypeDistanceMeters: 4,
    routeMinusStepsMeters: 0,
    missingTypeStepCount: 1,
    unknownTypeStepCount: 0,
    invalidDistanceStepCount: 0
  })
  request.mockResolvedValueOnce({ data: { status: 0, result: { routes: [{
    ...validRoute(), distance: 1213,
    steps: [{ type: 0, distance: 1209 }, { type: 0, distance: -4 }]
  }] } } })
  const malformed = await handler({ ...input, __streetCoverageDiagnostic: true })
  expect(malformed.success).toBe(true)
  expect(malformed.route.streetEvidence).toBeUndefined()
  expect(malformed.streetCoverageDiagnostic).toMatchObject({
    stepDistanceMeters: 1209, invalidDistanceStepCount: 1, routeMinusStepsMeters: 4
  })
})
