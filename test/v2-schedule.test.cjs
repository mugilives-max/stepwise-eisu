'use strict';
// 作り直し（v2）3段目: 予定。仮予定・予定表・直接決定・変更とお休みの連絡・自動決定・講師の範囲・カレンダー・今の台帳からの写し。
// 時計は 2026-10-02 12:00（日本時間）から始まる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500, deliveryMode: 'online' })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const me = (await h.ok('staff/me', { auth })).me;
  const lesson = { auth, studentId: kid.id, start: '17:00', minutes: 60, subject: '数学', deliveryMode: 'online', staffId: me.id };
  const k = new URL(kid.link).searchParams.get('k');
  return { h, auth, fam, kid, parent, me, lesson, k };
}
const lessonsOf = h => h.rows('select * from lessons order by date, start');
const at = (h, iso) => { h.clock = Date.parse(iso); };

test('a manager sends 仮予定 with a deadline; held ones stay hidden until the schedule is sent once', async () => {
  const { h, auth, parent, lesson } = await world();
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-09' });
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-11-03', repeat: 2 });
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-03', start: '10:00' });
  assert.deepEqual(lessonsOf(h).map(l => [l.date, l.status, l.confirmBy]), [['2026-10-03', 'proposed', ''], ['2026-10-09', 'proposed', '2026-10-05'], ['2026-11-03', 'proposed', '2026-10-25'], ['2026-11-10', 'proposed', '2026-10-25']]);
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-12-01', hold: true });
  assert.equal((await h.ok('family/schedule', { auth: parent, to: '2026-12-31' })).lessons.length, 4, '未送信は保護者に見せない');
  assert.equal((await h.ok('schedule/lessons/sendHeld', { auth, studentId: lesson.studentId })).sent, 1);
  assert.equal(lessonsOf(h).at(-1).status, 'proposed');
  assert.ok(h.mails().filter(m => m.audience === 'family').every(m => m.status === 'dismissed' && m.error === 'まだ切り替え前のため送らない'), '切り替え前は保護者へ送らない');
  assert.equal((await h.call('schedule/lessons/create', { ...lesson, date: '2026-10-09', start: '17:30' })).error.code, 'overlap');
  await h.ok('schedule/unavailability/add', { auth, date: '2026-10-16' });
  assert.equal((await h.call('schedule/lessons/create', { ...lesson, date: '2026-10-16' })).error.code, 'needForce');
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-16', force: true });
});

test('direct decision creates the calendar event (held before the switch-over) and records who decided', async () => {
  const { h, auth, lesson } = await world();
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-03', start: '10:00' });
  const l = lessonsOf(h)[0];
  const r = await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  assert.equal(r.lesson.status, 'decided');
  const cal = h.rows("select payload, status from effects where kind = 'calendarCreate'");
  assert.equal(cal.length, 1); assert.equal(cal[0].status, 'dismissed', '切り替え前はカレンダーに作らない');
  assert.equal(JSON.parse(cal[0].payload).wantMeet, true);
  assert.match(lessonsOf(h)[0].decidedBy, /^staff:/);
  assert.equal((await h.call('schedule/lessons/decide', { auth, id: l.id, version: l.version })).error.code, 'conflict');
});

test('parents: お休み before 23:00 the day before is free and immediate; after that only 開始を遅らせたい or キャンセル', async () => {
  const { h, auth, parent, lesson } = await world();
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-09' }); await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-10' });
  for (const l of lessonsOf(h)) await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  const [a, b] = (await h.ok('family/schedule', { auth: parent })).lessons;
  assert.deepEqual(a.choices, ['move', 'rest']);
  assert.equal((await h.call('family/lessons/request', { auth: parent, lessonId: a.id, kind: 'rest' })).error.code, 'needNote');
  assert.equal((await h.ok('family/lessons/request', { auth: parent, lessonId: a.id, kind: 'rest', note: '家族の用事' })).lesson.status, 'rested');
  assert.ok(h.mails().some(m => m.audience === 'staff' && m.subject.includes('【お休みの連絡】')), '教室管理者に知らせる');
  const move = await h.ok('family/lessons/request', { auth: parent, lessonId: b.id, kind: 'move', note: '11日だと助かります' });
  assert.equal(move.request.status, 'open');
  const open = (await h.ok('schedule/staff/range', { auth })).openRequests;
  assert.deepEqual(open.map(r => r.kind), ['move']);
  const lb = lessonsOf(h).find(l => l.id === b.id);
  await h.ok('schedule/lessons/update', { auth, id: b.id, version: lb.version, date: '2026-10-11' });
  assert.equal((await h.ok('schedule/staff/range', { auth })).openRequests.length, 0, '日時を直したらお願いは済み');
  at(h, '2026-10-10T23:30:00+09:00');
  const after = (await h.ok('family/schedule', { auth: parent })).lessons.find(l => l.id === b.id);
  assert.deepEqual(after.choices, ['late', 'cancel']);
  assert.equal((await h.call('family/lessons/request', { auth: parent, lessonId: b.id, kind: 'rest', note: 'x' })).error.code, 'notNow');
  const cancel = await h.ok('family/lessons/request', { auth: parent, lessonId: b.id, kind: 'cancel', note: '発熱' });
  assert.equal(cancel.lesson.status, 'cancelled');
  assert.ok(h.mails().some(m => m.subject.includes('【キャンセル】') && m.body.includes('キャンセル料の対象')));
  const back = await h.ok('family/lessons/withdraw', { auth: parent, requestId: cancel.request.id });
  assert.equal(back.lesson.status, 'decided', '開始前なら取り下げて元に戻せる');
});

