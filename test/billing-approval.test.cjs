'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness, MCP_KEY } = require('./helpers/billing-harness.cjs');

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function rejected(result) {
  assert.ok(result.error, JSON.stringify(result));
  assert.notEqual(result.ok, true);
  return result;
}

const parentSession=require('./helpers/parent-session.cjs');

function preview(h, studentId = 'test-a', ym = '2026-09') {
  return ok(h.admin('billingPreview', { studentId, ym })).billing;
}

function propose(h, { studentId = 'test-a', ym = '2026-09', counts = { 数学: 2 }, ...fees } = {}) {
  for (const [subject, count] of Object.entries(counts)) {
    ok(h.admin('planSet', { studentId, ym, subject, count }));
  }
  ok(h.admin('planPropose', { studentId, ym, ...fees }));
  return preview(h, studentId, ym);
}

function approve(h, options = {}) {
  const studentId = options.studentId || 'test-a';
  const ym = options.ym || '2026-09';
  const proposed = propose(h, options);
  ok(h.admin('planApproveTeacher', {
    studentId, ym, expectedRevision: proposed.revision,
    via: '電話', consentDate: '2026-09-06', memo: '架空の保護者から承諾を得た記録'
  }));
  return preview(h, studentId, ym);
}

// Fail one real Sheets write at a persistence boundary, leaving earlier writes
// durable. The retry still enters doPost with a fresh GAS execution context.
function failWriteOnce(sheet, matches, afterWrite = false) {
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args);
    const setValues = range.setValues;
    range.setValues = function(values) {
      if (!matches(values, range)) return setValues.call(this, values);
      sheet.getRange = getRange;
      if (afterWrite) setValues.call(this, values);
      throw new Error('Synthetic interrupted Sheets write');
    };
    return range;
  };
}

function planPersistence(h) {
  return ['plans','monthAgreements','approvalEvents'].map(name => h.rows(name));
}

for (const count of [0, 3]) {
  for (const stage of ['status', 'snapshot', 'audit']) {
    test(`same-count retry repairs a ${count === 0 ? 'deleted' : 'changed'} plan after ${stage} failure at the same revision`, () => {
      const h = createBillingHarness();
      const ym = stage === 'snapshot' ? '2026-08' : '2026-09';
      const before = approve(h, { ym, counts: { 数学: 2, 英語: 1 }, rate30: 1700, monthly: 0 });
      ok(h.admin('setFee', { studentId: 'test-a', rate30: 9999, monthly: 0 }));
      const expectedPlan = count ? [{subject:'数学',count},{subject:'英語',count:1}] : [{subject:'英語',count:1}];
      const expectedJson = JSON.stringify(expectedPlan);
      if (stage === 'status') {
        failWriteOnce(h.spreadsheet.getSheetByName('plans'), (values, range) => range.column === 6 && values[0][0] === 'draft');
      } else if (stage === 'snapshot') {
        failWriteOnce(h.spreadsheet.getSheetByName('monthAgreements'), values => values[0][4] === 'draft' && values[0][5] === expectedJson);
      } else {
        failWriteOnce(h.spreadsheet.getSheetByName('approvalEvents'), values => values[0][4] === 'planChanged' && Number(values[0][3]) === before.revision + 1);
      }
      const request = {studentId:'test-a',ym,subject:'数学',count,expectedRevision:before.revision};
      rejected(h.admin('planSet', request));
      const interrupted = h.rows('monthAgreements')[0];
      assert.equal(interrupted.status, 'draft');
      assert.equal(interrupted.proposedAt, '');
      assert.equal(Number(interrupted.revision), before.revision + 1);
      assert.equal(Number(h.rows('plans').find(p => p.subject === '数学')?.count || 0), count);
      const partiallySaved = planPersistence(h);
      assert.equal(rejected(h.admin('planSet', request)).errorCode, 'conflict');
      assert.equal(rejected(h.admin('planSet', {...request,expectedRevision:undefined})).errorCode, 'conflict');
      assert.deepEqual(planPersistence(h), partiallySaved);

      const current = {...request,expectedRevision:Number(interrupted.revision)};
      ok(h.admin('planSet', current));
      const repaired = h.rows('monthAgreements')[0];
      assert.equal(Number(repaired.revision), Number(interrupted.revision));
      assert.equal(repaired.status, 'draft');
      assert.equal(repaired.planJson, expectedJson);
      assert.equal(Number(repaired.rate30), 1700);
      assert.equal(Number(repaired.monthly), 0);
      assert(h.rows('plans').every(p => p.status === 'draft' && !p.approvedAt && !p.approvedVia && !p.memo));
      const receipts = h.rows('approvalEvents').filter(e => e.id === `${repaired.id}:${repaired.revision}:changed`);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].event, 'planChanged');
      assert.deepEqual(JSON.parse(receipts[0].snapshotJson), {plan:expectedPlan,rate30:1700,monthly:0});
      const complete = planPersistence(h);
      h.advance(1000);
      ok(h.admin('planSet', current));
      assert.deepEqual(planPersistence(h), complete, 'completed retry must not rewrite timestamps, statuses or audit rows');
      assert.equal(rejected(h.admin('planSet', request)).errorCode, 'conflict');
      assert.deepEqual(planPersistence(h), complete);
    });
  }
}

