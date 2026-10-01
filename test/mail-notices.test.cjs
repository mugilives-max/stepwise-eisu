'use strict';
// メール通知の見直し（2026-10-01、docs/EMAIL_NOTIFICATIONS.md の見直し候補 1・3・5）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./gas-harness.cjs');

const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
// 先生あての通知を受け取る。生徒は【テスト】で始まると送らないので、架空の名前に変える
function fixture() {
  const h = createHarness({ iterations: 10 }), sent = [];
  ok(h.request({ action: 'admin', op: 'state', token: require('./gas-harness.cjs').TEACHER_TOKEN }));
  h.setRow('config', 'key', 'emailNotify', { value: 'on' });
  h.setRow('students', 'id', 'test-a', { name: '架空生徒A' });
  h.spreadsheet.getSheetByName('slots').appendRow(['notice-slot', '2026-09-15', '15:00', 60, 'booked', 'test-a', false, '', '', '数学', '', 'in_person', '']);
  const original = h.context;
  h.context = () => { const c = original(); c.MailApp.sendEmail = (...args) => { sent.push(args); }; return c; };
  h.send = req => JSON.parse(h.context().doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  return { h, sent };
}

test('a new cancellation request mails the teacher once, with the lesson and reason; a retry of the same request does not repeat it', () => {
  const { h, sent } = fixture();
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-01', reason: '学校行事' }));
  const teacher = sent.filter(a => String(a[1] || '').includes('【取消依頼】'));
  assert.equal(teacher.length, 1);
  assert.equal(teacher[0][0], 'teacher@example.invalid');
  assert.equal(teacher[0][1], '[ステップワイズ予約] 【取消依頼】架空生徒Aさん');
  assert.match(teacher[0][2], /架空生徒Aさんから授業の取消依頼が届きました。\n9\/15\(火\) 15:00〜16:00（数学）\n理由: 学校行事\n/);
  assert.doesNotMatch(teacher[0][2], /前日23時/, 'a request in time is not marked late');
  assert.match(teacher[0][2], /https:\/\/www\.stepwise-education\.jp\/kanri\//);
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-01', reason: '学校行事' }));
  assert.equal(sent.filter(a => String(a[1] || '').includes('【取消依頼】')).length, 1, 'the same request does not mail twice');
});

test('a late request says so, and test students never mail the teacher', () => {
  const { h, sent } = fixture();
  h.advance(Date.parse('2026-09-14T23:30:00+09:00') - h.now());
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-02', reason: '発熱' }));
  assert.match(sent.find(a => String(a[1]).includes('【取消依頼】'))[2], /無料で取り消せる期限（前日23時）を過ぎてからの依頼です。/);
  const t = fixture();
  t.h.setRow('students', 'id', 'test-a', { name: '【テスト】生徒A' });
  ok(t.h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-03', reason: '発熱' }));
  assert.equal(t.sent.filter(a => String(a[1] || '').includes('【取消依頼】')).length, 0);
});

test('parent invoice mails say 授業料, not the retired 月謝', () => {
  const { h } = fixture(), c = h.context();
  const created = c.familyBusinessMail_({ kind: 'invoiceCreated', ym: '2026-09' }), voided = c.familyBusinessMail_({ kind: 'invoiceVoided', ym: '2026-09' });
  assert.match(created.body, /^授業料の請求内容を記録しました。/); assert.match(voided.body, /^授業料の請求を取り消しました。/);
  assert.doesNotMatch(created.body + voided.body, /月謝/);
});
