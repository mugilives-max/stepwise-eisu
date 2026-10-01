'use strict';
// 日程の決め方（段階1、2026-10-01）: 仮予定の締め切り、予定表の送信、変更・お休みの連絡、締め切りでの自動決定。
// 設計は docs/SCHEDULING_FLOW_DESIGN.md。時計は 2026-09-07 13:00（日本時間）から始まる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const at = (h, iso) => h.advance(Date.parse(iso) - h.now());
const slotOf = (h, date, start = '16:00') => h.rows('slots').find(s => s.date === date && s.start === start);
const studentSlots = h => h.get({ action: 'state', k: 'synthetic-link-a' }).slots;
const lessonChange = (h, slotId, args) => h.request({ action: 'lessonChange', k: 'synthetic-link-a', slotId, ...args });

test('a lesson sent now gets a deadline: 3 days later, or the 25th for next month, never later than 2 days before the lesson', () => {
  const h = createSchedulingHarness();
  ok(h.offer({ date: '2026-09-15' })); ok(h.offer({ date: '2026-10-06' })); ok(h.offer({ date: '2026-09-11' })); ok(h.offer({ date: '2026-09-08' }));
  assert.equal(slotOf(h, '2026-09-15').confirmBy, '2026-09-10', '送った日の3日後');
  assert.equal(slotOf(h, '2026-10-06').confirmBy, '2026-09-25', '翌月の授業は今月25日');
  assert.equal(slotOf(h, '2026-09-11').confirmBy, '2026-09-09', '授業の2日前まで');
  assert.equal(slotOf(h, '2026-09-08').confirmBy, '', '明日の授業は締め切りなし（先生が直接決定する）');
  const mine = studentSlots(h).find(s => s.date === '2026-09-15');
  assert.equal(mine.confirmBy, '2026-09-10'); assert.equal(mine.change, null);
  assert.ok(h.offer({ date: '2026-09-20', confirmBy: '2026-09-01' }).error, '過去の締め切りは選べない');
  ok(h.offer({ date: '2026-09-22', confirmBy: '2026-09-12' })); assert.equal(slotOf(h, '2026-09-22').confirmBy, '2026-09-12');
});

test('held lessons stay hidden until the schedule is sent once, with one deadline for all', () => {
  const h = createSchedulingHarness();
  const held = ok(h.offer({ date: '2026-10-06', hold: true }));
  assert.equal(held.held, true); ok(h.offer({ date: '2026-10-13', hold: true }));
  assert.equal(slotOf(h, '2026-10-06').confirmBy, 'hold');
  assert.equal(studentSlots(h).length, 0, '未送信の仮予定は生徒に見せない');
  assert.ok(h.accept(slotOf(h, '2026-10-06').id).error, '未送信の仮予定は生徒が決定できない');
  assert.equal(h.rows('studentEmailOutbox').length, 0, '未送信のあいだはメールを記録しない');
  const sent = ok(h.admin('scheduleSend', { studentId: 'test-a', requestId: 'schedule-send-0001' }));
  assert.equal(sent.sent, 2);
  assert.deepEqual(studentSlots(h).map(s => s.confirmBy), ['2026-09-25', '2026-09-25']);
  const out = h.rows('studentEmailOutbox').filter(o => o.kind === 'schedule');
  assert.equal(out.length, 1, '予定表のメールは1回');
  assert.equal(ok(h.admin('scheduleSend', { studentId: 'test-a', requestId: 'schedule-send-0002' })).sent, 0, '送るものがなければ何もしない');
});

