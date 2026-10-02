'use strict';
// 作り直し（v2）7段目: 講師の報酬（業務委託・月末締め・翌月25日払い）。cf/v2/payroll.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

const at = s => Date.parse(s + '+09:00');
async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const tAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid'), t = (await h.ok('staff/me', { auth: tAuth })).me;
  const uAuth = await h.staffWith(auth, ['teacher'], 'other@example.invalid'), u = (await h.ok('staff/me', { auth: uAuth })).me;
  // 9/1 の時点で授業を作って決定する
  const lesson = async (date, start, staffId, minutes = 90) => {
    const keep = h.clock; h.clock = at('2026-09-01T09:00:00');
    await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date, start, minutes, subject: '数学', deliveryMode: 'in_person', staffId, force: true });
    const l = h.rows('select * from lessons where date = ? and start = ?', date, start)[0];
    await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
    h.clock = keep; return l.id;
  };
  const done = async id => { const l = h.rows('select * from lessons where id = ?', id)[0]; await h.ok('schedule/lessons/done', { auth, id, version: l.version }); };
  return { h, auth, fam, kid, tAuth, t, uAuth, u, lesson, done };
}

test('the month statement counts done lessons and past meetings at each instructor\'s rates, rounding each line down', async () => {
  const { h, auth, fam, kid, tAuth, t, u, lesson, done } = await world();
  const a = await lesson('2026-09-08', '17:00', t.id), b = await lesson('2026-09-15', '17:00', t.id, 45), sub = await lesson('2026-09-22', '17:00', u.id);
  h.clock = at('2026-09-01T09:00:00');
  await h.ok('schedule/meetings/create', { auth, familyId: fam.id, studentId: kid.id, staffId: t.id, date: '2026-09-20', start: '10:00', minutes: 30, title: '三者面談' });
  h.clock = at('2026-10-02T12:00:00');
  await done(a); await done(b);
  let m = await h.ok('payroll/month', { auth, month: '2026-09' });
  assert.match(m.staff.find(s => s.staffId === t.id).preview.issues.join(), /時給が決まっていません/);
  assert.equal(m.payOn, '2026-10-25', '翌月25日払い');
  await h.ok('payroll/rates/save', { auth, staffId: t.id, startsOn: '2026-09', lessonHourly: 1555, meetingHourly: 1500 });
  await h.ok('payroll/rates/save', { auth, staffId: u.id, startsOn: '2026-09', lessonHourly: 1400, meetingHourly: 1500 });
  const v = (await h.ok('payroll/staff', { auth, staffId: t.id, month: '2026-09' })).preview;
  assert.deepEqual(v.items.map(i => [i.kind, i.minutes, i.rate, i.amount]), [['lesson', 90, 1555, 2332], ['lesson', 45, 1555, 1166], ['meeting', 30, 1500, 750]], '1円未満は行ごとに切り捨て');
  assert.deepEqual([v.lessonMinutes, v.meetingMinutes, v.gross, v.withholding, v.net], [135, 30, 4248, 0, 4248]);
  const other = (await h.ok('payroll/staff', { auth, staffId: u.id, month: '2026-09' })).preview;
  assert.match(other.issues.join(), /実施済みになっていません/, '代講の講師の授業も、実施済みにしないと確定できない');
  assert.equal((await h.call('payroll/confirm', { auth, staffId: u.id, month: '2026-09' })).error.code, 'notReady');
  await done(sub);
  // 源泉徴収をする講師
  const tu = h.rows('select version from staff where id = ?', u.id)[0];
  await h.ok('payroll/withholding', { auth, staffId: u.id, version: tu.version, withholding: true });
  const ov = (await h.ok('payroll/staff', { auth, staffId: u.id, month: '2026-09' })).preview;
  assert.deepEqual([ov.gross, ov.withholding, ov.net], [2100, 214, 1886], '10.21% を切り捨て');
  assert.equal((await h.call('payroll/month', { auth: tAuth, month: '2026-09' })).error.code, 'forbidden', '講師はほかの講師の報酬を見られない');
  assert.ok(sub);
});

