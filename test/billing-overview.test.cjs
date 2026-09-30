'use strict';
// 管理画面「請求」の一覧（billingOverview）。金額と請求可否は billingPreview_ と同じもので、
// ここでは「どの状態の名前で、どの順に並ぶか」と「読み取りだけであること」を確かめる。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');

const FAMILY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
function fixture() {
  const h = createBillingHarness(), c = h.context();
  c.ensureFamilySchema_();
  const a = { id: FAMILY, label: '【テスト】家族', status: 'active', email: 'parent@example.invalid', verifiedAt: '2026-09-01', passHash: 'fixture' };
  c.familySave_(a); c.familySetChildren_(a, ['test-a', 'test-b']);
  return { h, a };
}
function plan(h, studentId) {
  return ok(h.admin('planLineSave', { studentId, subject: '数学', kind: '通常', count: 1, startDate: '2026-09-01', endDate: '2026-09-30', lessonMin: 60, lessonFee: 3000, propose: true })).line;
}
const approve = (h, studentId, line) => ok(h.admin('planLineApproveTeacher', { studentId, lineId: line.id, expectedRevision: line.revision, via: '電話', consentDate: '2026-09-07', memo: '架空の承認' }));
const overview = (h, ym = '2026-09') => ok(h.admin('billingOverview', { ym })).overview;
const row = (o, id) => o.rows.find(r => r.studentId === id);
const toOctober = h => h.advance(Date.parse('2026-10-01T09:00:00+09:00') - h.now());

test('the overview names each student\'s month state and follows it from open to paid', () => {
  const { h, a } = fixture();
  approve(h, 'test-a', plan(h, 'test-a')); const waiting = plan(h, 'test-b');
  for (const id of ['test-a', 'test-b']) h.seedSlot({ studentId: id, date: '2026-09-05', status: 'booked', done: true, min: 60, subject: '数学', kind: '通常' });
  const before = JSON.stringify([h.rows('slots'), h.payments(), h.rows('approvalEvents').length]);

  let o = overview(h);
  assert.equal(o.closed, false);
  assert.deepEqual(o.rows.map(r => [r.studentId, r.state]), [['test-a', 'open'], ['test-b', 'open']], 'only students with lessons in the month are listed');
  assert.equal(row(o, 'test-a').amount, 3000); assert.equal(row(o, 'test-a').summary, '数学 1回');
  assert.equal(row(o, 'test-b').amount, 0); assert.equal(row(o, 'test-b').pendingAmount, 3000);
  assert.deepEqual(JSON.parse(JSON.stringify(o.totals)), { billed: 0, paid: 0, unpaid: 0, open: 3000, pending: 3000 });

  toOctober(h); o = overview(h);
  assert.equal(o.closed, true);
  assert.deepEqual(o.rows.map(r => [r.studentId, r.state]), [['test-a', 'ready'], ['test-b', 'needApproval']], 'what the teacher can act on comes first');
  assert.match(row(o, 'test-b').note, /1件が授業計画の承認待ち/);
  assert.equal(JSON.stringify([h.rows('slots'), h.payments(), h.rows('approvalEvents').length]), before, 'reading the overview writes nothing');

  ok(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', amount: row(o, 'test-a').amount, requestId: 'overview-issue-a' }));
  o = overview(h);
  assert.equal(row(o, 'test-a').state, 'unpaid'); assert.ok(row(o, 'test-a').invoice.id); assert.equal(row(o, 'test-a').invoice.paymentRevision, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(o.totals)), { billed: 3000, paid: 0, unpaid: 3000, open: 0, pending: 3000 });
  assert.deepEqual(o.rows.map(r => r.studentId), ['test-b', 'test-a'], 'an unpaid invoice waits below the rows that need the teacher');

  approve(h, 'test-b', waiting); o = overview(h);
  assert.equal(row(o, 'test-b').state, 'ready');
  ok(h.admin('kanriAddPayment', { studentId: 'test-b', ym: '2026-09', amount: 3000, requestId: 'overview-issue-b' }));

  const c = h.context(), m = c.familyBilling_(a, false)[0], ftoken = c.familyIssueSession_(a).ftoken;
  ok(h.request({ action: 'familyReportTransfer', ftoken, ym: '2026-09', signature: m.signature }));
  o = overview(h);
  assert.deepEqual(o.rows.map(r => r.state), ['reported', 'reported']);
  assert.equal(row(o, 'test-a').familyId, FAMILY); assert.equal(row(o, 'test-a').signature, m.signature);
  assert.equal(o.totals.unpaid, 6000, 'a transfer report is not a payment yet');

  ok(h.admin('familyConfirmTransfer', { familyId: row(o, 'test-a').familyId, ym: '2026-09', signature: row(o, 'test-a').signature }));
  o = overview(h);
  assert.deepEqual(o.rows.map(r => r.state), ['paid', 'paid']);
  assert.match(row(o, 'test-a').note, /振込/);
  assert.deepEqual(JSON.parse(JSON.stringify(o.totals)), { billed: 6000, paid: 6000, unpaid: 0, open: 0, pending: 0 });
});

test('a closed month with an unrecorded lesson asks for the lesson first, and the overview is teacher-only', () => {
  const { h } = fixture();
  approve(h, 'test-a', plan(h, 'test-a'));
  h.seedSlot({ studentId: 'test-a', date: '2026-09-05', status: 'booked', done: true, min: 60, subject: '数学', kind: '通常' });
  h.seedSlot({ studentId: 'test-a', date: '2026-09-20', status: 'booked', done: false, min: 60, subject: '数学', kind: '通常' });
  let o = overview(h);
  assert.equal(row(o, 'test-a').state, 'open'); assert.match(row(o, 'test-a').note, /実施 1回・これから 1回/);
  toOctober(h); o = overview(h);
  assert.equal(row(o, 'test-a').state, 'needDone'); assert.match(row(o, 'test-a').note, /1件の授業が実施未登録/);
  assert.equal(o.rows.length, 1, 'students without lessons or invoices in the month are left out');
  assert.equal(overview(h, '2026-08').rows.length, 0);

  assert.ok(h.admin('billingOverview', { ym: '2026-9' }).error, 'the month must be YYYY-MM');
  const anonymous = h.request({ action: 'admin', op: 'billingOverview', ym: '2026-09' });
  assert.ok(anonymous.error); assert.equal(anonymous.overview, undefined);
});

test('the Worker serves the overview as a read', () => {
  const read = fs.readFileSync(path.join(__dirname, '..', 'cf', 'worker', 'read.mjs'), 'utf8');
  assert.match(read, /billingOverview: \(gas, req\) => gas\.billingOverview_\(String\(req\.ym \|\| ''\)\)/);
});
