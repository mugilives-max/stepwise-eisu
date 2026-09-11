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
    plan: { current: {}, defaultRows: [], lines: [line()] },
    parentAuth: { configured: false }, ...overrides
  };
}
function invoice(overrides = {}) { return { id: 'test-invoice', ym: '2026-09', amount: 3000, status: '未入金', paymentRevision: 0, ...overrides }; }
async function ready(data = card()) {
  const ui = createUI('#s=' + data.id + '&tab=billing');
  assert.equal(ui.requests[0].body.op, 'kanriStudent');
  ui.requests[0].reply({ ok: true, data }); await flush();
  return ui;
}
function setPayment(ui) {
  ui.input('bill-date-test-invoice', '2026-09-01');
  ui.input('bill-method-test-invoice', '現金');
  ui.click('billing-paid', { 'data-invoice': 'test-invoice' });
}
function setPlan(ui, count = 4) {
  ui.el('pl-subject').value = '英語'; ui.el('pl-count').value = String(count); ui.click('plansave');
}
function line(overrides = {}) { return { id: 'line-1', subject: '英語', kind: '', count: 4, approvedCount: null, startDate: '2026-09-01', endDate: '2026-09-30', period: '2026年9月', month: '2026-09', lessonMin: 90, rate30: 1500, lessonFee: 4500, comment: '', status: 'proposed', revision: 3, ...overrides }; }
function planCard(lines, overrides = {}) { return card({ plan: { ...card().plan, lines }, ...overrides }); }
function sendLine(ui, count) { ui.click('pe-open', { 'data-line': 'line-1' }); if (count != null) ui.input('pe-count', String(count)); ui.click('pe-send'); return ui.requests.at(-1).body; }

test('default count saves send subject, kind and count without a month or revision', async () => {
  const ui = await ready(planCard([line()]));
  assert.match(ui.html(), /<div class="plan-gr" data-line="line-1"><div class="plan-gc">英語<\/div><div class="plan-gc">通常<\/div><div class="plan-gc">4回<\/div><div class="plan-gc">9月<\/div><div class="plan-gc">90分<span class="sub">4,500円<\/span><\/div><\/div>/);
  setPlan(ui, 6);
  const body = ui.requests.at(-1).body;
  assert.equal(body.op, 'planSet'); assert.equal(body.studentId, 'test-a'); assert.equal(body.ym, undefined); assert.equal(Object.hasOwn(body, 'expectedRevision'), false);
  assert.equal(body.subject, '英語'); assert.equal(body.kind, '通常'); assert.equal(body.count, 6);
});

test('a line edit sends the line revision and keeps the editor after a network failure so it can be resent', async () => {
  const ui = await ready(planCard([line({ revision: 3 })]));
  const body = sendLine(ui, 5);
  assert.equal(body.op, 'planLineSave'); assert.equal(body.lineId, 'line-1'); assert.equal(body.expectedRevision, 3); assert.equal(body.count, 5); assert.equal(body.propose, true); assert.equal(body.lessonFee, 4500); assert.equal(body.startDate, '2026-09-01'); assert.equal(body.endDate, '2026-09-30');
  ui.requests.at(-1).fail(); await flush();
  assert.equal(ui.el('pe-count').value, '5'); assert.match(ui.html(), /入力は保持しています/);
  ui.click('pe-send'); assert.equal(ui.requests.at(-1).body.expectedRevision, 3); assert.equal(ui.requests.at(-1).body.count, 5);
  ui.requests.at(-1).reply({ ok: true, data: planCard([line({ revision: 4, count: 5 })]) }); await flush();
  assert.equal(ui.el('pe-count'), undefined, 'the editor closes after a successful save'); assert.match(ui.html(), /<div class="plan-gc">5回<\/div><div class="plan-gc">9月<\/div>/);
});

test('a late background read cannot supply the revision for the next line save', async () => {
  const ui = await ready(planCard([line({ revision: 1 })]));
  ui.navigate('#students'); ui.navigate('#s=test-a&tab=billing'); const background = ui.requests.at(-1);
  sendLine(ui); ui.requests.at(-1).reply({ ok: true, data: planCard([line({ revision: 2 })]) }); await flush();
  background.reply({ ok: true, data: planCard([line({ revision: 1 })]) }); await flush();
  assert.equal(sendLine(ui).expectedRevision, 2);
});

