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

test.each([
  '你喜欢公园而且沿途有路灯',
  '你希望环境安静，但这条路线绝对安全',
  '你喜欢热闹，所以沿途有洗手间',
  '希望沿途有路灯，并且全程安全',
  '你期待自然风光，同时这里有湖景',
  '一路经过东方明珠塔',
  '途经虚构古镇',
  '走进不存在的纪念馆'
])('does not excuse unsupported claims or invented landmarks: %s', claim => {
  const c = { ...copy, description: `${claim}。不妨带着探索的心情出发，在这次散步中给日常留一点自由的空间。` };
  expect(contract.validateCopy(c, payload())).toBeNull();
});
test.each([
  '如果沿途有路灯，不妨留意周围环境',
  '希望沿途有路灯',
  '你喜欢安静的氛围，可以按自己的步调散步'
])('accepts genuine preference and hypothetical language: %s', phrase => {
  const c = { ...copy, description: `${phrase}。不妨给日常留一段散步时光，带着探索的心情，按自己的步调慢慢出发。` };
  expect(contract.validateCopy(c, payload())).toEqual(c);
});

test.each([
  '从人民公园出发，慢慢走向下个地点',
  '由滨河广场出发，悠闲散步',
  '从人民公园附近启程，放慢脚步',
  '以人民公园为起点，探索周围',
  '起点位于人民公园，可以悠闲散步',
  '沿着园里的小径慢慢走',
  '沿着人民公园的步道慢慢走',
  '走进人民公园，享受一段悠闲的时光',
  '穿过滨河广场，继续悠闲散步',
  '园中的安静角落等你探索',
  '在园内散步，放慢脚步'
])('rejects ungrounded POI-as-origin or inferred venue interior: %s', claim => {
  const c = { ...copy, description: `${claim}。不妨带着探索的心情出发，在这次散步中给日常留一点自由的空间。` };
  expect(contract.validateCopy(c, payload())).toBeNull();
});
test.each([
  '从当前位置出发，途经人民公园',
  '沿着这条路线慢慢走，途经人民公园',
  '先到人民公园，然后再到滨河广场',
  '去人民公园走走，给自己留一段悠闲时光'
])('still accepts grounded visits and generic creative narration: %s', phrase => {
  const c = { ...copy, description: `${phrase}。不妨给日常留一段散步时光，带着探索的心情，按自己的步调慢慢出发。` };
  expect(contract.validateCopy(c, payload())).toEqual(c);
});
test('Detail marks both AI-generated description and recommendation, without a repeated disclaimer', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/route-detail/route-detail.wxml'), 'utf8');
  const intro = wxml.split('<!-- Recommendation -->')[0].split('<!-- Description -->')[1];
  const reason = wxml.split('<!-- Recommendation -->')[1].split('<!-- Actions -->')[0];
  const badge = `<text class="ai-copy-label" wx:if="{{route.copySource === 'ai'}}">AI 生成 · 仅供参考</text>`;
  expect(intro).toContain(badge);
  expect(reason).toContain(badge);
  expect(reason).toContain('{{route.recommendationReason}}');
  expect(intro).toContain('AI 生成内容可能存在不准确之处');
  expect(reason).not.toContain('ai-copy-disclaimer');
});

test.each([
  ['不是JSON', 'INVALID_JSON'],
  ['{}', 'INVALID_JSON_TOKENS'],
  [JSON.stringify({ ...copy, title: '太短' }), 'INVALID_LENGTH'],
  [JSON.stringify({ ...copy, description: '从人民公园出发，沿着园里的小径慢慢走。'.repeat(2) }), 'INVALID_ORIGIN_OR_INTERIOR'],
  [JSON.stringify({ ...copy, description: '沿途有路灯。'.repeat(6) }), 'UNSUPPORTED_FACT'],
  [JSON.stringify({ ...copy, description: '步行99分钟，给自己留些闲暇。'.repeat(2) }), 'WRONG_MEASUREMENT']
])('detailed parsing explains rejection without changing fallback contract: %s', (raw, reason) => {
  const detailed = contract.parseCopyDetailed(raw, payload());
  expect(detailed).toMatchObject({ copy: null, reason });
  expect(contract.parseCopy(raw, payload())).toBeNull();
});
test('detailed validation also preserves accepted copy unchanged', () => {
  expect(contract.validateCopyDetailed(copy, payload())).toEqual({ copy, reason: null, field: null });
  expect(contract.parseCopyDetailed(JSON.stringify(copy), payload())).toEqual({ copy, reason: null, field: null });
});

test.each([
  '想轻松散个步时，这条途经商街再到公园外的路线挺合适，中途可自主探索，到了尽头处静静待一会儿，挺治愈。',
  '从起点出发，途经商街再到公园外的路线，不必赶时间。',
  '途经商街，然后去公园外走走，按自己的节奏散步。',
  '沿途可以自由探索，经过商街与公园周边的路线。',
  '途经公园外的路线，随心看看街景，放慢脚步。'
])('does not mistake generic places or the word 路线 for invented named POIs: %s', phrase => {
  const c = { ...copy, recommendationReason: phrase.slice(0, 80) };
  expect(contract.validateCopyDetailed(c, payload()).reason).not.toBe('INVALID_POI');
});
test.each([
  '途经不存在的紫荆公园',
  '走进陌生的海滨博物馆',
  '一路经过东方明珠塔',
  '前往虚构的海滨大道',
  '经过陌生的小龙桥'
])('continues rejecting recognisable invented named places: %s', phrase => {
  const c = { ...copy, description: `${phrase}。不妨带着探索的心情出发，在这次散步中给日常留一点自由的空间。` };
  expect(contract.validateCopyDetailed(c, payload()).reason).toBe('INVALID_POI');
});

