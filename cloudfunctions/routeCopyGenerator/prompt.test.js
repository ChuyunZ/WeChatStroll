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
    const data = prompt.split('UNTRUSTED_ROUTE_DATA_JSON')[1]
      .split('END_UNTRUSTED_ROUTE_DATA_JSON')[0];
    expect(JSON.parse(data.trim()).routeFacts.durationMinutes).toBe(actual);
    expect(JSON.parse(data.trim()).preferences.durationMinutes).toBe(desired);
    expect(prompt).toContain('三个字段均不要提任何步行时长或路线距离');
    expect(prompt).toContain('差不多一小时');
    expect(prompt).toContain('路线卡片显示');
    expect(prompt).toContain('两者不能混淆');
    expect(prompt).toContain('39分钟');
    expect(prompt).toContain('51分钟');
    expect(prompt).toContain('不要另行估算时长');
    expect(prompt).toContain('不得自创简称');
  });
