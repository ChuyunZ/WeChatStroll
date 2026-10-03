const { createNearbyHandler } = require('./nearby-pois')
const input = { latitude: 30.12345678, longitude: 120.76543219 }
const rawPoi = { id: 'poi-1', title: 'Park', location: { lat: 30.1, lng: 120.7 },
  _distance: 123, address: 'Address', category: 'raw-category', ad_info: { city: 'private' },
  request_id: 'private-id', providerMeta: { raw: true } }
let request
let handler
beforeEach(() => {
  request = jest.fn().mockResolvedValue({ data: { status: 0, data: [rawPoi], request_id: 'private-id' } })
  handler = createNearbyHandler({ apiKey: 'secret-key', request })
})

test('missing key fails before requesting', async () => {
  expect(await createNearbyHandler({ request })(input)).toMatchObject({ error: { code: 'CONFIG_MISSING' } })
  expect(request).not.toHaveBeenCalled()
})

test.each([undefined, {}, { latitude: 30 }, { longitude: 120 },
  { ...input, latitude: '30' }, { ...input, longitude: NaN }, { ...input, latitude: Infinity },
  { ...input, latitude: 91 }, { ...input, latitude: -91 },
  { ...input, longitude: 181 }, { ...input, longitude: -181 }])('rejects invalid coordinates %p', async event => {
  expect(await handler(event)).toMatchObject({ error: { code: 'INVALID_COORDINATES' } })
  expect(request).not.toHaveBeenCalled()
})

test.each([
  [undefined, 1000], [null, 1000], ['15000', 1000], [NaN, 1000],
  [-100, 200], [1, 200], [563, 563], [937.5, 938], [1000, 1000], [5000, 1000]
])('clamps caller radius %p to provider-safe %i meters', async (radius, expectedRadius) => {
  await handler({ ...input, radius })
  expect(request.mock.calls).toEqual(['221100', '261312,261313,261314,222200', '132600'].map(codes => [
    'https://apis.map.qq.com/ws/place/v1/explore', { params: {
      key: 'secret-key', boundary: `nearby(30.123457,120.765432,${expectedRadius},0)`,
      filter: `category=${codes}`, orderby: '_distance', location_mode: 1, page_size: 6, page_index: 1
    } }
  ]))
})

test('normalizes a strict field allowlist and retains application categories only', async () => {
  expect(await handler(input)).toEqual({ success: true, poisByCategory: Object.fromEntries(
    ['park', 'water', 'shoppingStreet'].map(category => [category, [{
      poiId: 'poi-1', name: 'Park', category, latitude: 30.1, longitude: 120.7,
      distanceInMeters: 123, address: 'Address'
    }]])
  ) })
})

test('filters malformed entries without losing valid POIs', async () => {
  const invalid = [null, {}, { ...rawPoi, id: 123 }, { ...rawPoi, id: ' ' },
    { ...rawPoi, title: '' }, { ...rawPoi, title: 1 }, { ...rawPoi, location: null },
    ...[{ lat: 91, lng: 120 }, { lat: 30, lng: -181 }, { lat: NaN, lng: 120 },
      { lat: 30, lng: Infinity }, { lat: '30', lng: 120 }].map(location => ({ ...rawPoi, location }))]
  request.mockResolvedValue({ data: { status: 0, data: [...invalid, rawPoi] } })
  const result = await handler(input)
  expect(result.success).toBe(true)
  expect(Object.values(result.poisByCategory).map(pois => pois.length)).toEqual([1, 1, 1])
})

test.each([undefined, null, -1, NaN, Infinity, '123', {}])('invalid distance %p becomes null and non-string address is omitted', async distance => {
  request.mockResolvedValue({ data: { status: 0, data: [{ ...rawPoi, _distance: distance, address: [] }] } })
  const result = await handler(input)
  expect(result.poisByCategory.park[0].distanceInMeters).toBeNull()
  expect(result.poisByCategory.park[0]).not.toHaveProperty('address')
})

test.each([0, 0.5])('preserves finite nonnegative distance %p', async distance => {
  request.mockResolvedValue({ data: { status: 0, data: [{ ...rawPoi, _distance: distance }] } })
  expect((await handler(input)).poisByCategory.park[0].distanceInMeters).toBe(distance)
})

test.each([347, 387, 393])('status %i is an empty category and later categories still run', async status => {
  request.mockResolvedValueOnce({ data: { status, message: 'private' } })
  const result = await handler(input)
  expect(result.success).toBe(true)
  expect(result.poisByCategory.park).toEqual([])
  expect(result.poisByCategory.water).toHaveLength(1)
  expect(result.poisByCategory.shoppingStreet).toHaveLength(1)
  expect(request).toHaveBeenCalledTimes(3)
})

test.each([{ status: 0, data: [] }, { status: 347 }, { status: 387 }, { status: 393 }])('empty results preserve all category keys: %p', async data => {
  request.mockResolvedValue({ data })
  expect(await handler(input)).toEqual({ success: true, poisByCategory: { park: [], water: [], shoppingStreet: [] } })
})

test.each([null, {}, { status: '0', data: [] }, { status: 0, data: {} },
  { status: 110, message: 'secret-key private payload' }])('malformed or failed response %p stops subsequent categories safely', async data => {
  request.mockResolvedValueOnce({ data })
  expect(await handler(input)).toEqual({ success: false, error: {
    code: 'POI_SEARCH_FAILED', message: 'Unable to retrieve nearby places'
  } })
  expect(request).toHaveBeenCalledTimes(1)
})

test('categories are awaited sequentially and a later transport failure discards partial results', async () => {
  let finish
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockRejectedValueOnce(new Error('secret-key private payload'))
  const pending = handler(input)
  expect(request).toHaveBeenCalledTimes(1)
  finish({ data: { status: 0, data: [rawPoi] } })
  expect(await pending).toEqual({ success: false, error: {
    code: 'POI_SEARCH_FAILED', message: 'Unable to retrieve nearby places'
  } })
  expect(request).toHaveBeenCalledTimes(2)
})