test('late responses for another student cannot supply a line save student or revision', async () => {
  const ui = await ready(planCard([line({ revision: 1 })])); ui.click('reload'); const oldRead = ui.requests.at(-1);
  ui.navigate('#s=test-b&tab=billing');
  ui.requests.at(-1).reply({ ok: true, data: planCard([line({ revision: 8 })], { id: 'test-b' }) }); await flush();
  oldRead.reply({ ok: true, data: planCard([line({ revision: 99 })]) }); await flush();
  const body = sendLine(ui);
  assert.equal(body.studentId, 'test-b'); assert.equal(body.expectedRevision, 8);
});

test('a failed student switch cannot save the previous student card still on screen', async () => {
  const ui = await ready(); ui.navigate('#s=test-b&tab=billing');
  ui.requests.at(-1).fail(); await flush();
  const before = ui.requests.length; setPlan(ui);
  assert.equal(ui.requests.length, before);
  assert.match(ui.el('toast').textContent, /画面を更新して生徒/);
});

test('late cached-card read cannot roll a completed payment back to unpaid', async () => {
  const before = card({ payments: [invoice()] }), after = card({ payments: [invoice({ status: '入金済', paidDate: '2026-09-01' })] });
  const ui = await ready(before);
  ui.navigate('#students'); ui.navigate('#s=test-a&tab=billing');
  const background = ui.requests.at(-1);
  assert.equal(background.body.op, 'kanriStudent');
  setPayment(ui);
  ui.requests.at(-1).reply({ ok: true, data: after }); await flush();
  assert.match(ui.html(), /data-action="billing-correct"/);
  background.reply({ ok: true, data: before }); await flush();
  assert.match(ui.html(), /data-action="billing-correct"/);
  assert.equal(ui.html().includes('data-action="billing-paid"'), false);
  assert.equal(JSON.parse(ui.local.get('sw_kanri_sections_v1'))['s:test-a:billing'].data.payments[0].status, '入金済');
});

test('a payment response for another student does not cancel the current student read', async () => {
  const ui = await ready(card({ payments: [invoice()] })); setPayment(ui);
  const payment = ui.requests.at(-1);
  ui.navigate('#s=test-b&tab=billing'); const otherRead = ui.requests.at(-1);
  payment.reply({ ok: true, data: card({ payments: [invoice({ status: '入金済' })] }) }); await flush();
  otherRead.reply({ ok: true, data: card({ id: 'test-b', name: '【テスト】別生徒の画面' }) }); await flush();
  assert.match(ui.html(), /別生徒の画面/);
  assert.equal(ui.html().includes('test-invoice'), false);
});

test('a new line is prefilled from the current base fee and an explicitly edited fee survives a refresh', async () => {
  const ui = await ready(); ui.click('pe-new');
  assert.equal(ui.el('pe-fee').value, '4500'); assert.equal(ui.el('pe-min').value, '90'); assert.equal(ui.el('pe-start').value, '2026-09-01'); assert.equal(ui.el('pe-end').value, '2026-09-30');
  ui.click('pe-cancel'); ui.click('reload'); ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 2000 }) }); await flush();
  ui.click('pe-new'); assert.equal(ui.el('pe-fee').value, '6000');
  ui.input('pe-fee', '5250'); ui.click('pe-month', { 'data-ym': '2026-11' });
  ui.click('reload'); ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 2500 }) }); await flush();
  assert.equal(ui.el('pe-fee').value, '5250'); assert.equal(ui.el('pe-start').value, '2026-11-01'); assert.equal(ui.el('pe-end').value, '2026-11-30');
  ui.click('pe-draft'); const body = ui.requests.at(-1).body;
  assert.equal(body.op, 'planLineSave'); assert.equal(body.propose, false); assert.equal(body.lineId, undefined); assert.equal(body.lessonFee, 5250); assert.equal(body.startDate, '2026-11-01');
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
  ui.click('reload');
  ui.requests.at(-1).reply({ ok: true, data: card({ rate30: 9999, billing: bill, payments: [invoice()] }) }); await flush();
  ui.click('billing-preview'); ui.requests.at(-1).reply({ ok: true, billing: bill }); await flush();
  assert.match(ui.html(), /3,000円/); assert.match(ui.html(), /当時の料金条件は未記録/);
  assert.equal(ui.html().includes('30分 0円'), false);
});

test('an old billing rejection preserves a newer teacher token and another student screen', async () => {
  const ui = await ready(); ui.click('billing-preview'); const old = ui.requests.at(-1);
  ui.local.set('sw_admt', 'replacement-teacher-token'); ui.navigate('#s=test-b&tab=billing');
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