test('same-count approved, proposed, completed draft, default and absent plans are true no-ops', () => {
  for (const state of ['approved','proposed','draft','default','absent']) {
    const h = createBillingHarness();
    let ym = '2026-09', count = 2;
    if (state === 'approved') approve(h);
    if (state === 'proposed') propose(h);
    if (state === 'draft') ok(h.admin('planSet', {studentId:'test-a',ym,subject:'数学',count}));
    if (state === 'default') { ym = 'default'; h.seedPlan({ym}); }
    if (state === 'absent') count = 0;
    const before = planPersistence(h);
    h.advance(1000);
    ok(h.admin('planSet', {studentId:'test-a',ym,subject:'数学',count}));
    assert.deepEqual(planPersistence(h), before, state);
  }
});

test('same-count retry does not reinterpret a proposal intermediate draft as a plan change', () => {
  const h = createBillingHarness();
  ok(h.admin('planSet', {studentId:'test-a',ym:'2026-08',subject:'数学',count:2}));
  failWriteOnce(h.spreadsheet.getSheetByName('monthAgreements'), values => values[0][4] === 'proposed');
  rejected(h.admin('planPropose', {studentId:'test-a',ym:'2026-08',rate30:900,monthly:0}));
  const interrupted = h.rows('monthAgreements')[0];
  assert.equal(interrupted.status, 'draft');
  assert(interrupted.proposedAt);
  const before = planPersistence(h);
  ok(h.admin('planSet', {studentId:'test-a',ym:'2026-08',subject:'数学',count:2,expectedRevision:interrupted.revision}));
  assert.deepEqual(planPersistence(h), before);
});

test('deleting the last past-month plan keeps its latest revision in the admin detail for a same-count repair', () => {
  const h = createBillingHarness(), ym = '2026-07';
  approve(h, {ym,counts:{数学:1},rate30:1500,monthly:0});
  // Another student's agreement must not become a month in this student's card.
  propose(h, {studentId:'test-b',ym:'2026-06',rate30:900,monthly:0});
  const before = ok(h.admin('kanriStudent', {studentId:'test-a'})).data.plan.months.find(m => m.ym === ym);
  failWriteOnce(h.spreadsheet.getSheetByName('monthAgreements'), values => values[0][4] === 'draft' && values[0][5] === '[]');
  rejected(h.admin('planSet', {studentId:'test-a',ym,subject:'数学',count:0,expectedRevision:before.revision}));
  assert.equal(h.rows('plans').filter(p => p.studentId === 'test-a').length, 0);
  assert.equal(h.rows('slots').length, 0);
  assert.equal(h.payments().length, 0);
  const refreshed = ok(h.admin('kanriStudent', {studentId:'test-a'})).data;
  const selected = refreshed.plan.months.find(m => m.ym === ym);
  assert(selected, 'the agreement-only month must remain selectable after the last plan row is deleted');
  assert.equal(typeof selected.revision, 'number');
  assert.equal(selected.revision, before.revision + 1);
  assert.equal(selected.status, 'draft');
  assert(!refreshed.plan.months.some(m => m.ym === '2026-06'));
  const result = ok(h.admin('planSet', {studentId:'test-a',ym,subject:'数学',count:0,expectedRevision:selected.revision,from:'kanri',view:'student'}));
  const complete = result.data.plan.months.find(m => m.ym === ym);
  assert.equal(complete.revision, selected.revision);
  assert.equal(complete.status, 'draft');
  const a = h.rows('monthAgreements').find(a => a.studentId === 'test-a');
  assert.equal(a.planJson, '[]');
  assert.equal(h.rows('approvalEvents').filter(e => e.id === `${a.id}:${a.revision}:changed`).length, 1);
});

test('a saved plan-change receipt makes a lost response a no-op retry', () => {
  const h = createBillingHarness();
  const before = approve(h);
  failWriteOnce(h.spreadsheet.getSheetByName('approvalEvents'), values => values[0][4] === 'planChanged' && Number(values[0][3]) === before.revision + 1, true);
  rejected(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:0,expectedRevision:before.revision}));
  const complete = planPersistence(h), a = h.rows('monthAgreements')[0];
  h.advance(1000);
  ok(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:0,expectedRevision:a.revision}));
  assert.deepEqual(planPersistence(h), complete);
});

test('invoice freeze also blocks a same-count draft repair', () => {
  const h = createBillingHarness();
  const before = approve(h);
  failWriteOnce(h.spreadsheet.getSheetByName('approvalEvents'), values => values[0][4] === 'planChanged' && Number(values[0][3]) === before.revision + 1);
  rejected(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:3,expectedRevision:before.revision}));
  h.seedPayment();
  const persisted = planPersistence(h), a = h.rows('monthAgreements')[0];
  assert.equal(rejected(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:3,expectedRevision:a.revision})).errorCode, 'invoiceLocked');
  assert.deepEqual(planPersistence(h), persisted);
});

