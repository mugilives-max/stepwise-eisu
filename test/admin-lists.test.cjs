'use strict';
// 管理画面の「生徒一覧」「計画」: カードではなく1人1行の一覧。
const test = require('node:test'), assert = require('node:assert/strict');
const { createUI, flush } = require('./helpers/operations-ui-harness.cjs');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');

const student = (o = {}) => ({ id: 'test-a', name: '【テスト】A', grade: '中2', school: '架空中', status: '在籍', doneThisMonth: 1, bookedThisMonth: 3, plannedThisMonth: 4, feeThisMonth: 4500, planStatus: 'approved', planNext: { status: 'proposed', total: 4 }, next: { date: '2026-10-07', start: '17:00' }, unpaid: 0, ...o });
const dashboard = (students, extra = {}) => ({ today: '2026-10-01', month: '2026-10', nextMonth: '2026-11', students, inactive: [], lessonKinds: [], ...extra });
async function open(hash, data) {
  const ui = createUI('admin', { hash, now: '2026-10-01T12:00:00+09:00' });
  for (const r of ui.requests) {
    if (r.body.op === 'kanriDashboard') r.reply({ ok: true, data });
    else if (r.body.op === 'familyList') r.reply({ ok: true, families: [], students: [], paymentReports: [] });
  }
  await flush(); return ui;
}

test('the student list is one row per student with the next lesson and this month at a glance', async () => {
  const ui = await open('#students', dashboard([
    student(),
    student({ id: 'test-b', name: '【テスト】B <i>', grade: '', school: '', status: '休会', next: null, doneThisMonth: 0, bookedThisMonth: 0, feeThisMonth: 0, unpaid: 1 }),
  ], { inactive: [{ id: 'test-z', name: '【テスト】停止' }] }));
  const html = ui.html();
  assert.match(html, /<div class="sl-cols"><span>生徒<\/span><span>状態<\/span><span>次の授業<\/span><span>今月<\/span><\/div>/);
  assert.match(html, /<a class="sl-row" href="#s=test-a"><span><span class="nm">【テスト】A<\/span><div class="small muted">中2・架空中<\/div><\/span><span><\/span><span class="small num">10\/7\(水\) 17:00<\/span><span class="small num">実施 1回・登録 3回<div class="muted">4,500円<\/div><\/span><\/a>/);
  assert.match(html, /【テスト】B &lt;i&gt;<\/span><div class="small muted">学年・学校 未登録<\/div><\/span><span><span class="tag gray">休会<\/span> <span class="tag red">未入金<\/span><\/span><span class="small num"><span class="muted">予定なし<\/span><\/span><span class="small num">実施 0回<\/span>/);
  assert.match(html, /予約ページから外した生徒 <span class="cnt">1人<\/span>/); assert.match(html, /href="#s=test-z"><span class="nm muted">【テスト】停止/);
  assert.doesNotMatch(html.split("グループの管理")[0], /class="card/, "no cards in the student list"); assert.match(html, /^<div class="flat">/);

  assert.equal(ui.el('n-name'), undefined);
  ui.click('newstudent-open');
  assert.match(ui.html(), /<div class="sl-panel" role="region" aria-label="生徒を追加">/);
  ui.input('n-name', '【テスト】追加'); ui.click('addstudent');
  assert.equal(ui.requests.at(-1).body.op, 'addStudent'); assert.equal(ui.requests.at(-1).body.name, '【テスト】追加');
});

test('the plan page shows this month and next month plan status per student and links to the plan editor', async () => {
  const ui = await open('#plans', dashboard([
    student(),
    student({ id: 'test-b', name: '【テスト】B', planStatus: 'none', plannedThisMonth: 0, bookedThisMonth: 1, planNext: { status: 'none', total: 0 } }),
    student({ id: 'test-c', name: '【テスト】C', planNext: undefined }),
  ]));
  const html = ui.html();
  assert.match(html, /<div class="sl-cols"><span>生徒<\/span><span>10月の計画<\/span><span>10月の回数<\/span><span>11月の計画<\/span><\/div>/);
  assert.match(html, /<a class="sl-row" href="#plans\?student=test-a"><span class="nm">【テスト】A<\/span><span><span class="sl-m">10月 <\/span><span class="tag green">承認済み<\/span><\/span><span class="small num">計画 4回・登録 3回<\/span><span class="small num"><span class="sl-m">11月 <\/span><span class="tag amber">承認待ち<\/span> 4回<\/span><\/a>/);
  assert.match(html, /href="#plans\?student=test-b">.*?<span class="tag gray">未作成<\/span><\/span><span class="small num"><span class="muted">登録 1回<\/span><\/span><span class="small num"><span class="sl-m">11月 <\/span><span class="tag gray">未作成<\/span><\/span>/);
  assert.match(html, /href="#plans\?student=test-c">.*?<span class="sl-m">11月 <\/span><span class="muted">—<\/span>/, 'data cached before this release has no next-month status');
  assert.doesNotMatch(html, /class="card/);
});

test('the dashboard reports next month plan status for each student', () => {
  const h = createBillingHarness();
  const save = (ym, end, propose) => { const r = h.admin('planLineSave', { studentId: 'test-a', subject: '数学', kind: '通常', count: 3, startDate: ym + '-01', endDate: ym + '-' + end, lessonMin: 60, lessonFee: 3000, propose }); assert.ok(r.ok, JSON.stringify(r)); };
  save('2026-09', '30', false); save('2026-10', '31', true);
  const d = h.admin('kanriDashboard').data, a = d.students.find(s => s.id === 'test-a'), b = d.students.find(s => s.id === 'test-b');
  assert.equal(d.month, '2026-09'); assert.equal(d.nextMonth, '2026-10');
  assert.equal(a.planStatus, 'draft'); assert.deepEqual(JSON.parse(JSON.stringify(a.planNext)), { status: 'proposed', total: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(b.planNext)), { status: 'none', total: 0 });
});

test('the student page uses underlined tabs, flat sections, and puts basic information before documents', async () => {
  const { adminReady, card } = require('./helpers/operations-ui-harness.cjs');
  const ui = await adminReady(card(), 'settings'), html = ui.html();
  assert.match(html, /^<div class="flat">/, 'sections are not wrapped in cards');
  assert.match(html, /<div class="tabs" role="navigation" aria-label="生徒のページ"><a class="" href="#s=[^"]+&tab=overview">予定<\/a>/);
  assert.match(html, /<a class="on" href="#s=[^"]+&tab=settings" aria-current="page">生徒設定<\/a>/);
  const order = ['<h2>基本情報', '<h2>授業の標準形式</h2>', '<h2>資料</h2>'].map(t => html.indexOf(t));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
});
