'use strict';
// 管理画面「請求」ページ。実際の kanri/index.html のスクリプトを最小の DOM で動かす。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createUI, flush } = require('./helpers/operations-ui-harness.cjs');

const R = (o = {}) => ({ studentId: 'test-a', name: '【テスト】A', active: true, familyId: '', familyLabel: '', state: 'ready', note: '', summary: '英語 3回', amount: 4500, pendingAmount: 0, invoice: null, signature: '', ...o });
const overview = (rows, extra = {}) => ({ ym: '2026-09', current: '2026-10', closed: true, totals: { billed: 3000, paid: 0, unpaid: 3000, open: 4500, pending: 1500 }, rows, ...extra });
async function open(rows, extra) {
  const ui = createUI('admin', { hash: '#billing?ym=2026-09', now: '2026-10-05T12:00:00+09:00' });
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].body.op, 'billingOverview'); assert.equal(ui.requests[0].body.ym, '2026-09');
  ui.requests[0].reply({ ok: true, overview: overview(rows, extra) }); await flush();
  return ui;
}
const last = ui => ui.requests.at(-1);

test('the billing page lists every student for the month with one next action per row', async () => {
  const ui = await open([
    R(),
    R({ studentId: 'test-b', name: '【テスト】B', state: 'needApproval', note: '1件が授業計画の承認待ちです', summary: '', amount: 0, pendingAmount: 1500 }),
    R({ studentId: 'test-c', name: '【テスト】C <b>', state: 'unpaid', note: '10/01 に請求', amount: 3000, invoice: { id: 'inv-c', amount: 3000, paymentRevision: 2 } }),
  ]);
  const html = ui.html(), nav = ui.el('nav').innerHTML;
  assert.match(nav, /<a href="#billing" class="on">請求<\/a>/);
  assert.match(html, /<strong class="bo-month">2026年9月分<\/strong>/);
  assert.match(html, /href="#billing\?ym=2026-08">‹ 前の月/); assert.match(html, /href="#billing\?ym=2026-10">次の月 ›/);
  assert.match(html, /請求額の合計<\/span><b>7,500円<\/b>/, 'invoiced and still-to-invoice amounts are added');
  assert.match(html, /未入金<\/span><b class="ng">3,000円<\/b>/); assert.match(html, /承認待ち（請求の対象外）<\/span><b class="wait">1,500円<\/b>/);
  assert.match(html, /<span class="tag blue st">請求できます<\/span><div class="amt">4,500円<\/div><div class="act"><button class="btn-primary btn-sm" data-action="bo-issue" data-student="test-a">請求を記録<\/button>/);
  assert.match(html, /<span class="tag amber st">承認待ち<\/span><div class="amt">—<div class="small muted" style="font-weight:400">承認待ち 1,500円<\/div><\/div><div class="act"><a class="btn-quiet btn-sm" href="#plans\?student=test-b">計画を確認<\/a>/);
  assert.match(html, /【テスト】C &lt;b&gt;/, 'names are escaped');
  assert.doesNotMatch(html, /class="card/, 'the list is plain rows, not cards');

  ui.click('bo-issue', { 'data-student': 'test-a' });
  const issue = last(ui);
  assert.equal(issue.body.op, 'kanriAddPayment');
  assert.deepEqual([issue.body.studentId, issue.body.ym, issue.body.amount], ['test-a', '2026-09', 4500]);
  assert.match(issue.body.requestId, /^[A-Za-z0-9_-]{8,100}$/);
  assert.match(ui.html(), /保存中…/);
  ui.click('bo-pay-open', { 'data-student': 'test-c' }); assert.equal(ui.requests.length, 2, 'nothing else starts while a save is in flight');
  issue.reply({ ok: true }); await flush();
  assert.equal(last(ui).body.op, 'billingOverview', 'the list is re-read after a save');
  assert.equal(ui.requests.length, 3);
});

test('an unpaid invoice is settled in the list with the date, method and the payment revision the list showed', async () => {
  const ui = await open([R({ studentId: 'test-c', name: '【テスト】C', state: 'unpaid', amount: 3000, invoice: { id: 'inv-c', amount: 3000, paymentRevision: 2 } })]);
  assert.equal(ui.el('bo-date'), undefined);
  ui.click('bo-pay-open', { 'data-student': 'test-c' });
  assert.ok(ui.el('bo-date')); assert.equal(ui.el('bo-method').getAttribute('data-bo-field'), 'method');
  ui.input('bo-date', '2999-01-01'); ui.click('bo-pay-save', { 'data-student': 'test-c' });
  assert.equal(ui.requests.length, 1, 'a future payment date is not sent'); assert.match(ui.html(), /入金日は今日までの日付/);
  ui.input('bo-date', '2026-09-30'); ui.input('bo-method', '現金'); ui.click('bo-pay-save', { 'data-student': 'test-c' });
  const b = last(ui).body;
  assert.equal(b.op, 'kanriSetPaid');
  assert.deepEqual([b.studentId, b.invoiceId, b.date, b.method, b.expectedPaymentRevision], ['test-c', 'inv-c', '2026-09-30', '現金', 2]);
});

test('a transfer reported by the parent is confirmed for the whole family with the signature from the list', async () => {
  const ui = await open([R({ state: 'reported', familyId: 'fam-1', familyLabel: '【テスト】家族', signature: 'sig-1', amount: 3000, invoice: { id: 'inv-a', amount: 3000, paymentRevision: 0 } })]);
  assert.match(ui.html(), /入金の確認待ち/);
  ui.click('bo-confirm', { 'data-student': 'test-a' });
  const b = last(ui).body;
  assert.equal(b.op, 'familyConfirmTransfer'); assert.deepEqual([b.familyId, b.ym, b.signature], ['fam-1', '2026-09', 'sig-1']);
});

test('a rejected save keeps its reason on screen while the list is re-read', async () => {
  const ui = await open([R()]);
  ui.click('bo-issue', { 'data-student': 'test-a' });
  last(ui).reply({ error: '請求額が最新の実績・承認内容と一致しません', errorCode: 'conflict' }); await flush();
  assert.equal(last(ui).body.op, 'billingOverview');
  last(ui).reply({ ok: true, overview: overview([R({ amount: 3000 })]) }); await flush();
  assert.match(ui.html(), /請求額が最新の実績・承認内容と一致しません/);
  assert.match(ui.html(), /<div class="amt">3,000円<\/div>/, 'the fresh amount replaces the stale one');
});

test('a month still in progress and an empty month explain themselves', async () => {
  const ui = await open([R({ state: 'open', note: '実施 2回・これから 1回', amount: 3000 })], { closed: false, current: '2026-09' });
  assert.match(ui.html(), /実施済みの合計<\/span>/); assert.match(ui.html(), /この月はまだ途中です/);
  assert.match(ui.html(), /<span class="tag gray st">月の途中<\/span>/); assert.match(ui.html(), /href="#s=test-a&tab=billing">明細を見る/);
  const empty = await open([]);
  assert.match(empty.html(), /この月に授業・請求のある生徒はいません/);
});

// 請求の自動確定は翌月3日。1日・2日は確定待ちとして知らせる（2026-10-01）
test('during the checking days the page says when the month will be recorded', async () => {
  let ui = await open([R()], { closeOn: '2026-10-03', closeWaiting: true, closeDay: 3 });
  assert.match(ui.html(), /role="status">10月3日の0時10分に、請求できる状態の生徒の分が自動で請求として記録されます。/);
  assert.doesNotMatch(ui.html(), /毎月1日/);
  ui = await open([R()], { closeOn: '2026-10-03', closeWaiting: false, closeDay: 3 });
  assert.doesNotMatch(ui.html(), /role="status">10月3日/);
  assert.match(ui.html(), /前の月の分は、毎月3日に自動で請求として記録されます。/);
  ui = await open([R()], { closed: false, closeOn: '2026-11-03', closeWaiting: false, closeDay: 3 });
  assert.match(ui.html(), /翌月3日の0時10分に自動で請求として記録されます（1日・2日は内容を確かめる期間です）。/);
});
