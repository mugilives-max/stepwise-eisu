'use strict';
// 作り直し（v2）: スタッフの「月の仕事」（請求・翌月の計画と予定表・報酬の進み具合）。cf/v2/monthly.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test('the monthly overview counts what is done and what is left for billing, next month\'s plans and schedule, and pay', async () => {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const a = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const b = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  // 11月: 一郎は計画（下書き）と仮予定、花子は何もない
  await h.ok('billing/plans/save', { auth, studentId: a.id, subject: '数学', kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: 4, minutes: 60, fee: 3000 });
  await h.ok('schedule/lessons/create', { auth, studentId: a.id, date: '2026-11-04', start: '17:00', minutes: 60, subject: '数学', deliveryMode: 'in_person', force: true, hold: true });
  const m = await h.ok('monthly/overview', { auth });
  assert.equal(m.now, 'billing', '10/2 は請求を確かめる時期（1〜2日）');
  assert.deepEqual([m.planning.month, m.planning.draft, m.planning.none.map(s => s.name)], ['2026-11', 1, ['架空 花子']]);
  assert.deepEqual([m.schedule.held.map(s => [s.name, s.n]), m.schedule.none.map(s => s.name)], [[['架空 一郎', 1]], ['架空 花子']]);
  assert.equal(m.billing.month, '2026-09');
  assert.equal(m.payroll.month, '2026-09');
  const tAuth = await h.staffWith(auth, ['teacher'], 't@example.invalid');
  assert.equal((await h.call('monthly/overview', { auth: tAuth })).error.code, 'forbidden', '講師には出さない');
  assert.ok(b);
});