test('draft repair validates an existing conflicting receipt before rewriting the snapshot', () => {
  const h = createBillingHarness();
  const before = approve(h);
  failWriteOnce(h.spreadsheet.getSheetByName('monthAgreements'), values => values[0][4] === 'draft' && values[0][5] === '[]');
  rejected(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:0,expectedRevision:before.revision}));
  const a = h.rows('monthAgreements')[0];
  h.spreadsheet.getSheetByName('approvalEvents').appendRow([
    `${a.id}:${a.revision}:changed`, 'test-b', '2026-09', a.revision, 'planChanged', '', '', '', '', '{}'
  ]);
  const persisted = planPersistence(h);
  assert.equal(rejected(h.admin('planSet', {studentId:'test-a',ym:'2026-09',subject:'数学',count:0,expectedRevision:a.revision})).errorCode, 'conflict');
  assert.deepEqual(planPersistence(h), persisted);
});

test('monthly approval, fee edits and invoice creation require teacher authorization', () => {
  const h = createBillingHarness();
  const ptoken = parentSession(h);
  h.seedPlan();
  const beforeStudents = h.rows('students');
  const beforePlans = h.rows('plans');
  const operations = [
    { op: 'planSet', studentId: 'test-a', ym: '2026-09', subject: '数学', count: 8 },
    { op: 'planPropose', studentId: 'test-a', ym: '2026-09' },
    { op: 'planApproveTeacher', studentId: 'test-a', ym: '2026-09', via: '電話', approvedAt: '2026-09-06', memo: '架空の承認記録' },
    { op: 'setFee', studentId: 'test-a', rate30: 9999, monthly: 99999 },
    { op: 'kanriAddPayment', studentId: 'test-a', ym: '2026-09', amount: 99999 }
  ];
  for (const operation of operations) {
    for (const credentials of [{}, { token: ptoken }, { mcpKey: MCP_KEY }]) {
      rejected(h.request({ action: 'admin', ...operation, ...credentials }));
    }
  }
  assert.deepEqual(h.rows('students'), beforeStudents);
  assert.deepEqual(h.rows('plans'), beforePlans);
  assert.deepEqual(h.payments(), []);
  assert.deepEqual(h.effects, []);
});

test('parent monthly decision cannot use an absent or another student session', () => {
  const h = createBillingHarness();
  const ptoken = parentSession(h);
  h.seedPlan({ status: 'proposed' });
  h.seedPlan({ studentId: 'test-b', status: 'proposed' });
  const beforePlans = h.rows('plans');
  for (const credentials of [{}, { k: 'synthetic-link-b', ptoken }]) {
    const result = rejected(h.parent('parentPlanDecide', { ym: '2026-09', approve: true, ...credentials }));
    assert.equal(result.parentAuthRequired, true);
  }
  assert.deepEqual(h.rows('plans'), beforePlans);
  assert.deepEqual(h.payments(), []);
});

test('a teacher can send an offer before monthly approval without confirming or billing it', () => {
  const h = createBillingHarness();
  const result = ok(h.admin('offer', { studentId: 'test-a', date: '2026-09-15', start: '16:00', min: 60, subject: '数学' }));
  assert.equal(result.added, 1);
  const slots = h.rows('slots');
  assert.equal(slots.length, 1);
  assert.equal(slots[0].status, 'offered');
  assert.ok(!slots[0].done);
  assert.deepEqual(h.rows('plans'), []);
  assert.deepEqual(h.payments(), []);
  assert.deepEqual(h.effects, []);
});

test('an offer cannot be accepted without approval for its student, month and subject', () => {
  for (const setup of [
    () => {},
    h => h.seedPlan({ ym: 'default', status: 'approved' }),
    h => approve(h, { studentId: 'test-b' }),
    h => approve(h, { ym: '2026-10' }),
    h => approve(h, { counts: { 英語: 2 } }),
    h => propose(h)
  ]) {
    const h = createBillingHarness();
    setup(h);
    const slot = h.seedSlot();
    rejected(h.accept(slot.id));
    assert.equal(h.rows('slots').find(row => row.id === slot.id).status, 'offered');
    assert.deepEqual(h.payments(), []);
    assert.deepEqual(h.effects, []);
  }
});

test('approved subject quota counts each booked lesson once and cancellation releases a place', () => {
  const h = createBillingHarness();
  approve(h, { counts: { 数学: 2 } });
  h.seedSlot({ date: '2026-09-01', status: 'booked', done: true });
  const first = h.seedSlot({ date: '2026-09-15' });
  const second = h.seedSlot({ date: '2026-09-22' });
  ok(h.accept(first.id));
  rejected(h.accept(second.id));
  ok(h.admin('unbook', { studentId: 'test-a', slotId: first.id }));
  ok(h.accept(second.id));
  assert.equal(h.rows('slots').filter(row => row.status === 'booked').length, 2);
});

test('parent approval requires the displayed revision and only approves the current own plan', () => {
  const h = createBillingHarness();
  const ptoken = parentSession(h);
  const old = propose(h, { counts: { 数学: 2 } });
  propose(h, { studentId: 'test-b', counts: { 英語: 1 } });
  const current = propose(h, { counts: { 数学: 3 } });
  assert.notEqual(current.revision, old.revision);
  for (const revision of [undefined, old.revision]) {
    rejected(h.request({ action:'familyPlanDecide', studentId:'test-a', ftoken:ptoken, ym: '2026-09', approve: true, expectedRevision: revision }));
  }
  assert.equal(preview(h).planStatus, 'proposed');
  ok(h.request({ action:'familyPlanDecide', studentId:'test-a', ftoken:ptoken, ym: '2026-09', approve: true, expectedRevision: current.revision }));
  assert.equal(preview(h).planStatus, 'approved');
  assert.equal(preview(h, 'test-b').planStatus, 'proposed');
  assert.deepEqual(h.effects, []);
});

