'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createUI, flush} = require('./helpers/operations-ui-harness.cjs');
const today = '2026-09-23';
const lesson = (id, extra = {}) => ({id, date:today, start:'17:00', min:60, subject:'数学', kind:'通常', status:'booked', done:false, studentId:'test-a', studentName:'【テスト】生徒A', deliveryMode:'in_person', ...extra});
function data(extra = {}) {
  return {today, students:[{id:'test-a', name:'【テスト】生徒A', active:true, deliveryMode:'in_person'}], slots:[], blocked:[], teacherOff:[], wishes:[], events:[], plans:[], ...extra};
}
async function ready(extra = {}) {
  const ui = createUI('admin', {hash:'#lessons', now:today+'T12:00:00+09:00'});
  ui.requests[0].reply({admin:data(extra)}); await flush(); return ui;
}
function calendar(html) { return html.slice(html.indexOf('<div class="card cal">'), html.indexOf('<h2>9/', html.indexOf('<div class="card cal">'))); }
function dayDetails(html) { return html.slice(html.indexOf('の授業 '), html.indexOf('<h2>生徒からの希望日程')); }

test('one unfolded home-style month calendar replaces the weekly board at the top', async () => {
  const ui = await ready(); const html = ui.html();
  assert.equal((html.match(/class="card cal"/g)||[]).length, 1);
  assert.doesNotMatch(html, /class="schedule-board"|class="board-scroll"|data-board-time|月間予定表・選択日の詳細|data-action="board-new"/);
  assert.ok(html.indexOf('class="card cal"') < html.indexOf('<h2>生徒からの希望日程'));
  assert.ok(html.indexOf('class="card cal"') < html.indexOf('<details>'));
  assert.match(html, /class="calday[^\"]*today[^\"]*sel" data-action="calday" data-date="2026-09-23"/);
  assert.equal(ui.requests.length, 1);
});

test('month keeps every lesson label, time order, past/done and cancellation states', async () => {
  const slots = [lesson('later',{start:'19:00'}), lesson('offered',{start:'15:00',status:'offered'}), lesson('cancel',{start:'18:00',req:{reason:'【テスト】'}}), lesson('past',{date:'2026-09-21',done:true}), lesson('open',{date:'2026-09-20',status:'open',studentName:'SHOULD_NOT_APPEAR'})];
  const ui = await ready({slots}); const html = calendar(ui.html());
  const todayCell = html.match(/<button[^>]*data-date="2026-09-23"[^>]*>([\s\S]*?)<\/button>/)[1];
  const starts = [...todayCell.matchAll(/class="t">(\d{2}:\d{2})/g)].map(m => m[1]);
  assert.deepEqual(starts, ['15:00','18:00','19:00']);
  assert.match(html, /class="calbox of"/); assert.match(html, /class="calbox dn"/); assert.match(html, /class="calbox rq"/);
  assert.doesNotMatch(html, /SHOULD_NOT_APPEAR/);
  ui.click('calday', {'data-date':'2026-09-21'});
  assert.match(dayDetails(ui.html()), /実施済/);
  assert.match(dayDetails(ui.html()), /#lesson\?student=test-a&amp;slot=past/);
  assert.doesNotMatch(dayDetails(ui.html()), /data-action="calendar-add"/);
});

test('month navigation and empty day selection stay stable through re-rendering', async () => {
  const ui = await ready({slots:[lesson('future',{date:'2026-09-26'})]});
  ui.click('calnext'); assert.match(ui.html(), /class="callabel">2026年10月/);
  ui.click('calday', {'data-date':'2026-10-05'});
  ui.click('calendar-add'); assert.equal(ui.el('f-date').value, '2026-10-05');
  ui.change('f-student','test-a'); assert.equal(ui.el('f-date').value, '2026-10-05');
  ui.click('board-close');
  assert.match(ui.html(), /class="callabel">2026年10月/);
  assert.match(ui.html(), /data-action="calendar-add" data-date="2026-10-05"/);
  ui.click('calprev'); assert.match(ui.html(), /class="callabel">2026年9月/);
  assert.equal(ui.requests.length, 1);
});

test('selected offered lesson retains direct edit with the same slot ID and no delete request', async () => {
  const ui = await ready({slots:[lesson('offered',{status:'offered'})]});
  assert.match(dayDetails(ui.html()), /data-action="slotedit"/);
  ui.click('slotedit', {'data-id':'offered'});
  assert.equal(ui.el('se-date').value, today); assert.equal(ui.el('se-start').value,'17:00');
  ui.input('se-start','18:00'); ui.click('se-save');
  assert.equal(ui.requests.length,2);
  assert.equal(ui.requests[1].body.op,'editOffered');
  assert.equal(ui.requests[1].body.slotId,'offered');
  assert.equal(ui.requests[1].body.expectedSnapshot.start,'17:00');
  assert.equal(ui.requests[1].body.start,'18:00');
  ui.requests[1].reply({ok:true,admin:data({slots:[lesson('offered',{status:'offered',start:'18:00'})]})}); await flush();
  assert.match(ui.html(), /class="callabel">2026年9月/);
  assert.match(dayDetails(ui.html()), /18:00〜19:00/);
});

test('month retains shared events and teacher breaks; next-month wish opens a dated composer', async () => {
  const ui = await ready({teacherOff:[{id:'off',date:today,start:'13:00',end:'14:00'}], events:[{id:'event',studentId:'test-a',studentName:'【テスト】生徒A',date:today,dateTo:today,title:'【テスト】定期テスト'}], wishes:[{id:'wish',studentId:'test-a',studentName:'【テスト】生徒A',date:'2026-10-02',start:'16:00',end:'18:00',kind:'ok'}]});
  assert.match(calendar(ui.html()), /休み13-14/); assert.match(calendar(ui.html()), /【テスト】定期テスト/);
  assert.match(dayDetails(ui.html()), /data-action="tdeloff"/); assert.match(dayDetails(ui.html()), /data-action="delevent"/);
  ui.click('usewish', {'data-id':'wish'});
  assert.match(ui.html(), /class="callabel">2026年10月/);
  assert.equal(ui.el('f-date').value,'2026-10-02'); assert.equal(ui.el('f-student').value,'test-a');
  assert.equal(ui.el('f-start').value,'16:00'); assert.equal(ui.requests.length,1);
});
