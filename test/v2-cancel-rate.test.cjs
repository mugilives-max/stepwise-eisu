'use strict';
// 作り直し（v2）: 取消料の自動計算（規約案 第4〜7条、docs/CANCELLATION_POLICY_DESIGN.md 4）。
// assets/v2/cancel-rate.js（画面と共通の式）・cf/v2/plan-calc.mjs（setRateFee）・schedule.mjs（キャンセル・開始を遅らせる・遅刻）・billing.mjs（請求の内訳）
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createV2 } = require('./helpers/v2-harness.cjs');

const at = s => Date.parse(s + '+09:00');
const rateLib = () => import(pathToFileURL(path.join(__dirname, '..', 'assets', 'v2', 'cancel-rate.js')).href);

// 11月（新しい決まり）の 18:00〜19:30、90分・4,500円の授業
async function world() {
  const h = await createV2(); const auth = await h.owner(); h.clock = at('2026-10-20T09:00:00');
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const line = (await h.ok('billing/plans/save', { auth, studentId: kid.id, subject: '数学', kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: 8, minutes: 90, fee: 4500 })).line;
  const cur = h.rows('select * from planLines where id = ?', line.id)[0];
  await h.ok('billing/plans/consent', { auth, id: line.id, version: cur.version, consentDate: '2026-10-20', via: '保護者ページ' });
  const lesson = async (date, extra = {}) => {
    const keep = h.clock; h.clock = at('2026-10-20T09:00:00');
    await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date, start: '18:00', minutes: 90, subject: '数学', deliveryMode: 'in_person', force: true, ...extra });
    const l = h.rows('select * from lessons where studentId = ? and date = ? and start = ?', kid.id, date, extra.start || '18:00')[0];
    await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
    h.clock = keep;
    return h.rows('select * from lessons where id = ?', l.id)[0];
  };
  const get = id => h.rows('select * from lessons where id = ?', id)[0];
  const fee = id => { const f = h.rows('select * from cancellationFees where lessonId = ?', id)[0]; return f ? { ...f, parts: JSON.parse(f.parts) } : null; };
  return { h, auth, kid, parent, lesson, get, fee };
}

test('the rate: free until 23:00 the day before, 25% until 3 hours before, then up by the minute to 100% at the start', async () => {
  const { cancelRate, cancelAmount, ratePct } = await rateLib();
  const r = t => ratePct(cancelRate('2026-11-10', '18:00', at(t)));
  assert.deepEqual([r('2026-11-09T23:00:00'), r('2026-11-09T23:01:00'), r('2026-11-10T15:00:00'), r('2026-11-10T16:00:00'), r('2026-11-10T17:00:00'), r('2026-11-10T17:30:00'), r('2026-11-10T18:00:00'), r('2026-11-10T19:00:00')],
    [0, 25, 25, 50, 75, 87.5, 100, 100]);
  assert.equal(ratePct(cancelRate('2026-11-10', '18:00', null)), 100, '連絡なしは100%');
  assert.ok(cancelRate('2026-11-10', '18:00', at('2026-11-10T15:01:00')) > cancelRate('2026-11-10', '18:00', at('2026-11-10T15:00:00')), '3時間前を過ぎると1分ごとに上がる');
  // 例（規約案 別表1）: 90分・4,500円
  assert.deepEqual([180, 360, 540, 630, 720].map(x => cancelAmount(4500, 90, 90, x)), [1120, 2250, 3370, 3930, 4500], '10円未満は切り捨て');
  assert.equal(cancelAmount(4500, 90, 30, 540), 1120, '30分だけ取り消すと3分の1');
  assert.equal(cancelAmount(4500, 90, 30, 0), 0);
});

