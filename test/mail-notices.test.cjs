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
  h.context = () => { const c = original(); c.MailApp.sendEmail = (...args) => { sent.push(args); }; c.MailApp.getRemainingDailyQuota = () => 100; return c; };
  h.send = req => JSON.parse(h.context().doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  return { h, sent };
}

test('a new cancellation request mails the teacher once, with the lesson and reason; a retry of the same request does not repeat it', () => {
  const { h, sent } = fixture();
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-01', reason: '学校行事' }));
  const teacher = sent.filter(a => String(a[1] || '').includes('【お休みの連絡】'));
  assert.equal(teacher.length, 1);
  assert.equal(teacher[0][0], 'teacher@example.invalid');
  assert.equal(teacher[0][1], '[ステップワイズ予約] 【お休みの連絡】架空生徒Aさん');
  assert.match(teacher[0][2], /架空生徒Aさんから授業のお休みの連絡が届きました。\n9\/15\(火\) 15:00〜16:00（数学）\n理由: 学校行事\n/);
  assert.doesNotMatch(teacher[0][2], /前日23時/, 'a request in time is not marked late');
  assert.match(teacher[0][2], /https:\/\/www\.stepwise-education\.jp\/kanri\//);
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-01', reason: '学校行事' }));
  assert.equal(sent.filter(a => String(a[1] || '').includes('【お休みの連絡】')).length, 1, 'the same request does not mail twice');
});

test('a late request says so, and test students never mail the teacher', () => {
  const { h, sent } = fixture();
  h.advance(Date.parse('2026-09-14T23:30:00+09:00') - h.now());
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-02', reason: '発熱' }));
  assert.match(sent.find(a => String(a[1]).includes('【キャンセル】'))[2], /無料で変更・お休みにできる期限（前日23時）を過ぎてからの連絡です（キャンセル料の対象）。/);
  const t = fixture();
  t.h.setRow('students', 'id', 'test-a', { name: '【テスト】生徒A' });
  ok(t.h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-03', reason: '発熱' }));
  assert.equal(t.sent.filter(a => String(a[1] || '').includes('【お休みの連絡】')).length, 0);
});

test('parent invoice mails say 授業料, not the retired 月謝', () => {
  const { h } = fixture(), c = h.context();
  const created = c.familyBusinessMail_({ kind: 'invoiceCreated', ym: '2026-09' }), voided = c.familyBusinessMail_({ kind: 'invoiceVoided', ym: '2026-09' });
  assert.match(created.body, /^授業料の請求内容を記録しました。/); assert.match(voided.body, /^授業料の請求を取り消しました。/);
  assert.doesNotMatch(created.body + voided.body, /月謝/);
});

// 見直し候補 7: 科目だけの修正では生徒に「授業の予定を変更しました」を送らない
test('a subject-only change does not mail the student; a change of date, time, length or format does', () => {
  const h = createHarness({ iterations: 10 }), c = h.context(), calls = [];
  c.studentEmailNotifyOfferChanged_ = (...args) => { calls.push(args); return { ok: true, status: 'sent' }; };
  const base = { id: 's1', studentId: 'test-a', date: '2026-09-15', start: '15:00', min: 60, subject: '数学', deliveryMode: 'in_person', status: 'booked', done: '' };
  const run = (op, patch) => c.schedulingEditNotice_({ id: 'w-' + op }, { id: 'test-a', name: '架空生徒A' }, { op, slot: base }, { op, slot: { ...base, ...patch } });
  for (const op of ['editBooked', 'editOffered', 'editLessonSubject']) assert.equal(run(op, { subject: '英語' }).status, 'skipped', op);
  assert.equal(calls.length, 0);
  run('editBooked', { start: '16:00' }); run('editOffered', { date: '2026-09-16' }); run('setSlotDeliveryMode', { deliveryMode: 'online' }); run('editBooked', { min: 90, subject: '英語' });
  assert.equal(calls.length, 4, 'real schedule changes still mail the student');
  assert.equal(calls[3][3].subject, '英語', 'a mail for a time change shows the corrected subject too');
});

// 見直し候補 6: 先生あての通知は種類ごとに止められる
test('teacher mail kinds can be switched off one by one, and the master switch stops them all', () => {
  const { h, sent } = fixture(), T = require('./gas-harness.cjs').TEACHER_TOKEN;
  const prefs = ok(h.send({ action: 'admin', op: 'state', token: T })).admin.teacherMailPrefs;
  assert.equal(prefs.all, true); assert.ok(prefs.kinds.length >= 8); assert.ok(prefs.kinds.every(k => k.on));
  assert.ok(h.send({ action: 'admin', op: 'teacherMailPrefsSave', token: T, prefs: { all: true, kinds: { unknown: false } } }).error);
  ok(h.send({ action: 'admin', op: 'teacherMailPrefsSave', token: T, prefs: { all: true, kinds: { cancelRequest: false } } }));
  ok(h.send({ action: 'cancelReq', k: 'synthetic-link-a', slotId: 'notice-slot', requestId: 'notice-cancel-off', reason: '発熱' }));
  assert.equal(sent.filter(a => String(a[1] || '').includes('【お休みの連絡】')).length, 0, 'a switched-off kind is not mailed');
  const c = h.context();
  c.notify_('【共有予定】架空生徒Aさん', '本文'); assert.equal(sent.filter(a => String(a[1] || '').includes('【共有予定】')).length, 1, 'other kinds still arrive');
  assert.equal(c.teacherMailKind_('【取消依頼の取り下げ】架空生徒Aさん'), 'cancelWithdrawn', 'the longer prefix wins');
  ok(h.send({ action: 'admin', op: 'teacherMailPrefsSave', token: T, prefs: { all: false, kinds: {} } }));
  h.context().notify_('【共有予定】架空生徒Aさん', '本文'); assert.equal(sent.filter(a => String(a[1] || '').includes('【共有予定】')).length, 1, 'the master switch stops everything');
  assert.equal(ok(h.send({ action: 'admin', op: 'state', token: T })).admin.teacherMailPrefs.kinds.find(k => k.key === 'cancelRequest').on, false);
});

// 見直し候補 2: 先生が承認を待たずに登録したとき
test('a teacher booking mails the student "授業を登録しました" once and does not mail the teacher', () => {
  const { h, sent } = fixture(), T = require('./gas-harness.cjs').TEACHER_TOKEN;
  // 生徒のメールを受信確認済みにする（確認メールのリンクを使う）
  ok(h.send({ action: 'studentEmailRequest', k: 'synthetic-link-a', email: 'student@example.invalid' }));
  const verify = sent.map(a => a[0]).filter(m => m && typeof m === 'object' && /verify=/.test(m.body)).at(-1);
  ok(h.send({ action: 'studentEmailVerify', challenge: decodeURIComponent(verify.body.match(/\?verify=([^\s]+)/)[1]) }));
  h.spreadsheet.getSheetByName('slots').appendRow(['offer-slot', '2026-09-16', '17:00', 60, 'offered', 'test-a', '', '', '', '英語', '', 'in_person', '']);
  const snap = h.context().schedulingSnapshot_(h.rows('slots').find(s => s.id === 'offer-slot'));
  const req = { action: 'admin', op: 'teacherBook', token: T, studentId: 'test-a', slotId: 'offer-slot', requestId: 'teacher-book-mail-1', expectedSnapshot: snap };
  ok(h.send(req)); ok(h.send(req));
  const student = sent.map(a => a[0]).filter(m => m && typeof m === 'object' && /授業を登録しました/.test(m.subject));
  assert.equal(student.length, 1, 'one mail even when the same booking is sent twice');
  assert.equal(student[0].to, 'student@example.invalid'); assert.equal(student[0].subject, '【ステップワイズ】授業を登録しました');
  assert.match(student[0].body, /^先生が授業を登録しました。返事は不要です。\n\n・2026-09-16 17:00〜18:00 英語（対面）/);
  assert.equal(sent.filter(a => String(a[1] || '').includes('【確定】')).length, 0, 'the teacher is not told about their own booking');
  assert.equal(h.rows('studentEmailOutbox').filter(o => o.kind === 'booked').length, 1);
});