test('the schedule mail lists the lessons and says when they will be decided', () => {
  const h = createSchedulingHarness(), c = h.context();
  const one = c.studentEmailBusinessBody_({ kind: 'schedule', snapshotJson: JSON.stringify([
    { id: 'a', date: '2026-10-06', start: '16:00', min: 60, subject: '数学', deliveryMode: 'in_person', confirmBy: '2026-09-25' },
    { id: 'b', date: '2026-10-13', start: '16:00', min: 60, subject: '数学', deliveryMode: 'online', confirmBy: '2026-09-25' }]) });
  assert.equal(one.subject, '【ステップワイズ】10月の授業予定表が届いています');
  assert.match(one.body, /^10月の授業予定表が届いています。\n\n・2026-10-06 16:00〜17:00 数学（対面）\n・2026-10-13 16:00〜17:00 数学（オンライン）\n\n9\/25までに連絡がなければ、この日時で決定します。変更がなければ返事は不要です。/);
  const decided = c.studentEmailBusinessBody_({ kind: 'confirmed', snapshotJson: JSON.stringify([{ id: 'a', date: '2026-10-06', start: '16:00', min: 60, subject: '数学', deliveryMode: 'in_person' }]) });
  assert.equal(decided.subject, '【ステップワイズ】10月の授業予定日が決定しました');
  assert.match(decided.body, /^10月の授業予定日が決定しました。変更する場合は前日の23時までにお申し付けください。/);
  const family = c.familyBusinessMail_({ kind: 'scheduleConfirmed', ym: '2026-10' });
  assert.match(family.body, /^10月の授業予定日が決定しました。変更する場合は前日の23時までにお申し付けください。/);
});

test('a date-change request is kept on the lesson, stops the automatic decision, and clears when the teacher edits the time', () => {
  const h = createSchedulingHarness();
  ok(h.offer({ date: '2026-09-15' })); ok(h.offer({ date: '2026-09-16' }));
  const a = slotOf(h, '2026-09-15'), b = slotOf(h, '2026-09-16');
  assert.ok(lessonChange(h, a.id, { kind: 'move', note: '' }).error, '一言は必須');
  ok(lessonChange(h, a.id, { kind: 'move', note: '17日の同じ時間だと助かります' }));
  ok(lessonChange(h, a.id, { kind: 'move', note: '17日の同じ時間だと助かります' }));
  const mine = studentSlots(h).find(s => s.id === a.id);
  assert.deepEqual([mine.change.kind, mine.change.by, mine.change.note], ['move', 'student', '17日の同じ時間だと助かります']);
  const dash = ok(h.admin('state')).admin;
  at(h, '2026-09-11T00:10:00+09:00');
  const done = h.context().scheduleAutoConfirm_();
  assert.equal(done.confirmed, 1, 'お願いのない方だけ決定する');
  assert.equal(slotOf(h, '2026-09-16').status, 'booked'); assert.equal(slotOf(h, '2026-09-15').status, 'offered');
  const edit = h.admin('editOffered', { studentId: 'test-a', slotId: a.id, requestId: 'edit-move-0001', date: '2026-09-17', start: '16:00', min: 60, subject: '数学', deliveryMode: 'in_person', expectedSnapshot: h.snapshot(a.id) });
  assert.equal(edit.error, undefined, JSON.stringify(edit));
  assert.equal(h.rows('slots').find(s => s.id === a.id).changeReqAt, '', '日時を直したらお願いは済み');
  assert.ok(dash);
});

test('booked lessons: a date change only until 23:00 the day before, then "start later" until the start; withdrawing clears it', () => {
  const h = createSchedulingHarness();
  const s = h.seedSlot({ date: '2026-09-10', start: '18:00', status: 'booked' });
  ok(lessonChange(h, s.id, { kind: 'move', note: '別の日にしたいです' }));
  ok(lessonChange(h, s.id, { withdraw: true }));
  assert.equal(h.rows('slots').find(x => x.id === s.id).changeReqAt, '');
  assert.ok(lessonChange(h, s.id, { kind: 'late', note: '30分' }).error, '前日23時より前は「開始を遅らせたい」は出せない');
  at(h, '2026-09-09T23:30:00+09:00');
  const late = lessonChange(h, s.id, { kind: 'move', note: '別の日' });
  assert.equal(late.errorCode, 'late');
  ok(lessonChange(h, s.id, { kind: 'late', note: '部活で30分遅れます' }));
  assert.equal(h.rows('slots').find(x => x.id === s.id).changeReqKind, 'late');
  at(h, '2026-09-10T18:05:00+09:00');
  assert.ok(lessonChange(h, s.id, { kind: 'late', note: 'x' }).error, '開始後は送れない');
});