test('changing one subject invalidates the whole month until a new approval', () => {
  const h = createBillingHarness();
  approve(h, { counts: { 数学: 2, 英語: 2 } });
  ok(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '数学', count: 3 }));
  assert.notEqual(preview(h).planStatus, 'approved');
  const english = h.seedSlot({ subject: '英語' });
  rejected(h.accept(english.id));
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-unapproved-month' }));
  assert.deepEqual(h.payments(), []);
});

test('teacher approval records require a current revision and consent evidence', () => {
  const h = createBillingHarness();
  const proposed = propose(h);
  // A lesson preceding the consent date makes the record retrospective, so a
  // reason is required in addition to the date and method.
  h.seedSlot({ date: '2026-09-01' });
  const valid = {
    studentId: 'test-a', ym: '2026-09', expectedRevision: proposed.revision,
    via: '電話', consentDate: '2026-09-06', memo: '架空の承諾記録'
  };
  for (const field of ['expectedRevision', 'via', 'consentDate', 'memo']) {
    rejected(h.admin('planApproveTeacher', { ...valid, [field]: '' }));
    assert.equal(preview(h).planStatus, 'proposed');
  }
  ok(h.admin('planApproveTeacher', valid));
  assert.equal(preview(h).planStatus, 'approved');
});

test('past-month plans require explicit historical fees and cannot inherit current student fees', () => {
  const h = createBillingHarness();
  ok(h.admin('planSet', { studentId: 'test-a', ym: '2026-08', subject: '数学', count: 2 }));
  rejected(h.admin('planPropose', { studentId: 'test-a', ym: '2026-08' }));
  ok(h.admin('planPropose', { studentId: 'test-a', ym: '2026-08', rate30: 1000 }));
  const approved = approve(h, { ym: '2026-08', rate30: 1000, monthly: 0 });
  assert.equal(approved.rate30, 1000);
  h.seedSlot({ date: '2026-08-10', status: 'booked', done: true });
  const bill = preview(h, 'test-a', '2026-08');
  assert.equal(bill.amount, 2000);
  assert.equal(bill.canBill, true);
});

test('billing uses only completed lessons and rejects a month with unfinished bookings', () => {
  const h = createBillingHarness();
  approve(h, { counts: { 数学: 3 } });
  h.seedSlot({ date: '2026-09-01', min: 90, status: 'booked', done: true });
  const unfinished = h.seedSlot({ status: 'booked' });
  h.seedSlot({ date: '2026-09-22' });
  const blocked = preview(h);
  assert.equal(blocked.minutes, 90);
  assert.equal(blocked.amount, 4500);
  assert.equal(blocked.canBill, false);
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-unfinished' }));
  ok(h.admin('unbook', { studentId: 'test-a', slotId: unfinished.id }));
  const ready = preview(h);
  assert.equal(ready.canBill, true);
  assert.equal(ready.amount, 4500);
});

test('fixed fees are rejected and no completed lessons produce no invoice', () => {
  const h = createBillingHarness();
  rejected(h.admin('setFee', { studentId: 'test-a', rate30: 1500, monthly: 12000 }));
  approve(h);
  const bill = preview(h);
  assert.equal(bill.mode, 'time');
  assert.equal(bill.minutes, 0);
  assert.equal(bill.count, 0);
  assert.equal(bill.amount, 0);
  assert.equal(bill.canBill, false);
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-monthly-invoice' }));
  assert.equal(h.payments().length, 0);
});

function billableFixture() {
  const h = createBillingHarness();
  approve(h, { counts: { 数学: 3 } });
  h.seedSlot({ date: '2026-09-01', min: 90, status: 'booked', done: true });
  return h;
}

function issueInvoice(h, requestId = 'synthetic-invoice-request') {
  return ok(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId })).invoice;
}