test.each([
  { name: 'Chinese half hour rounded from 29m16s', seconds: 1756, expectedMinutes: 30,
    requestedMinutes: 15, title: '半小时放松心情慢慢走', accepted: true },
  { name: 'decimal half hour rounded from 29m16s', seconds: 1756, expectedMinutes: 30,
    requestedMinutes: 15, title: '0.5小时放松心情慢慢走', accepted: true },
  { name: 'one hour rounded from 59m59s', seconds: 3599, expectedMinutes: 60,
    requestedMinutes: 30, title: '一小时放松心情慢慢走', accepted: true },
  { name: 'one and a half hours rounded from 89m59s', seconds: 5399, expectedMinutes: 90,
    requestedMinutes: 45, title: '1.5小时放松心情慢慢走', accepted: true },
  { name: 'mismatched full hour against a 30-minute route', seconds: 1756, expectedMinutes: 30,
    requestedMinutes: 15, title: '一小时放松心情慢慢走', accepted: false },
  { name: 'mismatched half hour against a 31-minute route', seconds: 1801, expectedMinutes: 31,
    requestedMinutes: 30, title: '半小时放松心情慢慢走', accepted: false },
  { name: 'requested half hour must not override actual 60-minute route', seconds: 3599, expectedMinutes: 60,
    requestedMinutes: 30, title: '半小时放松心情慢慢走', accepted: false }
])('hour-based claims follow routeFacts display duration, not exact-second drift or requested time: $name',
  ({ seconds, expectedMinutes, requestedMinutes, title, accepted }) => {
    const p = payload();
    p.routeFacts.durationSeconds = seconds;
    p.routeFacts.durationMinutes = expectedMinutes;
    p.preferences.durationMinutes = requestedMinutes;
    const proposed = { ...copy, title };
    const result = contract.validateCopyDetailed(proposed, p);
    if (accepted) expect(result).toEqual({ copy: proposed, reason: null, field: null });
    else expect(result).toMatchObject({ copy: null, reason: 'WRONG_MEASUREMENT', field: 'title' });
  });

test('live C001 rejection is a rounded half-hour false positive, not a 15-minute preference claim', () => {
  const p = payload();
  p.routeFacts.distanceMeters = 1920;
  p.routeFacts.durationSeconds = 1756;
  p.routeFacts.durationMinutes = 30;
  p.preferences.durationMinutes = 15;
  p.routeFacts.orderedPois = [{ ref: 'P1', name: '人民公园', category: 'park' }];
  const proposed = {
    title: '人民公园慢环：半小时换换心情',
    description: '从起点出发，途经人民公园，沿环线走回原处。不用赶时间，就当随意溜达一圈，看看路边的绿意，让身体和呼吸都松下来。',
    recommendationReason: '想抽空透口气时，这条短环线刚好。途经人民公园，回路轻松，适合慢走放空，自己留意沿途的小变化就好。'
  };
  expect(contract.validateCopyDetailed(proposed, p))
    .toEqual({ copy: proposed, reason: null, field: null });
  expect(contract.parseCopyDetailed(JSON.stringify(proposed), p).copy).toEqual(proposed);
});

test('live C004: four known park POIs and generic “途经几处公园” do not invent a named destination', () => {
  const p = payload();
  p.routeFacts.distanceMeters = 3140;
  p.routeFacts.durationSeconds = 3070;
  p.routeFacts.durationMinutes = 52;
  p.routeFacts.orderedPois = [
    { ref: 'P1', name: '静安河畔公园', category: 'park' },
    { ref: 'P2', name: '闵行滨水绿道休闲生态公园', category: 'park' },
    { ref: 'P3', name: '梅陇生态园', category: 'park' },
    { ref: 'P4', name: '海心园', category: 'park' }
  ];
  p.preferences.durationMinutes = 60;
  p.preferences.environmentPreferences = ['水边', '街道', '商街', '公园'];
  const generated = {
    title: '慢行环线，偷得半日闲趣',
    description: '从起点出发，途经静安河畔公园、闵行滨水绿道休闲生态公园、梅陇生态园与海心园，兜转一圈回到原处。不妨把脚步交还给心情，随意看看沿路绿意。',
    recommendationReason: '想换换心情时，这条环线刚好够散个短步。不赶时间，不盯地图，途经几处公园慢慢晃，挺适合放空一下午。'
  };
  expect(contract.validateCopyDetailed(generated, p))
    .toEqual({ copy: generated, reason: null, field: null });
  expect(contract.parseCopyDetailed(JSON.stringify(generated), p).copy).toEqual(generated);
});

test.each([
  '途经几个公园慢慢逛',
  '经过两座公园放松心情',
  '途经四处公园，给生活留点空白',
  '途经一些公园，随心散步',
  '经过许多公园，慢慢探索',
  '途经几处公园，然后前往人民公园'
])('does not misclassify generic quantified place categories as new proper names: %s', phrase => {
  const c = { ...copy, recommendationReason:
    `${phrase}，按自己的步调慢慢走，给日常留一段轻松的时光。` };
  expect(contract.validateCopyDetailed(c, payload()).reason).not.toBe('INVALID_POI');
});

test.each([
  '途经紫荆公园',
  '途经老三桥',
  '经过陌生的海滨博物馆',
  '途经几个紫荆公园',
  '途经几处公园，然后前往虚构的海滨广场',
  '走进几处公园'
])('generic quantity exclusion does not excuse identifiable unknown places or unverified entry: %s', phrase => {
  const c = { ...copy, description:
    `${phrase}。不妨带着探索的心情出发，在这次散步中给日常留一点自由的空间。` };
  const verdict = contract.validateCopyDetailed(c, payload());
  expect(verdict).toMatchObject({ copy: null, reason: 'INVALID_POI', field: 'description' });
});