test('the nightly run decides 仮予定 past their deadline once, but not ones with an open date-change request', async () => {
  const { h, auth, parent, lesson } = await world();
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-09' }); await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-08' });
  const second = lessonsOf(h).find(l => l.date === '2026-10-09');
  await h.ok('family/lessons/request', { auth: parent, lessonId: second.id, kind: 'move', note: '別の日に' });
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  assert.equal((await runV2Scheduled(h.env, Date.parse('2026-10-05T00:10:00+09:00'))).confirmed, 0, '締め切りの日のうちは決めない');
  const r = await runV2Scheduled(h.env, Date.parse('2026-10-06T00:10:00+09:00'));
  assert.deepEqual([r.confirmed, r.students], [1, 1]);
  assert.deepEqual(lessonsOf(h).map(l => [l.date, l.status, l.decidedBy]), [['2026-10-08', 'decided', 'system:auto'], ['2026-10-09', 'proposed', '']]);
  assert.equal((await runV2Scheduled(h.env, Date.parse('2026-10-07T00:10:00+09:00'))).confirmed, 0);
  assert.ok(h.mails().some(m => m.subject.includes('授業予定日が決定しました') && m.status === 'dismissed'));
});

test('teachers see only their own lessons; students use their link; parents can switch off the student’s own changes', async () => {
  const { h, auth, lesson, k, kid } = await world();
  const teacherAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  const teacher = (await h.ok('staff/me', { auth: teacherAuth })).me;
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-02', start: '09:00', staffId: teacher.id });
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-02', start: '11:00' });
  for (const l of lessonsOf(h)) await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  const seen = await h.ok('schedule/staff/range', { auth: teacherAuth });
  assert.deepEqual(seen.lessons.map(l => l.start), ['09:00']); assert.equal(seen.openRequests.length, 0);
  assert.equal((await h.call('schedule/lessons/create', { ...lesson, auth: teacherAuth, date: '2026-10-20' })).error.code, 'forbidden');
  const mine = lessonsOf(h).find(l => l.start === '09:00'), other = lessonsOf(h).find(l => l.start === '11:00');
  assert.equal((await h.ok('schedule/lessons/done', { auth: teacherAuth, id: mine.id, version: mine.version })).lesson.status, 'done');
  assert.equal((await h.call('schedule/lessons/done', { auth: teacherAuth, id: other.id, version: other.version })).error.code, 'forbidden');
  const st = await h.ok('student/schedule', { k });
  assert.equal(st.me.name, '架空 一郎'); assert.equal(st.lessons[0].staffId, undefined, '生徒には講師の ID を出さない');
  h.db2._sqlite.prepare('update students set permissions = ? where id = ?').run(JSON.stringify({ reschedule: false }), kid.id);
  assert.equal((await h.call('student/lessons/request', { k, lessonId: other.id, kind: 'move', note: 'x' })).error.code, 'forbidden');
  assert.equal((await h.ok('student/events/add', { k, kind: 'test', date: '2026-10-20', title: '中間テスト' })).event.kind, 'test');
});

test('after the switch-over, the calendar event id and Meet link are written back to the lesson', async () => {
  const { h, auth, lesson } = await world();
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', '')").run();
  await h.ok('schedule/lessons/create', { ...lesson, date: '2026-10-03', start: '10:00' });
  const l = lessonsOf(h)[0];
  await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  const marker = lessonsOf(h)[0].calendarEventId;
  assert.match(marker, /^swv2/);
  const { deliverEffects } = await import('../cf/v2/effects.mjs');
  const queued = h.rows("select id, payload from effects where kind = 'calendarCreate' and status = 'pending'").map(r => ({ id: r.id, item: JSON.parse(r.payload) }));
  assert.equal(queued.length, 1, '切り替え後は送る');
  await deliverEffects({ GAS_URL: 'https://gas.example.invalid', SYNC_KEY: 'x'.repeat(30) }, h.env.DB2, queued, async () => ({ ok: true, json: async () => ({ ok: true, writebacks: [{ marker, eventId: 'real-event@google.com', meetUrl: 'https://meet.example.invalid/abc' }] }) }));
  assert.deepEqual([lessonsOf(h)[0].calendarEventId, lessonsOf(h)[0].meetUrl], ['real-event@google.com', 'https://meet.example.invalid/abc']);
});