test('the nightly decision books lessons past their deadline once, leaves held and undated ones, and records one notice per student', () => {
  const h = createSchedulingHarness();
  ok(h.offer({ date: '2026-09-15' })); ok(h.offer({ date: '2026-09-17' })); ok(h.offer({ date: '2026-09-18', hold: true }));
  h.seedSlot({ date: '2026-09-19' }); // この仕組みより前の案内（締め切りなし）
  at(h, '2026-09-10T23:59:00+09:00');
  assert.equal(h.context().scheduleAutoConfirm_().confirmed, 0, '締め切りの日のうちは決定しない');
  at(h, '2026-09-11T00:10:00+09:00');
  const r = h.context().scheduleAutoConfirm_();
  assert.deepEqual([r.confirmed, r.students, r.failed], [2, 1, 0]);
  assert.deepEqual(['2026-09-15', '2026-09-17', '2026-09-18', '2026-09-19'].map(d => slotOf(h, d).status), ['booked', 'booked', 'offered', 'offered']);
  assert.equal(h.rows('studentEmailOutbox').filter(o => o.kind === 'confirmed').length, 1);
  assert.equal(h.context().scheduleAutoConfirm_().confirmed, 0, '二度は決定しない');
  // 決定は先生の直接決定と同じ記録（acceptWrites）を残す。テストの生徒はカレンダーに予定を作らない
  assert.equal(h.rows('acceptWrites').filter(w => String(w.requestId).startsWith('auto-') && w.status === 'done').length, 2);
});

test('parents can ask for a date change for their child; the teacher can clear a request without editing', () => {
  const h = createSchedulingHarness();
  ok(h.offer({ date: '2026-09-15' })); const a = slotOf(h, '2026-09-15');
  ok(h.request({ action: 'lessonChange', k: 'synthetic-link-a', slotId: a.id, kind: 'move', note: '家の用事', familyProxy: true }));
  ok(h.admin('scheduleChangeClear', { studentId: 'test-a', slotId: a.id }));
  assert.equal(h.rows('slots').find(s => s.id === a.id).changeReqAt, '');
  assert.ok(h.admin('scheduleChangeClear', { studentId: 'test-b', slotId: a.id }).error, 'ほかの生徒の授業は触れない');
});

test('teacher mail kinds follow the new words', () => {
  const c = createSchedulingHarness().context();
  assert.equal(c.teacherMailKind_('【お休みの連絡】架空'), 'cancelRequest');
  assert.equal(c.teacherMailKind_('【キャンセル】架空'), 'cancelRequest');
  assert.equal(c.teacherMailKind_('【日時の変更のお願い】架空'), 'changeRequest');
  assert.equal(c.teacherMailKind_('【開始を遅らせたい】架空'), 'changeRequest');
  assert.equal(c.teacherMailKind_('【お願いの取り下げ】架空'), 'cancelWithdrawn');
  assert.equal(TEACHER_TOKEN.length > 0, true);
});

// Worker（D1）で毎日0時10分に動く形。決定した授業のカレンダーの予定とお知らせのメールが付随処理として出る
test('the Worker nightly run decides on D1 and queues the calendar event', async () => {
  const { createParity } = require('./helpers/parity-harness.cjs');
  const h = createSchedulingHarness();
  h.setRow('students', 'id', 'test-a', { name: '見本の生徒' });
  h.setRow('config', 'key', 'calendarSync', { value: 'on' });
  ok(h.offer({ date: '2026-09-15' }));
  const p = await createParity(h);
  const { runWrite } = await import('../cf/worker/write.mjs');
  const { books } = await import('../cf/lib/sheet-view.mjs');
  const env = { DB: p.d1, NL_ENABLED: '0' };
  try {
    let done = await runWrite({}, env, { autoConfirm: true, now: Date.parse('2026-09-10T00:10:00+09:00') });
    assert.equal(done.result.confirmed, 0, '締め切りの日はまだ');
    done = await runWrite({}, env, { autoConfirm: true, now: Date.parse('2026-09-11T00:10:00+09:00') });
    assert.equal(done.result.confirmed, 1, JSON.stringify(done.result));
    assert.ok(done.effects.some(e => e.kind === 'calendarCreate'), 'カレンダーの予定を Apps Script に頼む');
    const slots = (await books(p.d1)).app.slots, head = slots[0];
    assert.equal(slots[1][head.indexOf('status')], 'booked');
    assert.equal(slots[1][head.indexOf('confirmBy')], '2026-09-10');
    done = await runWrite({}, env, { autoConfirm: true, now: Date.parse('2026-09-12T00:10:00+09:00') });
    assert.equal(done.result.confirmed, 0, '翌日は何もしない');
  } finally { p.d1._sqlite.close(); }
});