test('an invoice ignores client calculation and saves the server terms and lesson snapshot', () => {
  const h = billableFixture();
  const base = { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-request' };
  for (const forged of [{ amount: 1 }, { amount: 4501 }, { paidDate: '2026-09-01' }, { billDate: '2026-08-01' }]) {
    rejected(h.admin('kanriAddPayment', { ...base, ...forged }));
    assert.deepEqual(h.payments(), []);
  }
  rejected(h.admin('kanriAddPayment', { ...base, requestId: '' }));
  const invoice = issueInvoice(h);
  assert.equal(invoice.amount, 4500);
  const saved = h.payments()[0];
  assert.equal(saved['請求ID'], invoice.id);
  assert.equal(saved['確定単価(30分)'], 1500);
  assert.equal(saved['実施分数'], 90);
  assert.equal(saved['実施回数'], 1);
  assert.equal(saved['状態'], '未入金');
  assert.equal(JSON.parse(saved['実績JSON'])[0].min, 90);
});

test('invoice retransmission returns one invoice and a reused request cannot change its student or month', () => {
  const h = billableFixture();
  const first = issueInvoice(h);
  const replay = ok(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-request' }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.invoice.id, first.id);
  rejected(h.admin('kanriAddPayment', { studentId: 'test-b', ym: '2026-09', requestId: 'synthetic-invoice-request' }));
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-10', requestId: 'synthetic-invoice-request' }));
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-request', amount: 1 }));
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-another-request' }));
  assert.equal(h.payments().length, 1);
});

test('legacy invoices block duplicates and schema extension preserves original business values', () => {
  const h = billableFixture();
  const original = h.seedPayment({ '請求額': 4321 });
  const before = Object.fromEntries(Object.keys(original).map(key => [key, original[key]]));
  const sheet = h.ledger.getSheetByName('入金管理');
  sheet.values = sheet.values.map(row => row.slice(0, 9));
  const legacyHeaders = [...sheet.values[0]];
  h.advance(86400000);
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-legacy-duplicate' }));
  assert.equal(h.payments().length, 1);
  assert.deepEqual(sheet.values[0].slice(0, 9), legacyHeaders);
  assert.equal(sheet.values[0].length, 21);
  assert.ok(h.payments()[0]['請求ID']);
  for (const [key, value] of Object.entries(before)) assert.equal(h.payments()[0][key], value);
  rejected(h.admin('kanriDeleteRow', { studentId: 'test-a', sheet: '入金管理', row: 2 }));
  assert.equal(h.payments().length, 1);
});

test('issuing an invoice freezes its plan, booked lessons, completed status and amount', () => {
  const h = billableFixture();
  const completed = h.rows('slots')[0];
  const oldOffer = h.seedSlot({ date: '2026-09-02' });
  const futureOffer = h.seedSlot({ date: '2026-09-15' });
  issueInvoice(h);
  const before = { slots: h.rows('slots'), plans: h.rows('plans'), payments: h.payments() };
  rejected(h.accept(futureOffer.id));
  for (const operation of [
    { op: 'toggleDone', slotId: completed.id },
    { op: 'unbook', slotId: completed.id },
    { op: 'finishOffered', slotId: oldOffer.id },
    { op: 'deleteSlot', slotId: oldOffer.id },
    { op: 'resolveCancel', slotId: completed.id, approve: true },
    { op: 'planSet', ym: '2026-09', subject: '数学', count: 4 },
    { op: 'planPropose', ym: '2026-09', rate30: 2000, monthly: 0 }
  ]) rejected(h.admin(operation.op, { studentId: 'test-a', ...operation }));
  assert.deepEqual(h.rows('slots'), before.slots);
  assert.deepEqual(h.rows('plans'), before.plans);
  assert.deepEqual(h.payments(), before.payments);
  ok(h.admin('setFee', { studentId: 'test-a', rate30: 2500, monthly: 0 }));
  assert.equal(preview(h).amount, 4500);
  assert.deepEqual(h.payments(), before.payments);
});

test('unpaid invoices can be voided with a reason and reissued under a new request without deleting history', () => {
  const h = billableFixture();
  const first = issueInvoice(h);
  rejected(h.admin('kanriVoidInvoice', { studentId: 'test-a', invoiceId: first.id }));
  rejected(h.admin('kanriVoidInvoice', { studentId: 'test-b', invoiceId: first.id, reason: '架空の訂正' }));
  ok(h.admin('kanriVoidInvoice', { studentId: 'test-a', invoiceId: first.id, reason: '架空の請求内容訂正' }));
  assert.equal(h.payments().length, 1);
  assert.equal(h.payments()[0]['状態'], '取消');
  const replay = issueInvoice(h);
  assert.equal(replay.id, first.id);
  assert.equal(replay.status, '取消');
  assert.equal(h.payments().length, 1);
  const second = issueInvoice(h, 'synthetic-reissued-invoice');
  assert.notEqual(second.id, first.id);
  assert.equal(h.payments().length, 2);
  assert.equal(h.payments().filter(row => row['状態'] !== '取消').length, 1);
});

test('paid invoices require a recorded correction before voiding and use IDs instead of row positions', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  rejected(h.admin('kanriSetPaid', { studentId: 'test-b', invoiceId: invoice.id, expectedPaymentRevision: 0, date: '2026-09-07', method: '振込' }));
  rejected(h.admin('kanriSetPaid', { studentId: 'test-a', row: 2, expectedPaymentRevision: 0, date: '2026-09-07', method: '振込' }));
  ok(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 0, date: '2026-09-07', method: '振込' }));
  rejected(h.admin('kanriVoidInvoice', { studentId: 'test-a', invoiceId: invoice.id, reason: '架空の訂正' }));
  rejected(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 1, unpaid: true }));
  assert.equal(h.payments()[0]['状態'], '入金済');
  ok(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 1, unpaid: true, reason: '架空の入金先取り違え訂正' }));
  assert.equal(h.payments()[0]['状態'], '未入金');
  assert.ok(h.rows('approvalEvents').some(row => row.event === 'paymentCorrected'));
  ok(h.admin('kanriVoidInvoice', { studentId: 'test-a', invoiceId: invoice.id, reason: '架空の訂正' }));
  rejected(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 2, date: '2026-09-07', method: '振込' }));
});