test('confirming fixes the statement; corrections void it with a reason; instructors see only their own; later lessons go to the next statement', async () => {
  const { h, auth, tAuth, t, uAuth, lesson, done } = await world();
  const a = await lesson('2026-09-08', '17:00', t.id), late = await lesson('2026-09-29', '17:00', t.id);
  await h.ok('payroll/rates/save', { auth, staffId: t.id, startsOn: '2026-09', lessonHourly: 1500, meetingHourly: 1500 });
  h.clock = at('2026-09-30T20:00:00');
  await done(a);
  assert.equal((await h.call('payroll/confirm', { auth, staffId: t.id, month: '2026-09' })).error.code, 'tooEarly', '月末締め');
  h.clock = at('2026-10-02T12:00:00');
  await h.ok('payroll/adjust/add', { auth, staffId: t.id, month: '2026-09', label: '研修 1時間', amount: 1500 });
  // 9/29 の授業をまだ実施済みにしていないので確定できない。実施済みにしてから確定する
  assert.equal((await h.call('payroll/confirm', { auth, staffId: t.id, month: '2026-09' })).error.code, 'notReady');
  await done(late);
  const before = h.mails().length;
  const p = (await h.ok('payroll/confirm', { auth, staffId: t.id, month: '2026-09', expectedNet: 2250 + 2250 + 1500 })).payroll;
  assert.deepEqual([p.status, p.gross, p.items.length, p.payOn], ['confirmed', 6000, 3, '2026-10-25']);
  assert.match(h.mails().slice(before).map(m => m.subject).join(), /9月分の支払明細/);
  assert.equal((await h.call('payroll/rates/save', { auth, staffId: t.id, startsOn: '2026-09', lessonHourly: 1600, meetingHourly: 1500 })).error.code, 'confirmed', '確定した月の時給は変えない');
  // 講師: 自分の明細だけ
  const mine = await h.ok('payroll/mine', { auth: tAuth });
  assert.deepEqual([mine.statements.length, mine.statements[0].net], [1, 6000]);
  assert.equal((await h.ok('payroll/mine', { auth: uAuth })).statements.length, 0);
  assert.equal((await h.ok('payroll/mine', { auth })).owner, true, '代表は報酬の明細を持たない');
  // 訂正: 取り消して確定し直す
  assert.equal((await h.call('payroll/void', { auth, id: p.id, version: p.version })).error.code, 'needReason');
  await h.ok('payroll/void', { auth, id: p.id, version: p.version, reason: '調整の金額の誤り' });
  assert.equal(h.rows("select count(*) n from lessons where payrollId <> ''")[0].n, 0, '取り消すと授業は明細の前に戻る');
  const adj = h.rows('select id from payrollAdjustments')[0].id;
  await h.ok('payroll/adjust/delete', { auth, id: adj });
  const p2 = (await h.ok('payroll/confirm', { auth, staffId: t.id, month: '2026-09' })).payroll;
  assert.equal(p2.gross, 4500);
  assert.deepEqual(h.rows('select status, voidReason from payrollMonths order by createdAt').map(r => [r.status, r.voidReason]), [['void', '調整の金額の誤り'], ['confirmed', '']], '取り消した明細も記録に残る');
  await h.ok('payroll/paid', { auth, id: p2.id, version: p2.version, paidOn: '2026-10-02' });
  assert.equal((await h.call('payroll/void', { auth, id: p2.id, version: p2.version + 1, reason: 'x' })).error.code, 'paid');
  // 確定のあとで実施済みになった前の月の授業は、次の月の明細に入る
  const after = await lesson('2026-09-30', '17:00', t.id);
  await done(after);
  const oct = (await h.ok('payroll/staff', { auth, staffId: t.id, month: '2026-10' })).preview;
  assert.deepEqual(oct.items.map(i => [i.date, i.carried]), [['2026-09-30', true]]);
});

test('two lessons at once are paid by the time worked, not per student', async () => {
  const { h, auth, fam, t, lesson, done } = await world();
  const kid2 = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  const a = await lesson('2026-09-08', '17:00', t.id, 60);
  // 2人目: 17:30〜18:30（同じ講師・対面の2人同時）
  const keep = h.clock; h.clock = at('2026-09-01T09:00:00');
  await h.ok('schedule/lessons/create', { auth, studentId: kid2.id, date: '2026-09-08', start: '17:30', minutes: 60, subject: '英語', deliveryMode: 'in_person', staffId: t.id, force: true });
  const b = h.rows('select * from lessons where studentId = ?', kid2.id)[0];
  await h.ok('schedule/lessons/decide', { auth, id: b.id, version: b.version }); h.clock = keep;
  const c = await lesson('2026-09-15', '17:00', t.id, 60);
  h.clock = at('2026-10-02T12:00:00');
  await done(a); await done(b.id); await done(c);
  await h.ok('payroll/rates/save', { auth, staffId: t.id, startsOn: '2026-09', lessonHourly: 2000, meetingHourly: 1500 });
  const v = (await h.ok('payroll/staff', { auth, staffId: t.id, month: '2026-09' })).preview;
  assert.deepEqual(v.items.map(i => [i.date, i.minutes, i.amount]), [['2026-09-08', 60, 2000], ['2026-09-08', 30, 1000], ['2026-09-15', 60, 2000]], '重なる30分は1回だけ');
  assert.match(v.items[1].label, /重なる30分を除く/);
  assert.deepEqual([v.lessonMinutes, v.gross], [150, 5000]);
  await h.ok('payroll/confirm', { auth, staffId: t.id, month: '2026-09', expectedNet: v.net });
  assert.equal(h.rows("select count(*) n from lessons where payrollId <> ''")[0].n, 3, '同時の授業も明細に入る（もう一度数えない）');
});
