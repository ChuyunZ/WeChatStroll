const { buildPrompt } = require('./prompt');
const { projectRoute } = require('../../miniprogram/services/route-copy');
const { preferences, history, route } = require('../../tests/helpers/route-copy');

test.each([
  { actual: 39, desired: 30 },
  { actual: 51, desired: 60 },
  { actual: 90, desired: 15 }
])('prompt distinguishes route display duration ($actual) from preference ($desired) and forbids time estimates',
  ({ actual, desired }) => {
    const p = projectRoute(route(), { ...preferences, durationMinutes: desired }, history).payload;
    p.routeFacts.durationSeconds = actual * 60 - 1;
    p.routeFacts.durationMinutes = actual;
    const prompt = buildPrompt(p);
    const data = prompt.match(/\nUNTRUSTED_ROUTE_DATA_JSON\n(.*)\nEND_UNTRUSTED_ROUTE_DATA_JSON$/s);
    expect(data).not.toBeNull();
    const parsed = JSON.parse(data[1]);
    expect(parsed.routeFacts.durationMinutes).toBe(actual);
    expect(parsed.preferences.durationMinutes).toBe(desired);
    expect(prompt).toContain('三个字段均不要提任何步行时长或路线距离');
    expect(prompt).toContain('差不多一小时');
    expect(prompt).toContain('路线卡片显示');
    expect(prompt).toContain('两者不能混淆');
    expect(prompt).toContain('39分钟');
    expect(prompt).toContain('51分钟');
    expect(prompt).toContain('不要另行估算时长');
    expect(prompt).toContain('不得自创简称');
  });

test('C019/C029: prompt forbids unverified quiet/scenery and POI venue-entry claims', () => {
  const p = projectRoute(route(), preferences, history).payload;
  const text = buildPrompt(p);
  for (const fragment of [
    '只证明路线上经过这些地点', '不要写“走进XX”', '“再走进XX”',
    '“穿过XX”', '“在林间走”', '“安静角落”', '“树影摇曳”',
    '“穿街过林”', '可以用“留意周围”'
  ]) expect(text).toContain(fragment);
});

test('audit100 C041/C052: prompt prevents abbreviated POI names and unsupported negative interior claims', () => {
  const p = projectRoute(route(), preferences, history).payload;
  p.routeFacts.orderedPois[0].name = '示例区防护林小公园';
  const text = buildPrompt(p);
  expect(text).toContain('完整名称放不下');
  expect(text).toContain('不能改写为“防护林小公园”');
  expect(text).toContain('不必走进园里');
  expect(text).toContain('否定句也不例外');
  expect(text).toContain('不能写');
  expect(text).toContain('UNTRUSTED_ROUTE_DATA_JSON');
  const serialized = text.split('UNTRUSTED_ROUTE_DATA_JSON\n')[1].split('\nEND_UNTRUSTED_ROUTE_DATA_JSON')[0];
  expect(JSON.parse(serialized)).toEqual(p);
});
