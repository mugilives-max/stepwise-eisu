'use strict';
// 講師アカウント: 業務に必要な情報だけが届き、担当外・料金・保護者の連絡先・先生の操作には届かないこと。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, TEACHER_TOKEN } = require('./gas-harness.cjs');

const clone = v => JSON.parse(JSON.stringify(v));
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const denied = r => { assert.notEqual(r.ok, true, JSON.stringify(r)); assert.ok(r.error, JSON.stringify(r)); return r; };
const PASS = 'synthetic-instructor-pass';

function fixture() {
  const h = createHarness({ iterations: 10 });
  ok(h.admin('state'));
  h.context().ensureLessonSchema_();
  const slots = h.spreadsheet.getSheetByName('slots');
  // id,date,start,min,status,studentId,done,eventId,meetUrl,subject,req,deliveryMode,kind,instructorId
  slots.appendRow(['slot-a', '2026-09-07', '13:00', 60, 'booked', 'test-a', false, '', 'https://example.invalid/meet', '英語', '', 'online', '', '']);
  slots.appendRow(['slot-b', '2026-09-07', '14:00', 60, 'booked', 'test-b', false, '', '', '数学', '', 'in_person', '', '']);
  slots.appendRow(['slot-a2', '2026-09-14', '13:00', 60, 'booked', 'test-a', false, '', '', '英語', '', 'online', '', '']);
  h.instructor = (op, args = {}) => h.request({ action: 'admin', op, token: h.itoken, from: 'kanri', ...args });
  return h;
}
function addInstructor(h, name = '【テスト】講師', email = 'instructor@example.invalid') {
  const added = ok(h.admin('instructorAdd', { name, email }));
  const invite = added.inviteUrl.split('#instructor-invite=')[1];
  assert.match(invite, /^ii1\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
  const set = ok(h.request({ action: 'admin', op: 'instructorSetup', invite, password: PASS }));
  assert.match(set.token, /^in1\.[a-f0-9]{32}\.[a-f0-9]{64}$/); assert.equal(set.role, 'instructor');
  h.itoken = set.token;
  return added.instructor;
}

test('the teacher invites an instructor with a one-time link; the instructor sets a password and logs in from the admin login form', () => {
  const h = fixture();
  const added = ok(h.admin('instructorAdd', { name: '【テスト】講師', email: 'Instructor@Example.invalid' }));
  assert.equal(added.instructor.status, 'pending'); assert.equal(added.instructor.email, 'instructor@example.invalid');
  assert.equal(JSON.stringify(added).includes('passHash'), false);
  denied(h.admin('instructorAdd', { name: '重複', email: 'instructor@example.invalid' }));
  const invite = added.inviteUrl.split('#instructor-invite=')[1];
  const info = ok(h.request({ action: 'admin', op: 'instructorInviteInfo', invite }));
  assert.deepEqual([info.name, info.email], ['【テスト】講師', 'instructor@example.invalid']);
  denied(h.request({ action: 'admin', op: 'instructorSetup', invite, password: 'short' }));
  denied(h.request({ action: 'admin', op: 'instructorInviteInfo', invite: invite.slice(0, -1) + (invite.endsWith('0') ? '1' : '0') }));
  const set = ok(h.request({ action: 'admin', op: 'instructorSetup', invite, password: PASS }));
  denied(h.request({ action: 'admin', op: 'instructorSetup', invite, password: PASS }), 'the link works once');
  assert.equal(h.rows('instructors')[0].status, 'active');

  const login = ok(h.request({ action: 'admin', op: 'login', email: 'instructor@example.invalid', password: PASS }));
  assert.equal(login.role, 'instructor'); assert.equal(login.instructor.name, '【テスト】講師'); assert.notEqual(login.token, set.token);
  assert.equal(login.admin, undefined, 'no admin state is returned to an instructor');
  denied(h.request({ action: 'admin', op: 'login', email: 'instructor@example.invalid', password: PASS + 'x' }));
  ok(h.admin('state'), 'the teacher session is untouched');
});

test('an instructor sees only their assigned lessons and students, without fees or parent contact details', () => {
  const h = fixture(); const me = addInstructor(h);
  ok(h.admin('setSlotInstructor', { slotId: 'slot-a', studentId: 'test-a', instructorId: me.id }));
  ok(h.admin('setSlotInstructor', { slotId: 'slot-a2', studentId: 'test-a', instructorId: me.id }));
  assert.equal(h.rows('slots').find(s => s.id === 'slot-a').instructorId, me.id);
  const home = ok(h.instructor('instructorHome')).data;
  assert.deepEqual(home.lessons.map(l => l.id), ['slot-a', 'slot-a2']);
  assert.deepEqual(Object.keys(home.lessons[0]).sort(), ['date', 'deliveryMode', 'done', 'id', 'kind', 'lessonRecordStatus', 'meetUrl', 'min', 'start', 'studentId', 'studentName', 'subject']);
  assert.deepEqual(home.students.map(s => s.id), ['test-a']);
  assert.deepEqual(Object.keys(home.students[0]).sort(), ['grade', 'id', 'name', 'school']);
  const text = JSON.stringify(home);
  for (const secret of ['rate30', 'fee', 'payments', 'email', 'code', '保護者名', '保護者連絡先', 'parent', 'synthetic-link']) assert.equal(text.includes(secret), false, secret);

  const student = ok(h.instructor('instructorStudent', { studentId: 'test-a' })).data;
  assert.deepEqual(Object.keys(student).sort(), ['exams', 'grade', 'grades', 'id', 'name', 'school', 'tasks']);
  denied(h.instructor('instructorStudent', { studentId: 'test-b' }));

  // 先生の操作には一切進めない
  for (const op of ['state', 'kanriDashboard', 'kanriStudent', 'billingOverview', 'billingPreview', 'offer', 'unbook', 'planLineSave', 'kanriAddPayment', 'familyList', 'instructorList', 'instructorAdd', 'setSlotInstructor', 'lessonRecordVoid', 'planOutlineSave', 'serviceInbox', 'studentEmailRetryNotification'])
    assert.equal(denied(h.instructor(op, { studentId: 'test-a', slotId: 'slot-a' })).errorCode, 'forbidden', op);
});

test('an instructor records their assigned lesson; the record is attributed to them and other lessons stay closed', () => {
  const h = fixture(); const me = addInstructor(h);
  ok(h.admin('setSlotInstructor', { slotId: 'slot-a', studentId: 'test-a', instructorId: me.id }));
  denied(h.instructor('lessonContext', { studentId: 'test-b', slotId: 'slot-b' }));
  denied(h.instructor('lessonContext', { studentId: 'test-a', slotId: 'slot-a2' }), 'not assigned yet');
  denied(h.instructor('lessonContext', { studentId: 'test-b', slotId: 'slot-a' }), 'student must match the slot');
  const context = ok(h.instructor('lessonContext', { studentId: 'test-a', slotId: 'slot-a' })).context;
  assert.equal(context.role, 'instructor');
  assert.deepEqual(context.lessonChoices.map(x => x.id), ['slot-a'], 'unassigned lessons are not offered as links');

  const saved = ok(h.instructor('lessonRecordSave', { studentId: 'test-a', slotId: 'slot-a', expectedRevision: 0, requestId: 'instructor-save-1', markDone: true,
    record: { content: '関係代名詞の基本', progress: '', nextFocus: '', teacherNote: '共有メモ', homework: [], report: {} } }));
  assert.ok(saved.context && saved.context.record, JSON.stringify(saved).slice(0, 200));
  const row = h.rows('lessonRecords')[0];
  assert.equal(row.createdBy, 'instructor:' + me.id); assert.equal(row.updatedBy, 'instructor:' + me.id);
  assert.equal(JSON.parse(row.reportJson).teacher, '【テスト】講師', '担当講師 is filled from the instructor');
  assert.equal(h.rows('slots').find(s => s.id === 'slot-a').done, true);
  // メモは先生と共有する
  assert.equal(ok(h.admin('lessonContext', { studentId: 'test-a', slotId: 'slot-a' })).context.record.teacherNote, '共有メモ');
  // 先生が記録しても teacher:primary のまま
  ok(h.admin('lessonRecordSave', { studentId: 'test-b', slotId: 'slot-b', expectedRevision: 0, requestId: 'teacher-save-1', record: { content: '先生の記録', progress: '', nextFocus: '', teacherNote: '', homework: [] } }));
  assert.equal(h.rows('lessonRecords').find(r => r.slotId === 'slot-b').createdBy, 'teacher:primary');

  // 実施登録は担当授業を「実施済みにする」だけ
  denied(h.instructor('toggleDone', { studentId: 'test-b', slotId: 'slot-b', done: true }));
  denied(h.instructor('toggleDone', { studentId: 'test-a', slotId: 'slot-a', done: false }));
});

test('stopping an instructor ends their sessions at once and the teacher can reissue the link to reset a password', () => {
  const h = fixture(); const me = addInstructor(h);
  ok(h.instructor('instructorHome'));
  ok(h.admin('instructorSetActive', { instructorId: me.id, active: false }));
  assert.equal(denied(h.instructor('instructorHome')).badAuth, true);
  denied(h.request({ action: 'admin', op: 'login', email: 'instructor@example.invalid', password: PASS }));
  denied(h.admin('setSlotInstructor', { slotId: 'slot-a', studentId: 'test-a', instructorId: me.id }), 'a stopped instructor cannot be assigned');
  denied(h.admin('instructorInvite', { instructorId: me.id }));
  ok(h.admin('instructorSetActive', { instructorId: me.id, active: true }));
  const again = ok(h.admin('instructorInvite', { instructorId: me.id }));
  const reset = ok(h.request({ action: 'admin', op: 'instructorSetup', invite: again.inviteUrl.split('=')[1], password: PASS + '-new' }));
  assert.match(reset.token, /^in1\./);
  denied(h.request({ action: 'admin', op: 'login', email: 'instructor@example.invalid', password: PASS }));
  ok(h.request({ action: 'admin', op: 'login', email: 'instructor@example.invalid', password: PASS + '-new' }));
});

test('offers can be assigned to an instructor, and the monthly work summary counts their completed lessons', () => {
  const h = fixture(); const me = addInstructor(h);
  h.setRow('students', 'id', 'test-a', { deliveryMode: 'online' });
  denied(h.admin('offer', { studentId: 'test-a', date: '2026-09-20', start: '10:00', min: 60, subject: '英語', instructorId: 'not-an-instructor' }));
  const offer = ok(h.admin('offer', { studentId: 'test-a', date: '2026-09-20', start: '10:00', min: 60, subject: '英語', repeat: 2, instructorId: me.id, planForce: true, force: true }));
  assert.equal(offer.added, 2);
  const offered = h.rows('slots').filter(s => s.date === '2026-09-20' || s.date === '2026-09-27');
  assert.deepEqual(offered.map(s => s.instructorId), [me.id, me.id]);

  ok(h.admin('setSlotInstructor', { slotId: 'slot-a', studentId: 'test-a', instructorId: me.id }));
  ok(h.admin('toggleDone', { slotId: 'slot-a', studentId: 'test-a', done: true }));
  const list = ok(h.admin('instructorList', { ym: '2026-09' }));
  assert.deepEqual(clone(list.work.rows).map(r => [r.name, r.count, r.minutes]), [['【テスト】講師', 1, 60]]);
  assert.equal(JSON.stringify(list.instructors).includes('passHash'), false);
  assert.equal(JSON.stringify(list.instructors).includes('tokenHash'), false);
  ok(h.admin('setSlotInstructor', { slotId: 'slot-a', studentId: 'test-a', instructorId: '' }));
  assert.equal(clone(ok(h.admin('instructorList', { ym: '2026-09' })).work.rows)[0].count, 0, 'clearing the assignment returns the lesson to the teacher');
  assert.ok(ok(h.admin('kanriDashboard')).data.instructors.some(x => x.id === me.id));
});

test('the Worker read path does not accept an instructor token for admin reads', () => {
  const read = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'cf', 'worker', 'read.mjs'), 'utf8');
  assert.match(read, /if \(gas\.authMode_\(\) !== 'account' \|\| !gas\.tokenOk_\(body\.token\)\)/);
  assert.doesNotMatch(read, /instructor/, 'instructor operations go through the write path where admin_ applies the instructor allowlist');
});
