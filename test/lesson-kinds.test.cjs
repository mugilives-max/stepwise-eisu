'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const { MCP_KEY } = require('./gas-harness.cjs');
const json = v => JSON.parse(JSON.stringify(v));
function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function rejected(r) { assert.ok(r && r.error, JSON.stringify(r)); return r; }
const rev = (h, ym = '2026-09') => h.admin('billingPreview', { studentId: 'test-a', ym }).billing.revision;

test('lesson kinds: fixed master with 通常 built in, name rules, and deactivation', () => {
  const h = createSchedulingHarness(); ok(h.admin('state'));
  assert.deepEqual(json(ok(h.admin('lessonKinds')).lessonKinds), [{ name: '通常', standardMin: null, standardFee: null, active: true }]);
  rejected(h.admin('lessonKindSave', { name: '演習（旧）' })); rejected(h.admin('lessonKindSave', { name: '通常', active: false }));
  rejected(h.admin('lessonKindSave', { name: '演習', standardMin: 20 })); rejected(h.admin('lessonKindSave', { name: '演習', standardFee: -1 }));
  const saved = ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60, standardFee: 4000 })); assert.ok(saved.admin && saved.admin.lessonKinds);
  ok(h.admin('lessonKindSave', { name: '講習', standardMin: '90', standardFee: '' }));
  ok(h.admin('lessonKindSave', { name: '講習', standardMin: 90, active: false }));
  ok(h.admin('lessonKindSave', { name: '通常', standardMin: 90, standardFee: 6000 }));
  assert.deepEqual(json(ok(h.admin('lessonKinds')).lessonKinds), [
    { name: '通常', standardMin: 90, standardFee: 6000, active: true },
    { name: '演習', standardMin: 60, standardFee: 4000, active: true },
    { name: '講習', standardMin: 90, standardFee: null, active: false }
  ]);
  assert.equal(h.rows('lessonKinds').length, 3);
});