test('cancelling: a family cancel is priced at the time it arrives; staff record the time of a LINE notice or no notice; a notice before 23:00 is a rest', async () => {
  const { h, auth, parent, lesson, get, fee } = await world();
  const a = await lesson('2026-11-10'), b = await lesson('2026-11-11'), c = await lesson('2026-11-12');
  h.clock = at('2026-11-10T17:00:00');
  const r = await h.ok('family/lessons/request', { auth: parent, lessonId: a.id, kind: 'cancel', note: '部活が長引きます' });
  assert.equal(r.fee.amount, 3370, '開始1時間前は75%');
  let f = fee(a.id);
  assert.deepEqual([f.rule, f.decision, f.decidedBy, f.amount, f.baseFee, f.parts.length, f.parts[0].reason, f.parts[0].minutes], ['rate', 'charge', 'system:auto', 3370, 4500, 1, 'cancel', 90], '判断待ちにしない');
  assert.match(h.mails().at(-1).body, /キャンセル料 3,370円/, '教室にも金額を知らせる');
  const rq = h.rows("select id from lessonRequests where lessonId = ? and kind = 'cancel'", a.id)[0];
  await h.ok('family/lessons/withdraw', { auth: parent, requestId: rq.id });
  assert.equal(fee(a.id), null, '取り下げたら取消料も消える');
  // 教室が記録する: LINE で 11/11 17:30 に受けた連絡を、18:10 に記録
  h.clock = at('2026-11-11T18:10:00');
  assert.equal((await h.call('schedule/lessons/cancel', { auth, id: b.id, version: get(b.id).version, receivedAt: '2026-11-11T18:20' })).error.code, 'futureTime');
  assert.equal((await h.call('schedule/lessons/cancel', { auth, id: b.id, version: get(b.id).version, receivedAt: '2026-11-10T22:50' })).error.code, 'useRest', '前日23時までならお休み');
  const cb = await h.ok('schedule/lessons/cancel', { auth, id: b.id, version: get(b.id).version, receivedAt: '2026-11-11T17:30' });
  assert.equal(cb.fee.amount, 3930);
  assert.match(h.mails().at(-1).body, /キャンセル料は 3,930円です（17:30 にご連絡、率 87.5%）/);
  h.clock = at('2026-11-12T19:00:00');
  const cc = await h.ok('schedule/lessons/cancel', { auth, id: c.id, version: get(c.id).version, noNotice: true });
  assert.equal(cc.fee.amount, 4500, '連絡のない欠席は100%');
  assert.match(h.mails().at(-1).body, /ご連絡がなかったため率 100%/);
  assert.equal(fee(c.id).type, 'noshow');
});

test('a start delayed at the family request costs the delayed minutes at the rate of the request time; moving it again is measured from the first start', async () => {
  const { h, auth, parent, lesson, get, fee } = await world();
  const a = await lesson('2026-11-10');
  h.clock = at('2026-11-10T17:00:00');
  await h.ok('family/lessons/request', { auth: parent, lessonId: a.id, kind: 'late', note: '30分遅らせたいです' });
  h.clock = at('2026-11-10T17:20:00');
  const l = get(a.id);
  const u = await h.ok('schedule/lessons/update', { auth, id: l.id, version: l.version, date: l.date, start: '18:30', minutes: 90, subject: l.subject, kind: l.kind, deliveryMode: l.deliveryMode, staffId: l.staffId, lateStart: true });
  assert.equal(u.fee.amount, 1120, '連絡の 17:00（75%）で、30分ぶん');
  assert.deepEqual([fee(a.id).parts[0].reason, fee(a.id).parts[0].start, fee(a.id).parts[0].receivedAt], ['delay', '18:00', new Date(at('2026-11-10T17:00:00')).toISOString()]);
  assert.match(h.mails().at(-1).body, /開始を遅らせた分の取消料は 1,120円です/);
  const l2 = get(a.id);
  await h.ok('schedule/lessons/update', { auth, id: l2.id, version: l2.version, date: l2.date, start: '18:45', minutes: 90, subject: l2.subject, kind: l2.kind, deliveryMode: l2.deliveryMode, staffId: l2.staffId, lateStart: true });
  assert.deepEqual([fee(a.id).amount, fee(a.id).parts.length, fee(a.id).parts[0].minutes], [1680, 1, 45], '最初の 18:00 から45分');
  // 塾の都合で動かす（lateStart なし）なら取消料はかからない
  const b = await lesson('2026-11-11');
  h.clock = at('2026-11-11T12:00:00');
  const lb = get(b.id);
  const ub = await h.ok('schedule/lessons/update', { auth, id: lb.id, version: lb.version, date: lb.date, start: '18:30', minutes: 90, subject: lb.subject, kind: lb.kind, deliveryMode: lb.deliveryMode, staffId: lb.staffId });
  assert.equal(ub.fee, undefined); assert.equal(fee(b.id), null);
});

