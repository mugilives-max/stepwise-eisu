'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Reuse the existing minimal DOM/storage harness and execute the real HTML script.
// Only its helper definitions are loaded; the lesson test cases are not registered.
const lessonHarness = fs.readFileSync(path.join(__dirname, 'lesson-cycle-ui.test.cjs'), 'utf8').split('\ntest(')[0];
const { createUI, flush } = new Function('require', '__dirname', lessonHarness + '\nreturn {createUI, flush};')(require, __dirname);

function card(overrides = {}) {
  return {
    id: 'test-a', name: '【テスト】会計画面', active: true, rate30: 1500, monthly: 0,
    month: '2026-09', today: '2026-09-08', code: 'synthetic-ui-link',
    lessons: [], grades: [], exams: [], payments: [], meetings: [], tasks: [], profile: {},
    thisMonth: { count: 0, minutes: 0, fee: 0 },
    plan: { current: {}, defaultRows: [], months: [{ ym: '2026-09', status: 'draft', revision: 0, termsKnown: false, rows: [{ subject: '英語', count: 4 }], total: 4 }] },
    parentAuth: { configured: false }, ...overrides
  };
}
function invoice(overrides = {}) { return { id: 'test-invoice', ym: '2026-09', amount: 3000, status: '未入金', paymentRevision: 0, ...overrides }; }
async function ready(data = card()) {
  const ui = createUI('#s=' + data.id);
  assert.equal(ui.requests[0].body.op, 'kanriStudent');
  ui.requests[0].reply({ ok: true, data }); await flush();
  return ui;
}
function setPayment(ui) {
  ui.input('bill-date-test-invoice', '2026-09-01');
  ui.input('bill-method-test-invoice', '現金');
  ui.click('billing-paid', { 'data-invoice': 'test-invoice' });
}
function setFee(ui, rate) {
  ui.click('editfee'); ui.el('e-rate').value = String(rate); ui.el('e-monthly').value = '0'; ui.click('savefee');
}
function setPlan(ui, ym = '2026-09', count = 4) {
  ui.el('pl-scope').value = ym === 'default' ? 'default' : 'month';
  ui.el('pl-target').value = ym === 'default' ? '2026-09' : ym;
  ui.el('pl-subject').value = '英語'; ui.el('pl-count').value = String(count); ui.click('plansave');
}
function month(ym, revision) { return { ...card().plan.months[0], ym, revision }; }
function planCard(months, overrides = {}) { return card({ plan: { ...card().plan, months }, ...overrides }); }