test('teacher completion is independent of parent monthly approval and quota', () => {
  const h = createBillingHarness();
  const offered = h.seedSlot({ date: '2026-09-01' });
  const booked = h.seedSlot({ date: '2026-09-02', status: 'booked' });
  ok(h.admin('finishOffered', { studentId: 'test-a', slotId: offered.id }));
  ok(h.admin('toggleDone', { studentId: 'test-a', slotId: booked.id, done: true }));
  approve(h, { counts: { 数学: 1 } });
  ok(h.admin('toggleDone', { studentId: 'test-a', slotId: booked.id, done: true }));
  assert.equal(h.rows('slots').find(row => row.id === offered.id).status, 'booked');
  assert.equal(h.rows('slots').find(row => row.id === booked.id).done, true);
});

test('fee changes preserve agreed month terms until a new proposal gets approval', () => {
  const h = billableFixture();
  const before = preview(h);
  ok(h.admin('setFee', { studentId: 'test-a', rate30: 2500, monthly: 0 }));
  assert.equal(preview(h).amount, 4500);
  assert.equal(preview(h).revision, before.revision);
  assert.equal(preview(h).planStatus, 'approved');
  ok(h.admin('planPropose', { studentId: 'test-a', ym: '2026-09' }));
  const changed = preview(h);
  assert.equal(changed.amount, 7500);
  assert.equal(changed.rate30, 2500);
  assert.equal(changed.planStatus, 'proposed');
  assert.equal(changed.canBill, false);
  assert.notEqual(changed.revision, before.revision);
});

test('a ledger write failure before saving can be retried without creating duplicate invoices', () => {
  const h = billableFixture();
  const sheet = h.ledger.getSheetByName('入金管理');
  const append = sheet.appendRow;
  sheet.appendRow = function(row) {
    this.appendRow = append;
    throw new Error('Synthetic ledger service failure before append');
  };
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-request' }));
  assert.equal(h.payments().length, 0);
  issueInvoice(h);
  assert.equal(h.payments().length, 1);
});

test('loss of the response after a durable invoice write does not duplicate the invoice on retry', () => {
  const h = billableFixture();
  const sheet = h.spreadsheet.getSheetByName('approvalEvents');
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args);
    const setValues = range.setValues;
    range.setValues = function(values) {
      if (values[0]?.[4] === 'invoiced') {
        sheet.getRange = getRange;
        throw new Error('Synthetic audit service failure after invoice append');
      }
      return setValues.call(this, values);
    };
    return range;
  };
  rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-request' }));
  assert.equal(h.payments().length, 1);
  const id = h.payments()[0]['請求ID'];
  assert.equal(h.rows('approvalEvents').filter(row => row.event === 'invoiced').length, 0);
  assert.equal(issueInvoice(h).id, id);
  assert.equal(h.payments().length, 1);
  const issuedEvents = h.rows('approvalEvents').filter(row => row.event === 'invoiced');
  assert.equal(issuedEvents.length, 1);
  assert.equal(JSON.parse(issuedEvents[0].snapshotJson).detail.invoiceId, id);
  issueInvoice(h);
  assert.equal(h.rows('approvalEvents').filter(row => row.event === 'invoiced').length, 1);
});

test('billing schema validates headers before accepting mutations and preserves conflicting headers', () => {
  const h = createBillingHarness();
  const sheet = h.spreadsheet.getSheetByName('monthAgreements');
  sheet.values[0][3] = 'unexpectedExistingColumn';
  const before = sheet.values.map(row => [...row]);
  h.advance(86400000); // Expire cached schema checks without depending on a cache key.
  rejected(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '数学', count: 2 }));
  assert.deepEqual(sheet.values, before);
  assert.deepEqual(h.rows('plans'), []);
});

test('invalid completed lesson durations cannot offset other lessons or become a billable snapshot', () => {
  for (const min of [-30, 0, Infinity, 'not-a-duration']) {
    const h = billableFixture();
    h.seedSlot({ date: '2026-09-02', min, status: 'booked', done: true });
    const bill = preview(h);
    assert.equal(bill.canBill, false, 'Invalid duration was billable: ' + String(min));
    assert.ok(bill.reason);
    rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invalid-duration' }));
    assert.deepEqual(h.payments(), []);
  }
});

test('invoice amounts agree across parent, teacher and MCP views after standard fee changes', () => {
  const h = billableFixture();
  const ptoken = parentSession(h);
  issueInvoice(h);
  ok(h.admin('setFee', { studentId: 'test-a', rate30: 2900, monthly: 0 }));
  const teacher = ok(h.admin('kanriStudent', { studentId: 'test-a' })).data;
  const parent = ok(h.request({action:'familyData',studentId:'test-a',ftoken:ptoken})).data;
  const dashboard = ok(h.admin('kanriDashboard')).data;
  const mcp = ok(h.mcp('mcpBilling', { month: '2026-09' }));
  assert.equal(teacher.thisMonth.fee, 4500);
  assert.equal(teacher.billing.amount, 4500);
  assert.equal(parent.thisMonth.fee, 4500);
  assert.equal(dashboard.students.find(student => student.id === 'test-a').feeThisMonth, 4500);
  assert.equal(mcp.rows.find(row => row.student.id === 'test-a').fee, 4500);
  assert.equal(mcp.rows.find(row => row.student.id === 'test-a').canBill, false);
});

