'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const json = v => JSON.parse(JSON.stringify(v));

test('student state lists this and next month plans with their approval status only', () => {
  const h = createSchedulingHarness();
  assert.deepEqual(json(h.context().studentState_('synthetic-link-a').planMonths), []);
  h.approve({ ym: '2026-09', count: 4, subject: '英語' });
  for (const [op, args] of [['planSet', { subject: '英語', count: 3 }], ['planSet', { subject: '数学', count: 2 }], ['planPropose', { rate30: 1500, monthly: 0 }]]) {
    const r = h.admin(op, { studentId: 'test-a', ym: '2026-10', ...args }); assert.equal(r.ok, true, JSON.stringify(r));
  }
  const r = h.admin('planSet', { studentId: 'test-a', ym: '2026-11', subject: '英語', count: 5 }); assert.equal(r.ok, true, JSON.stringify(r));
  const state = json(h.context().studentState_('synthetic-link-a'));
  assert.deepEqual(state.planMonths, [
    { ym: '2026-09', status: 'approved', plan: { '英語': 4 }, rows: [{ subject: '英語', kind: '', count: 4 }], comment: '' },
    { ym: '2026-10', status: 'proposed', plan: { '英語': 3, '数学': 2 }, rows: [{ subject: '英語', kind: '', count: 3 }, { subject: '数学', kind: '', count: 2 }], comment: '' }
  ]);
  assert.deepEqual(state.plan, { '英語': 4 }); assert.equal(state.planStatus, 'approved');
  assert.deepEqual(json(h.context().studentState_('synthetic-link-b').planMonths), []);
});

test('the teacher can attach a comment to a month plan and students, parents and the admin card see it', () => {
  const h = createSchedulingHarness();
  h.approve({ ym: '2026-09', count: 4, subject: '英語' });
  assert.ok(h.admin('planCommentSave', { studentId: 'test-a', ym: '2026-9', comment: 'x' }).error);
  assert.ok(h.admin('planCommentSave', { studentId: 'test-a', ym: '2026-09', comment: 'あ'.repeat(501) }).error);
  assert.ok(h.admin('planCommentSave', { studentId: 'nobody', ym: '2026-09', comment: 'x' }).error);
  const saved = h.admin('planCommentSave', { studentId: 'test-a', ym: '2026-09', comment: '  定期テスト対策で\r\n文法を固めます  ' }); assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(h.rows('planComments').length, 1);
  const state = json(h.context().studentState_('synthetic-link-a'));
  assert.equal(state.planMonths[0].comment, '定期テスト対策で\n文法を固めます');
  const c = h.context(); const parent = json(c.parentDataForStudent_(c.findStudent_('test-a')));
  assert.equal(parent.data.planMonths.find(m => m.ym === '2026-09').comment, '定期テスト対策で\n文法を固めます');
  assert.equal(h.admin('planCommentSave', { studentId: 'test-a', ym: '2026-09', comment: '書き直し' }).ok, true); assert.equal(h.rows('planComments').length, 1);
  assert.equal(json(h.context().studentState_('synthetic-link-a')).planMonths[0].comment, '書き直し');
  assert.equal(h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09' }).billing.planStatus, 'approved');
});