test('count saves use the target month revision instead of the displayed month', async () => {
  const ui = await ready(planCard([month('2026-09', 2), month('2026-10', 7)]));
  assert.match(ui.html(), /2026-09 <span class="tag/);
  setPlan(ui, '2026-10', 6);
  const body = ui.requests.at(-1).body;
  assert.equal(body.op, 'planSet'); assert.equal(body.studentId, 'test-a');
  assert.equal(body.ym, '2026-10'); assert.equal(body.expectedRevision, 7);
  assert.equal(body.subject, '英語'); assert.equal(body.count, 6);
});

test('known months with an unavailable revision and missing month lists require refresh before saving', async () => {
  for (const data of [planCard([month('2026-09', undefined)]), card({ plan: { current: {}, defaultRows: [] } })]) {
    const ui = await ready(data), before = ui.requests.length;
    setPlan(ui);
    assert.equal(ui.requests.length, before);
    assert.match(ui.el('toast').textContent, /画面を更新/);
  }
});

test('new month count saves send revision zero while default changes omit it', async () => {
  const ui = await ready(); setPlan(ui, '2027-01');
  assert.equal(ui.requests.at(-1).body.expectedRevision, 0);
  assert.equal(ui.requests.at(-1).body.ym, '2027-01');
  const defaults = await ready(); setPlan(defaults, 'default');
  assert.equal(defaults.requests.at(-1).body.ym, 'default');
  assert.equal(Object.hasOwn(defaults.requests.at(-1).body, 'expectedRevision'), false);
});

test('an interrupted count save can be resent with the refreshed draft revision', async () => {
  const ui = await ready(planCard([month('2026-09', 3)])); setPlan(ui, '2026-09', 5);
  assert.equal(ui.requests.at(-1).body.expectedRevision, 3);
  ui.requests.at(-1).fail(); await flush();
  assert.equal(ui.requests.at(-1).body.op, 'kanriStudent');
  ui.requests.at(-1).reply({ ok: true, data: planCard([month('2026-09', 4)]) }); await flush();
  setPlan(ui, '2026-09', 5);
  assert.equal(ui.requests.at(-1).body.expectedRevision, 4);
  assert.equal(ui.requests.at(-1).body.count, 5);
});

test('a late background read cannot supply the revision for the next count save', async () => {
  const ui = await ready(planCard([month('2026-09', 1)]));
  ui.navigate('#students'); ui.navigate('#s=test-a'); const background = ui.requests.at(-1);
  setPlan(ui); ui.requests.at(-1).reply({ ok: true, data: planCard([month('2026-09', 2)]) }); await flush();
  background.reply({ ok: true, data: planCard([month('2026-09', 1)]) }); await flush();
  setPlan(ui); assert.equal(ui.requests.at(-1).body.expectedRevision, 2);
});

test('late responses for another student cannot supply a count save student or revision', async () => {
  const ui = await ready(planCard([month('2026-09', 1)])); ui.click('reload'); const oldRead = ui.requests.at(-1);
  ui.navigate('#s=test-b');
  ui.requests.at(-1).reply({ ok: true, data: planCard([month('2026-09', 8)], { id: 'test-b' }) }); await flush();
  oldRead.reply({ ok: true, data: planCard([month('2026-09', 99)]) }); await flush();
  setPlan(ui);
  assert.equal(ui.requests.at(-1).body.studentId, 'test-b');
  assert.equal(ui.requests.at(-1).body.expectedRevision, 8);
});

test('a failed student switch cannot save the previous student card still on screen', async () => {
  const ui = await ready(); ui.navigate('#s=test-b');
  ui.requests.at(-1).fail(); await flush();
  const before = ui.requests.length; setPlan(ui);
  assert.equal(ui.requests.length, before);
  assert.match(ui.el('toast').textContent, /画面を更新して生徒/);
});

test('late cached-card read cannot roll a completed payment back to unpaid', async () => {
  const before = card({ payments: [invoice()] }), after = card({ payments: [invoice({ status: '入金済', paidDate: '2026-09-01' })] });
  const ui = await ready(before);
  ui.navigate('#students'); ui.navigate('#s=test-a');
  const background = ui.requests.at(-1);
  assert.equal(background.body.op, 'kanriStudent');
  setPayment(ui);
  ui.requests.at(-1).reply({ ok: true, data: after }); await flush();
  assert.match(ui.html(), /data-action="billing-correct"/);
  background.reply({ ok: true, data: before }); await flush();
  assert.match(ui.html(), /data-action="billing-correct"/);
  assert.equal(ui.html().includes('data-action="billing-paid"'), false);
  assert.equal(JSON.parse(ui.local.get('sw_kanri_c'))['s:test-a'].data.payments[0].status, '入金済');
});

test('a payment response for another student does not cancel the current student read', async () => {
  const ui = await ready(card({ payments: [invoice()] })); setPayment(ui);
  const payment = ui.requests.at(-1);
  ui.navigate('#s=test-b'); const otherRead = ui.requests.at(-1);
  payment.reply({ ok: true, data: card({ payments: [invoice({ status: '入金済' })] }) }); await flush();
  otherRead.reply({ ok: true, data: card({ id: 'test-b', name: '【テスト】別生徒の画面' }) }); await flush();
  assert.match(ui.html(), /別生徒の画面/);
  assert.equal(ui.html().includes('test-invoice'), false);
});

test('unmodified proposal defaults refresh after a base-fee change at the same plan revision', async () => {
  const ui = await ready();
  assert.equal(ui.el('pl-rate-2026-09').value, '1500');
  setFee(ui, 2000); ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 2000 }) }); await flush();
  assert.equal(ui.el('pl-rate-2026-09').value, '2000');
});

test('an explicitly edited proposal fee survives a base-fee refresh', async () => {
  const ui = await ready(); ui.input('pl-rate-2026-09', '1750');
  setFee(ui, 2000); ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 2000 }) }); await flush();
  assert.equal(ui.el('pl-rate-2026-09').value, '1750');
});

test('invoice creation uses preview amount and repeats the same request after a network error', async () => {
  const ui = await ready();
  assert.equal(ui.el('p-amount'), undefined, 'no free-form invoice amount input');
  ui.click('billing-preview');
  ui.requests.at(-1).reply({ ok: true, billing: { ym: '2026-09', amount: 3000, mode: 'time', rate30: 1500, minutes: 60, count: 1, canBill: true, lessons: [] } }); await flush();
  ui.click('billing-issue'); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  assert.equal(payload.amount, 3000); assert.equal(payload.ym, '2026-09'); assert.equal(payload.billDate, undefined);
  const count = ui.requests.length; ui.click('billing-issue'); assert.equal(ui.requests.length, count);
  first.fail(); await flush(); ui.click('billing-retry');
  assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: true, data: card({ payments: [invoice()] }) }); await flush();
  assert.equal(ui.beforeUnload(), false);
  assert.equal(ui.html().includes('data-action="billing-retry"'), false);
});

