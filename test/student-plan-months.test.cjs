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
    { ym: '2026-09', status: 'approved', plan: { '英語': 4 } },
    { ym: '2026-10', status: 'proposed', plan: { '英語': 3, '数学': 2 } }
  ]);
  assert.deepEqual(state.plan, { '英語': 4 }); assert.equal(state.planStatus, 'approved');
  assert.deepEqual(json(h.context().studentState_('synthetic-link-b').planMonths), []);
});
