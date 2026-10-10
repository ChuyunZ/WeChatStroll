const fs = require('fs');
const path = require('path');

const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');

test('the optional text entry is presented as a personal journal, not AI feedback', () => {
  const feedback = read('miniprogram/pages/feedback/feedback.wxml');
  expect(feedback).toContain('我的散步日志（选填）');
  expect(feedback).toContain('不用于 AI 路线推荐');
  expect(feedback).toContain('日志随评价一起保存');
  expect(feedback).toContain('maxlength="500" bindinput="onComment"');
  expect(feedback).not.toContain('还有什么想告诉我们？');
});

test('historical journal is separate from the structured evaluation', () => {
  const detail = read('miniprogram/pages/history-detail/history-detail.wxml');
  const journalHeading = '<view wx:if="{{feedbackState === \'ready\' && feedback.comment}}" class="card">';
  const evaluation = detail.split('这次的评价')[1].split(journalHeading)[0];
  expect(evaluation).not.toContain('{{feedback.comment}}');
  expect(detail).toContain(journalHeading);
  expect(detail).toContain('<text class="section-title">散步日志</text>');
  expect(detail).toContain('<text class="comment" user-select="{{true}}">{{feedback.comment}}</text>');
  expect(detail).toContain('不参与 AI 路线推荐');
});

test('raw journal text stays outside structured AI preference history', () => {
  const store = read('cloudfunctions/preferenceProfileStore/store.js');
  const projection = store.match(/const FEEDBACK_FIELDS = (\{[\s\S]*?\});/);
  expect(projection).not.toBeNull();
  expect(projection[1]).not.toMatch(/\bcomment\b/);
  const builder = read('cloudfunctions/preferenceProfileStore/profile-builder.js');
  expect(builder).not.toMatch(/\bf\.comment\b/);
});