test('void invoices remain in history but disappear from teacher and MCP outstanding lists', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  ok(h.admin('kanriVoidInvoice', { studentId: 'test-a', invoiceId: invoice.id, reason: '架空の請求取消' }));
  const dashboard = ok(h.admin('kanriDashboard')).data;
  const pending = ok(h.mcp('mcpPending'));
  const student = ok(h.mcp('mcpStudent', { studentId: 'test-a' }));
  assert.deepEqual(dashboard.unpaid, []);
  assert.deepEqual(pending.unpaid, []);
  assert.deepEqual(student.paymentsUnpaid, []);
  assert.equal(h.payments().length, 1);
});

test('duplicate subject plans or month agreements fail closed without changing a booking', () => {
  for (const sheetName of ['plans', 'monthAgreements']) {
    const h = createBillingHarness();
    approve(h);
    const slot = h.seedSlot();
    const sheet = h.spreadsheet.getSheetByName(sheetName);
    sheet.appendRow([...sheet.values[1]]);
    rejected(h.accept(slot.id));
    assert.equal(h.rows('slots')[0].status, 'offered');
    rejected(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-duplicate-plan' }));
    assert.deepEqual(h.payments(), []);
  }
});

test('waiting for another mutation returns pending if the script lock cannot be acquired', () => {
  const h = billableFixture();
  const context = h.context();
  let released = false;
  context.LockService.getScriptLock = () => ({
    waitLock() { throw new Error('Synthetic lock timeout'); },
    releaseLock() { released = true; }
  });
  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'admin', op: 'kanriAddPayment', studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-lock-timeout'
  }) } }).getContent());
  rejected(result);
  assert.equal(result.errorCode, 'pending');
  assert.equal(released, false);
  assert.deepEqual(h.payments(), []);
});

test('duplicate slot IDs reject confirmation and destructive mutations without picking a row', () => {
  const h = createBillingHarness();
  approve(h, { counts: { 数学: 1 } });
  const slot = h.seedSlot();
  h.seedSlot({ id: slot.id, status: 'booked' });
  const before = h.rows('slots');
  assert.equal(rejected(h.accept(slot.id)).errorCode, 'conflict');
  for (const op of ['toggleDone','finishOffered','unbook','deleteSlot']) {
    assert.equal(rejected(h.admin(op, {studentId:'test-a',slotId:slot.id})).errorCode,'conflict');
  }
  assert.deepEqual(h.rows('slots'), before);
});

test('approval recovery rejects changed consent evidence and resumes the original evidence once', () => {
  const h = createBillingHarness();
  const proposed = propose(h);
  const originalRequest = {
    studentId: 'test-a', ym: '2026-09', expectedRevision: proposed.revision,
    via: 'LINE', consentDate: '2026-09-06', memo: '架空の最初の承諾記録'
  };
  const sheet = h.spreadsheet.getSheetByName('monthAgreements');
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args);
    const setValues = range.setValues;
    range.setValues = function(values) {
      if (values[0]?.[4] === 'approved') {
        sheet.getRange = getRange;
        throw new Error('Synthetic final agreement write failure');
      }
      return setValues.call(this, values);
    };
    return range;
  };
  rejected(h.admin('planApproveTeacher', originalRequest));
  assert.equal(preview(h).planStatus, 'proposed');
  for (const changed of [{ via: '電話' }, { consentDate: '2026-09-05' }, { memo: '架空の別の承諾記録' }]) {
    const result = rejected(h.admin('planApproveTeacher', { ...originalRequest, ...changed }));
    assert.equal(result.errorCode, 'conflict');
    assert.equal(preview(h).planStatus, 'proposed');
  }
  ok(h.admin('planApproveTeacher', originalRequest));
  assert.equal(preview(h).planStatus, 'approved');
  const agreement = h.rows('monthAgreements')[0];
  const audits = h.rows('approvalEvents').filter(event => event.event === 'approved');
  assert.equal(audits.length, 1);
  assert.equal(agreement.approvedVia, audits[0].via);
  assert.equal(agreement.consentDate, audits[0].consentDate);
  assert.equal(agreement.memo, audits[0].memo);
});

test('void recovery rejects a changed reason and resumes the original cancellation once', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  const originalRequest = { studentId: 'test-a', invoiceId: invoice.id, reason: '架空の最初の取消理由' };
  const sheet = h.ledger.getSheetByName('入金管理');
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args);
    const setValues = range.setValues;
    range.setValues = function(values) {
      if (values[0]?.[7] === '取消') {
        sheet.getRange = getRange;
        throw new Error('Synthetic final void write failure');
      }
      return setValues.call(this, values);
    };
    return range;
  };
  rejected(h.admin('kanriVoidInvoice', originalRequest));
  assert.equal(h.payments()[0]['状態'], '未入金');
  const changed = rejected(h.admin('kanriVoidInvoice', { ...originalRequest, reason: '架空の別の取消理由' }));
  assert.equal(changed.errorCode, 'conflict');
  assert.equal(h.payments()[0]['状態'], '未入金');
  ok(h.admin('kanriVoidInvoice', originalRequest));
  const audits = h.rows('approvalEvents').filter(event => event.event === 'invoiceVoided');
  assert.equal(audits.length, 1);
  assert.equal(h.payments()[0]['状態'], '取消');
  assert.equal(h.payments()[0]['取消理由'], JSON.parse(audits[0].snapshotJson).detail.reason);
});

