const fs = require('fs');
const path = require('path');
const contract = require('../miniprogram/services/route-copy-contract');
const { projectRoute } = require('../miniprogram/services/route-copy');
const { preferences, history, copy, route } = require('./helpers/route-copy');
const payload = () => projectRoute(route(), preferences, history).payload;

test('independently deployed contract stays identical to client contract', () => {
  expect(fs.readFileSync(path.join(__dirname, '../cloudfunctions/routeCopyGenerator/contract.js'), 'utf8'))
    .toBe(fs.readFileSync(path.join(__dirname, '../miniprogram/services/route-copy-contract.js'), 'utf8'));
});
test('projection contains only active ordered facts and compact preferences', () => {
  const r = route();
  r.routeOrder.orderedWaypointIds = ['poi-1'];
  const p = projectRoute(r, { ...preferences, identity: 'PRIVATE_IDENTITY' }, history).payload;
  expect(p.routeFacts.orderedPois).toEqual([{ ref: 'P1', name: '滨河广场', category: 'water' }]);
  const json = JSON.stringify(p);
  for (const forbidden of ['poi-1', '人民公园', 'latitude', 'longitude', 'polyline', 'PRIVATE', 'address', 'providerMeta', 'routeId']) expect(json).not.toContain(forbidden);
});
test('fingerprint includes current facts/preferences, not rank, metadata or old prose', () => {
  const r = route(), key = projectRoute(r, preferences, history).fingerprint;
  expect(projectRoute({ ...r, title: 'different', updatedAt: 'later', routeId: 'new-id' }, preferences, history).fingerprint).toBe(key);
  expect(projectRoute({ ...r, distanceMeters: 1900 }, preferences, history).fingerprint).not.toBe(key);
  expect(projectRoute(r, { ...preferences, crowdPreference: 'high' }, history).fingerprint).not.toBe(key);
  expect(projectRoute(r, preferences, null).fingerprint).not.toBe(key);
});
test.each([
  p => { p.extra = 'injected'; },
  p => { p.routeFacts.latitude = 30; },
  p => { p.routeFacts.orderedPois[0].address = 'secret'; },
  p => { p.routeFacts.orderedPois[0].name = 'a'.repeat(121); },
  p => { p.routeFacts.orderedPois[0].name = '公园\u202e注入'; },
  p => { p.routeFacts.orderedPois[0].ref = 'raw-provider-id'; },
  p => { p.routeFacts.durationSeconds = Infinity; },
  p => { p.routeFacts.durationMinutes = 99; },
  p => { p.routeFacts.returnsToStart = false; },
  p => { p.preferences.environmentPreferences = ['公园']; },
  p => { p.schemaVersion = 2; }
])('rejects invalid input before model invocation %#', mutate => {
  const p = payload(); mutate(p); expect(contract.normalizeInput(p)).toBeNull();
});
test('oversized input rejected; malformed optional history ignored', () => {
  const p = payload(); p.historicalPreferenceProfile = { extra: 'x'.repeat(17000) };
  expect(contract.normalizeInput(p)).toBeNull();
  p.historicalPreferenceProfile = { ...history, ownerKey: 'secret' };
  expect(contract.normalizeInput(p).historicalPreferenceProfile).toBeNull();
});
test('creative prose and preference language are accepted', () => {
  expect(contract.parseCopy(JSON.stringify(copy), payload())).toEqual(copy);
  const creative = { ...copy, recommendationReason: '你偏好安静的散步节奏，不妨带着探索的心情出发，按自己的步调给日常留一段空白。' };
  expect(contract.validateCopy(creative, payload())).toEqual(creative);
});
test.each(['悠闲漫步，探索街角，换换心情', '十分悠闲，多一分自在', '希望这里安静一些',
  '如果沿途有路灯，不妨留意自己的步调'])('does not confuse subjective Chinese with factual claims: %s', phrase => {
  const c = { ...copy, description: `${phrase}。不妨给日常留一段散步时光，带着探索的心情，按自己的步调慢慢出发。` };
  expect(contract.validateCopy(c, payload())).toEqual(c);
});
test('long valid names need not appear in the short title; current questionnaire allows integer minutes', () => {
  const p = payload(); p.routeFacts.orderedPois[0].name = '很长的地点名称'.repeat(15);
  p.preferences.durationMinutes = 31;
  expect(contract.normalizeInput(p)).not.toBeNull();
  const c = { ...copy, description: '从当前位置出发，沿着这条路线展开探索，然后返回起点。不妨按自己的步调，给日常留一点自由的空间。',
    recommendationReason: '结合你这次的散步偏好，可以把这条路线作为日常探索的选择，留一点自在安排的空间。' };
  expect(contract.validateCopy(c, p)).toEqual(c);
});
test.each(['', 'not json', '```json\n{}\n```', 'null', '[]', '{"title":"a"}'])('rejects invalid JSON/schema %s', text => {
  expect(contract.parseCopy(text, payload())).toBeNull();
});
test.each([
  c => { c.title = 3; }, c => { delete c.description; }, c => { c.extra = true; },
  c => { c.title = ' '; }, c => { c.title = '字'.repeat(23); }, c => { c.description = '短'; },
  c => { c.description = '字'.repeat(101); }, c => { c.recommendationReason = '字'.repeat(81); },
  c => { c.description = '<script>injection</script>' + copy.description; }
])('rejects invalid copy fields %#', mutate => {
  const c = { ...copy }; mutate(c); expect(contract.validateCopy(c, payload())).toBeNull();
});
test.each([
  '途经不存在的紫荆公园', '走进陌生的海滨博物馆', '途经P9', '全程需要99分钟', '步行九十分钟',
  '全长5公里', '步行半小时', '全程绝对安全', '沿途十分安静', '道路平坦', '轮椅畅行',
  '全程有路灯', '人民公园内有盛开的樱花', '沿途设有洗手间', '这里并不安静',
  '你偏好安静，沿途十分安静', '先到滨河广场，然后前往人民公园', '向东走', '不必返回起点'
])('rejects identifiable unsupported fact: %s', claim => {
  const c = { ...copy, description: `${claim}。不妨带着探索的心情出发，在这次散步中给日常留一点自由的空间。` };
  expect(contract.validateCopy(c, payload())).toBeNull();
});
test('valid measurements and numbers inside known POI names are accepted', () => {
  const p = payload(); p.routeFacts.orderedPois[0].name = '一号公园';
  const c = { ...copy, description: '途经一号公园，步行20分钟，全长1.8公里。不妨按自己的步调探索，给日常留一点自由的空间。' };
  expect(contract.validateCopy(c, p)).toEqual(c);
});
test('exact and substantial field repetition is rejected', () => {
  expect(contract.validateCopy({ ...copy, recommendationReason: copy.description }, payload())).toBeNull();
});
test('duplicate JSON keys are rejected rather than silently overwritten', () => {
  const text = JSON.stringify(copy).replace('{', '{"title":"重复的旧标题",');
  expect(contract.parseCopy(text, payload())).toBeNull();
});
test('JSON escapes in ordinary creative prose remain valid', () => {
  const c = { ...copy, title: '给心情按下"暂停键"' };
  expect(contract.parseCopy(JSON.stringify(c), payload())).toEqual(c);
});