test('plans and offers carry the kind; 通常 stays out of the approval JSON so existing approvals remain current', () => {
  const h = createSchedulingHarness(); ok(h.admin('state'));
  ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60 })); ok(h.admin('lessonKindSave', { name: '講習', active: false }));
  ok(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', count: 4 }));
  rejected(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', kind: '講習', count: 1, expectedRevision: rev(h) }));
  rejected(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', kind: 'なにか', count: 1, expectedRevision: rev(h) }));
  ok(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', kind: '演習', count: 2, expectedRevision: rev(h) }));
  ok(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', kind: '通常', count: 3, expectedRevision: rev(h) }));
  const c = h.context();
  assert.deepEqual(json(c.billingPlanList_('test-a', '2026-09')), [{ subject: '英語', count: 3 }, { subject: '英語', count: 2, kind: '演習' }]);
  assert.deepEqual(json(c.planFor_('test-a', '2026-09').plan), { '英語': 3, '英語（演習）': 2 });
  assert.deepEqual(json(c.planFor_('test-a', '2026-09').rows), [{ subject: '英語', kind: '', count: 3 }, { subject: '英語', kind: '演習', count: 2 }]);
  ok(h.admin('planPropose', { studentId: 'test-a', ym: '2026-09', rate30: 1500, monthly: 0, expectedRevision: rev(h) }));
  ok(h.admin('planApproveTeacher', { studentId: 'test-a', ym: '2026-09', expectedRevision: rev(h), via: '電話', consentDate: '2026-09-06', memo: '架空' }));
  assert.equal(h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing.planStatus, 'approved');
  // offers
  rejected(h.admin('offer', { studentId: 'test-a', date: '2026-09-15', start: '16:00', min: 60, subject: '英語', kind: '講習', deliveryMode: 'in_person' }));
  ok(h.admin('offer', { studentId: 'test-a', date: '2026-09-15', start: '16:00', min: 60, subject: '英語', kind: '演習', deliveryMode: 'in_person' }));
  ok(h.admin('offer', { studentId: 'test-a', date: '2026-09-16', start: '16:00', min: 60, subject: '英語', deliveryMode: 'in_person' }));
  const slots = h.rows('slots').filter(s => s.studentId === 'test-a');
  assert.deepEqual(slots.map(s => [s.date, s.kind]), [['2026-09-15', '演習'], ['2026-09-16', '']]);
  // MCP offer with kind
  const mcp = h.request({ action: 'admin', op: 'mcpOfferLessons', mcpKey: MCP_KEY, studentId: 'test-a', subject: '英語', kind: '演習', start: '18:00', min: 60, items: [{ date: '2026-09-17' }, { date: '2026-09-18', kind: '講習' }], requestId: 'kind-mcp-1' });
  assert.equal(mcp.ok, true, JSON.stringify(mcp)); assert.deepEqual(mcp.results.map(r => [r.status, r.kind]), [['added', '演習'], ['invalid', '講習']]);
  assert.equal(h.rows('slots').find(s => s.date === '2026-09-17').kind, '演習');
  // student state
  const state = json(h.context().studentState_('synthetic-link-a'));
  assert.deepEqual(state.slots.filter(s => s.st === 'offer').map(s => [s.date, s.kind]), [['2026-09-15', '演習'], ['2026-09-16', ''], ['2026-09-17', '演習']]);
  assert.deepEqual(state.planMonths, [{ ym: '2026-09', status: 'approved', plan: { '英語': 3, '英語（演習）': 2 }, rows: [{ subject: '英語', kind: '', count: 3 }, { subject: '英語', kind: '演習', count: 2 }], comment: '' }]);
  // billing check matches subject and kind
  h.seedSlot({ date: '2026-09-01', start: '16:00', min: 60, status: 'booked', done: true, subject: '英語', kind: '演習' });
  h.seedSlot({ date: '2026-09-02', start: '16:00', min: 60, status: 'booked', done: true, subject: '英語', kind: '演習' });
  assert.notEqual(h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing.reason, '承認されていない科目・回数の授業があります');
  h.seedSlot({ date: '2026-09-03', start: '16:00', min: 60, status: 'booked', done: true, subject: '英語', kind: '演習' });
  assert.equal(h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing.reason, '承認されていない科目・回数の授業があります');
});

test('planSubmit saves rows, lesson time, per-lesson fee and comment, then proposes in one call', () => {
  const h = createSchedulingHarness(); ok(h.admin('state')); ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60 }));
  const submit = args => h.admin('planSubmit', { studentId: 'test-a', ym: '2026-09', ...args });
  rejected(submit({ rows: [], lessonMin: 90, lessonFee: 4500 }));
  rejected(submit({ rows: [{ subject: '英語', count: 4 }], lessonMin: 100, lessonFee: 4500 }));
  rejected(submit({ rows: [{ subject: '英語', count: 4 }, { subject: '英語', kind: '通常', count: 2 }], lessonMin: 90, lessonFee: 4500 }));
  rejected(submit({ rows: [{ subject: '英語', kind: '講習', count: 4 }], lessonMin: 90, lessonFee: 4500 }));
  const r = ok(submit({ rows: [{ subject: '英語', count: 4 }, { subject: '英語', kind: '演習', count: 2 }], lessonMin: 90, lessonFee: 4500, comment: '入試対策' }));
  assert.equal(r.rate30, 1500); assert.equal(r.lessonFee, 4500); assert.equal(r.rows, 2);
  const b = h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing; assert.equal(b.planStatus, 'proposed'); assert.equal(b.rate30, 1500);
  const c = h.context();
  assert.deepEqual(json(c.billingPlanList_('test-a', '2026-09')), [{ subject: '英語', count: 4 }, { subject: '英語', count: 2, kind: '演習' }]);
  assert.equal(c.planComment_('test-a', '2026-09'), '入試対策');
  rejected(submit({ rows: [{ subject: '英語', count: 3 }], lessonMin: 90, lessonFee: 4500, expectedRevision: 0 }));
  const r2 = ok(submit({ rows: [{ subject: '数学', count: 3 }], lessonMin: 60, lessonFee: 5000, comment: '', expectedRevision: rev(h) }));
  assert.equal(r2.rate30, 2500); assert.equal(r2.lessonFee, 5000);
  const c2 = h.context();
  assert.deepEqual(json(c2.billingPlanList_('test-a', '2026-09')), [{ subject: '数学', count: 3 }]); assert.equal(c2.planComment_('test-a', '2026-09'), '');
  assert.equal(h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing.planStatus, 'proposed');
});