test('a stale payment update cannot overwrite paid date or method without a reasoned correction', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  const paidRequest = { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 0, date: '2026-09-06', method: '振込' };
  ok(h.admin('kanriSetPaid', paidRequest));
  for (const changed of [{ date: '2026-09-07' }, { method: '現金' }]) {
    assert.equal(rejected(h.admin('kanriSetPaid', { ...paidRequest, ...changed })).errorCode, 'conflict');
  }
  assert.equal(h.payments()[0]['入金日'], '2026-09-06');
  assert.equal(h.payments()[0]['入金方法'], '振込');
  assert.equal(ok(h.admin('kanriSetPaid', paidRequest)).replayed, true);
  assert.equal(h.rows('approvalEvents').filter(event => event.event === 'paid').length, 1);
  ok(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 1, unpaid: true, reason: '架空の入金情報訂正' }));
  ok(h.admin('kanriSetPaid', { ...paidRequest, expectedPaymentRevision: 2, date: '2026-09-07', method: '現金' }));
  assert.equal(h.payments()[0]['入金日'], '2026-09-07');
  assert.equal(h.payments()[0]['入金方法'], '現金');
  assert.equal(h.rows('approvalEvents').filter(event => event.event === 'paymentCorrected').length, 1);
});

test('an old correction retry cannot erase a later payment even when its date and method are identical', () => {
  for (const replacement of [{ date: '2026-09-07', method: '現金' }, { date: '2026-09-06', method: '振込' }]) {
    const h = billableFixture();
    const invoice = issueInvoice(h);
    assert.equal(invoice.paymentRevision, 0);
    const base = { studentId: 'test-a', invoiceId: invoice.id };
    ok(h.admin('kanriSetPaid', { ...base, expectedPaymentRevision: 0, date: '2026-09-06', method: '振込' }));
    const oldCorrection = { ...base, expectedPaymentRevision: 1, unpaid: true, reason: '架空の最初の訂正・応答紛失' };
    ok(h.admin('kanriSetPaid', oldCorrection));
    assert.equal(ok(h.admin('kanriSetPaid', oldCorrection)).replayed, true);
    ok(h.admin('kanriSetPaid', { ...base, expectedPaymentRevision: 2, ...replacement }));
    assert.equal(rejected(h.admin('kanriSetPaid', oldCorrection)).errorCode, 'conflict');
    assert.equal(h.payments()[0]['状態'], '入金済');
    assert.equal(h.payments()[0]['入金日'], replacement.date);
    assert.equal(h.payments()[0]['入金方法'], replacement.method);
    assert.equal(Number(h.payments()[0]['入金版']), 3);
    assert.equal(h.rows('approvalEvents').filter(event => event.event === 'paymentCorrected').length, 1);
  }
});

test('payment mutations require an explicit valid version, including no-op retransmissions', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  const base = { studentId: 'test-a', invoiceId: invoice.id, date: '2026-09-06', method: '振込' };
  for (const expectedPaymentRevision of [undefined, null, '', -1, 0.5]) {
    rejected(h.admin('kanriSetPaid', { ...base, expectedPaymentRevision }));
  }
  assert.equal(h.payments()[0]['状態'], '未入金');
  ok(h.admin('kanriSetPaid', { ...base, expectedPaymentRevision: 0 }));
  rejected(h.admin('kanriSetPaid', base));
  rejected(h.admin('kanriSetPaid', { studentId: 'test-a', invoiceId: invoice.id, unpaid: true, reason: '架空の訂正理由' }));
  assert.equal(h.payments()[0]['状態'], '入金済');
  assert.equal(Number(h.payments()[0]['入金版']), 1);
  const teacher = ok(h.admin('kanriStudent', { studentId: 'test-a' })).data;
  assert.equal(teacher.payments.find(payment => payment.id === invoice.id).paymentRevision, 1);
});

test('payment recovery preserves its version and audit evidence after the final row write fails', () => {
  const h = billableFixture();
  const invoice = issueInvoice(h);
  const request = { studentId: 'test-a', invoiceId: invoice.id, expectedPaymentRevision: 0, date: '2026-09-06', method: '振込' };
  const sheet = h.ledger.getSheetByName('入金管理');
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args);
    const setValues = range.setValues;
    range.setValues = function(values) {
      if (values[0]?.[7] === '入金済') {
        sheet.getRange = getRange;
        throw new Error('Synthetic final payment row write failure');
      }
      return setValues.call(this, values);
    };
    return range;
  };
  rejected(h.admin('kanriSetPaid', request));
  assert.equal(h.payments()[0]['状態'], '未入金');
  assert.equal(Number(h.payments()[0]['入金版']), 0);
  assert.equal(h.rows('approvalEvents').filter(event => event.event === 'paid').length, 1);
  assert.equal(rejected(h.admin('kanriSetPaid', { ...request, method: '現金' })).errorCode, 'conflict');
  assert.equal(h.payments()[0]['状態'], '未入金');
  ok(h.admin('kanriSetPaid', request));
  assert.equal(h.payments()[0]['状態'], '入金済');
  assert.equal(h.payments()[0]['入金方法'], '振込');
  assert.equal(Number(h.payments()[0]['入金版']), 1);
  assert.equal(ok(h.admin('kanriSetPaid', request)).replayed, true);
  assert.equal(h.rows('approvalEvents').filter(event => event.event === 'paid').length, 1);
});