test('lateness: the lesson ends on time, the lost minutes leave the lesson fee and cost the rate of the notice; the bill shows both', async () => {
  const { h, auth, kid, lesson, get, fee } = await world();
  const a = await lesson('2026-11-10'), b = await lesson('2026-11-12');
  h.clock = at('2026-11-10T17:50:00');
  assert.equal((await h.call('schedule/lessons/tardy', { auth, id: a.id, version: get(a.id).version, lateMinutes: 30 })).error.code, 'notStarted');
  h.clock = at('2026-11-10T18:40:00');
  assert.equal((await h.call('schedule/lessons/tardy', { auth, id: a.id, version: get(a.id).version, lateMinutes: 90 })).error.code, 'badMinutes', '来なかったらキャンセル');
  const t = await h.ok('schedule/lessons/tardy', { auth, id: a.id, version: get(a.id).version, lateMinutes: 30, receivedAt: '2026-11-10T17:30' });
  assert.deepEqual([t.fee.amount, t.lesson.lostMinutes], [1310, 30], '17:30 の連絡（87.5%）');
  await h.ok('schedule/lessons/tardy', { auth, id: a.id, version: get(a.id).version, lateMinutes: 0 });
  assert.deepEqual([fee(a.id), get(a.id).lostMinutes], [null, 0], '0分で取り消し');
  await h.ok('schedule/lessons/tardy', { auth, id: a.id, version: get(a.id).version, lateMinutes: 30, receivedAt: '2026-11-10T17:30' });
  await h.ok('schedule/lessons/done', { auth, id: a.id, version: get(a.id).version });
  h.clock = at('2026-11-12T18:30:00');
  await h.ok('schedule/lessons/tardy', { auth, id: b.id, version: get(b.id).version, lateMinutes: 30, noNotice: true });
  await h.ok('schedule/lessons/done', { auth, id: b.id, version: get(b.id).version });
  h.clock = at('2026-12-02T12:00:00');
  const p = (await h.ok('billing/family', { auth, familyId: kid.familyId, month: '2026-11' })).preview;
  const items = p.students[0].items.map(i => [i.kind, i.amount, i.label]);
  assert.deepEqual(items, [['lesson', 3000, ''], ['cancelFee', 1310, '取消料（遅刻 30分）'], ['lesson', 3000, ''], ['cancelFee', 1500, '取消料（遅刻 30分）']], '連絡なしに30分遅れると合計は予定どおりの 4,500円');
  assert.deepEqual([p.total, p.canConfirm], [3000 + 1310 + 3000 + 1500, true]);
});

test('lessons before the start date of the new rule keep the old fees, and teachers record lateness only for their own lessons', async () => {
  const { h, auth, parent, lesson, get, fee } = await world();
  const old = await lesson('2026-10-28');
  h.clock = at('2026-10-28T17:00:00');
  await h.ok('family/lessons/request', { auth: parent, lessonId: old.id, kind: 'cancel', note: '熱が出ました' });
  assert.deepEqual([fee(old.id).rule, fee(old.id).standardAmount, fee(old.id).decision], ['', 1000, 'pending'], '10月の授業は今までどおり');
  const old2 = await lesson('2026-10-29');
  h.clock = at('2026-10-29T18:30:00');
  assert.equal((await h.call('schedule/lessons/tardy', { auth, id: old2.id, version: get(old2.id).version, lateMinutes: 10 })).error.code, 'oldRule');
  // 講師: 自分の担当だけ
  const teacherAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  const teacher = (await h.ok('staff/me', { auth: teacherAuth })).me;
  const mine = await lesson('2026-11-10', { staffId: teacher.id }), other = await lesson('2026-11-10', { start: '20:00' });
  h.clock = at('2026-11-10T20:30:00');
  assert.equal((await h.call('schedule/lessons/tardy', { auth: teacherAuth, id: other.id, version: get(other.id).version, lateMinutes: 10 })).error.code, 'forbidden');
  await h.ok('schedule/lessons/tardy', { auth: teacherAuth, id: mine.id, version: get(mine.id).version, lateMinutes: 10, noNotice: true });
  assert.equal(fee(mine.id).amount, 500);
});