test('the schedule copy from the current ledger maps statuses, requests, shared events and days off', async () => {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30, deliveryMode) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500, 'online')");
  q("insert into familyAccounts (id, label, status, email) values ('A', '架空 一郎さんのグループ', 'pending', 'p@example.invalid')");
  q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1)");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode, kind, req) values ('a', '2026-09-20', '17:00', 60, 'booked', 's1', 'true', '数学', 'online', '', ''), ('b', '2026-10-09', '17:00', 60, 'booked', 's1', '', '数学', 'online', '', ?)", JSON.stringify({ kind: 'cancel', reason: '旅行', receivedAt: '2026-10-01T00:00:00Z', requestType: 'normal' }));
  q("insert into slots (id, date, start, min, status, studentId, subject, deliveryMode, confirmBy, changeReqAt, changeReqBy, changeReqKind, changeReqNote) values ('c', '2026-10-20', '18:00', 90, 'offered', 's1', '英語', 'in_person', '2026-10-05', '2026-10-02T01:00:00Z', 'parent', 'move', '21日に'), ('d', '2026-11-01', '18:00', 90, 'offered', 's1', '英語', '', 'hold', '', '', '', '')");
  q("insert into events (id, studentId, date, dateTo, title, kind) values ('e1', 's1', '2026-10-15', '2026-10-16', '中間テスト', 'test')");
  q("insert into blocked (id, studentId, date, note, start, end) values ('b1', 's1', '2026-10-12', '部活', '', '')");
  q("insert into teacherOff (id, date, note, start, end) values ('t1', '2026-10-13', '出張', '10:00', '12:00')");
  q("insert into lessonKinds (name, standardMin, standardFee, active, sortOrder) values ('講習', 120, 6000, 1, 2)");
  assert.equal((await h.call('admin/migrate/schedule/apply', { auth, confirm: true })).error.code, 'noStudents');
  await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  const pre = await h.ok('admin/migrate/schedule/preview', { auth });
  assert.deepEqual(pre.lessons, { total: 4, held: 1, proposed: 1, decided: 1, done: 1 });
  const done = await h.ok('admin/migrate/schedule/apply', { auth, confirm: true });
  assert.deepEqual([done.lessons, done.requests, done.sharedEvents, done.unavailability], [4, 2, 2, 1]);
  const rows = h.rows('select legacyId, status, confirmBy, deliveryMode, staffId from lessons order by date');
  assert.deepEqual(rows.map(r => [r.legacyId, r.status, r.confirmBy, r.deliveryMode]), [['a', 'done', '', 'online'], ['b', 'decided', '', 'online'], ['c', 'proposed', '2026-10-05', 'in_person'], ['d', 'held', '', 'online']]);
  assert.ok(rows.every(r => r.staffId), '担当は代表');
  assert.deepEqual(h.rows('select kind, fromKind from lessonRequests order by id').map(r => [r.kind, r.fromKind]), [['rest', 'student'], ['move', 'family']]);
  assert.deepEqual(h.rows('select kind from sharedEvents order by date').map(r => r.kind), ['unavailable', 'test']);
  assert.ok(h.rows('select name from lessonKinds').some(k => k.name === '講習'));
  await h.ok('admin/migrate/schedule/apply', { auth, confirm: true });
  assert.equal(h.rows('select count(*) n from lessons')[0].n, 4, '写し直しても増えない');
});

test('the same teacher may teach two in-person lessons at once (after a check), never three, and never with an online lesson', async () => {
  const { h, auth, fam, me, lesson } = await world();
  const kid2 = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '二郎', baseRate30: 1500 })).student;
  const kid3 = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '三郎', baseRate30: 1500 })).student;
  const face = { ...lesson, deliveryMode: 'in_person', date: '2026-10-09' };
  await h.ok('schedule/lessons/create', face);
  const second = await h.call('schedule/lessons/create', { ...face, studentId: kid2.id, start: '17:30' });
  assert.equal(second.error.code, 'needForce', '2人同時は確かめてから');
  assert.match(second.error.message, /2人同時/);
  await h.ok('schedule/lessons/create', { ...face, studentId: kid2.id, start: '17:30', force: true });
  assert.match((await h.call('schedule/lessons/create', { ...face, studentId: kid3.id, start: '17:45', force: true })).error.message, /2人まで/, '3人は重ねられない');
  await h.ok('schedule/lessons/create', { ...face, studentId: kid3.id, start: '18:00', force: true }); // 17:00〜18:00 とは重ならず、17:30〜18:30 とだけ重なる＝同時は2人
  // オンラインが入ると同時にはできない（新しく作るときも、あとで形式を変えるときも）
  await h.ok('schedule/lessons/create', { ...face, date: '2026-10-16' });
  assert.match((await h.call('schedule/lessons/create', { ...face, studentId: kid2.id, date: '2026-10-16', start: '17:30', deliveryMode: 'online', force: true })).error.message, /オンライン/);
  await h.ok('schedule/lessons/create', { ...face, studentId: kid2.id, date: '2026-10-16', start: '17:30', force: true });
  const l = h.rows("select * from lessons where studentId = ? and date = '2026-10-16'", kid2.id)[0];
  assert.match((await h.call('schedule/lessons/update', { auth, id: l.id, version: l.version, date: l.date, start: l.start, minutes: l.minutes, subject: l.subject, deliveryMode: 'online', staffId: me.id, force: true })).error.message, /オンライン/);
});