test('payment corrections need a reason and target the invoice ID rather than a sheet row', async () => {
  const ui = await ready(card({ payments: [invoice({ status: '入金済' })] }));
  const start = ui.requests.length;
  assert.equal(ui.html().includes('data-action="billing-void"'), false);
  ui.click('billing-correct', { 'data-invoice': 'test-invoice' });
  assert.equal(ui.requests.length, start);
  ui.input('bill-correct-test-invoice', '実際には未入金だったため訂正');
  ui.click('billing-correct', { 'data-invoice': 'test-invoice' });
  assert.equal(ui.requests.at(-1).body.invoiceId, 'test-invoice');
  assert.equal(ui.requests.at(-1).body.unpaid, true);
  assert.equal(ui.requests.at(-1).body.expectedPaymentRevision, 0);
  assert.equal(ui.requests.at(-1).body.reason, '実際には未入金だったため訂正');
  assert.equal(ui.requests.at(-1).body.row, undefined);
  ui.requests.at(-1).reply({ ok: true, data: card({ payments: [invoice()] }) }); await flush();
  assert.match(ui.html(), /data-action="billing-void"/);
});

test('historical invoices retain their amount without inventing a zero-yen pricing formula', async () => {
  const bill = { ym: '2026-09', amount: 3000, mode: 'recorded', rate30: 0, monthly: 0, minutes: 0, count: 0, canBill: false, invoice: invoice({ lessons: [] }), lessons: [] };
  const ui = await ready(card({ billing: bill, payments: [invoice()] }));
  setFee(ui, 9999);
  ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 9999, billing: bill, payments: [invoice()] }) }); await flush();
  ui.click('billing-preview'); ui.requests.at(-1).reply({ ok: true, billing: bill }); await flush();
  assert.match(ui.html(), /3,000円/); assert.match(ui.html(), /当時の料金条件は未記録/);
  assert.equal(ui.html().includes('30分 0円'), false);
});

test('an old billing rejection preserves a newer teacher token and another student screen', async () => {
  const ui = await ready(); ui.click('billing-preview'); const old = ui.requests.at(-1);
  ui.local.set('sw_admt', 'replacement-teacher-token'); ui.navigate('#s=test-b');
  ui.requests.at(-1).reply({ ok: true, data: card({ id: 'test-b', name: '【テスト】新しいログイン' }) }); await flush();
  old.reply({ error: '古いログイン', badAuth: true }); await flush();
  assert.equal(ui.local.get('sw_admt'), 'replacement-teacher-token');
  assert.match(ui.html(), /新しいログイン/);
});


test('payment retries keep the original revision, date and method after edits to the visible fields', async () => {
  const ui = await ready(card({ payments: [invoice({ paymentRevision: 3 })] }));
  setPayment(ui); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  assert.equal(payload.expectedPaymentRevision, 3);
  first.fail(); await flush();
  ui.input('bill-date-test-invoice', '2026-09-02');
  ui.input('bill-method-test-invoice', '振込');
  ui.click('billing-retry');
  assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: true, data: card({ payments: [invoice({ status: '入金済', paymentRevision: 4, paidDate: '2026-09-01', method: '現金' })] }) }); await flush();
  assert.equal(ui.beforeUnload(), false);
});

test('correction retries preserve the payment revision and cannot silently adopt a newer payment', async () => {
  const ui = await ready(card({ payments: [invoice({ status: '入金済', paymentRevision: 7 })] }));
  ui.input('bill-correct-test-invoice', '最初に確認した誤登録');
  ui.click('billing-correct', { 'data-invoice': 'test-invoice' });
  const first = ui.requests.at(-1), payload = structuredClone(first.body);
  assert.equal(payload.expectedPaymentRevision, 7);
  first.fail(); await flush();
  ui.input('bill-correct-test-invoice', '後から変えた理由');
  ui.click('billing-retry'); assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ error: '支払記録が更新されています', errorCode: 'conflict' }); await flush();
  assert.equal(ui.html().includes('data-action="billing-retry"'), false);
  assert.match(ui.html(), /最新のカルテを確認/);
  ui.click('reload');
  ui.requests.at(-1).reply({ ok: true, data: card({ payments: [invoice({ status: '入金済', paymentRevision: 9 })] }) }); await flush();
  ui.click('billing-correct', { 'data-invoice': 'test-invoice' });
  assert.equal(ui.requests.at(-1).body.expectedPaymentRevision, 9);
  assert.equal(ui.requests.at(-1).body.reason, '後から変えた理由');
});
