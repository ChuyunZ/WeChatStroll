const { addTencentSignature } = require('./signing')

test('signs raw sorted Tencent GET parameters without mutating input', () => {
  const options = { params: {
    key: 'test-key',
    boundary: 'nearby(30.123457,120.765432,1000,0)',
    filter: 'category=221100',
    orderby: '_distance',
    location_mode: 1,
    page_size: 6,
    page_index: 1
  } }
  const snapshot = JSON.stringify(options)

  expect(addTencentSignature(
    'https://apis.map.qq.com/ws/place/v1/explore',
    options,
    'secret-sk'
  )).toEqual({ params: {
    ...options.params,
    sig: '15206bddd52361d53a89200b49a4727e'
  } })

  expect(JSON.stringify(options)).toBe(snapshot)
  expect(options.params).not.toHaveProperty('sig')
})

test('uses the exact request pathname including a trailing slash', () => {
  expect(addTencentSignature(
    'https://apis.map.qq.com/ws/direction/v1/walking/',
    { params: {
      key: 'test-key',
      from: '31.123000,121.456000',
      to: '31.130000,121.470000'
    } },
    'secret-sk'
  ).params.sig).toBe('1552448f4fdb57e77e27c9fc8ea1914d')
})

test('replaces an existing sig but excludes it from the signature source', () => {
  const first = addTencentSignature(
    'https://apis.map.qq.com/ws/direction/v1/walking/',
    { params: { key: 'test-key', from: '31,121', to: '32,122' } },
    'secret-sk'
  )
  const second = addTencentSignature(
    'https://apis.map.qq.com/ws/direction/v1/walking/',
    { params: { ...first.params, sig: 'stale' } },
    'secret-sk'
  )
  expect(second.params.sig).toBe(first.params.sig)
})

test.each([
  [undefined, { key: 'test-key' }],
  ['', { key: 'test-key' }],
  ['secret-sk', []],
  ['secret-sk', { key: { nested: true } }],
  ['secret-sk', { key: Infinity }]
])('rejects invalid signing input without emitting a partial request (%p)', (secretKey, params) => {
  expect(() => addTencentSignature(
    'https://apis.map.qq.com/ws/place/v1/explore',
    { params },
    secretKey
  )).toThrow()
})
