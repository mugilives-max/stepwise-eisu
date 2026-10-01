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
function calendar(html) { return html.slice(html.indexOf('<div class="card cal">'), html.indexOf('<h2 class="schedule-day-heading">', html.indexOf('<div class="card cal">'))); }
function dayDetails(html) { return html.slice(html.indexOf('<h2 class="schedule-day-heading">'), html.indexOf('id="lesson-attention"')); }
// 授業の詳細ダイアログ(詳細 → 授業内容を編集)の欄は id を持たず data-slot-edit で識別される。ハーネスの ui.input は id で
// 要素を探すため、表示中で操作できる欄であることを確かめてから、同じ data-slot-edit を持つ入力イベントをダイアログ要素経由で送る。
function slotDialog(ui) { const html = ui.html(), start = html.indexOf('<dialog id="slot-editor"'); assert.ok(start >= 0, 'visible dialog: slot-editor'); return html.slice(start, html.indexOf('</dialog>', start)); }
function slotField(ui, prop, value) {
  const field = slotDialog(ui).match(new RegExp('<(?:input|select) [^>]*data-slot-edit="' + prop + '"[^>]*>'));
  assert.ok(field && !/ disabled/.test(field[0]), 'visible field: ' + prop);
  const dialog = ui.el('slot-editor'); dialog.attrs['data-slot-edit'] = prop; ui.input('slot-editor', value); delete dialog.attrs['data-slot-edit'];
}

test('one unfolded home-style month calendar replaces the weekly board at the top', async () => {
  const ui = await ready(); const html = ui.html();
  assert.equal((html.match(/class="card cal"/g)||[]).length, 1);
  assert.doesNotMatch(html, /class="schedule-board"|class="board-scroll"|data-board-time|月間予定表・選択日の詳細|data-action="board-new"/);
  assert.ok(html.indexOf('class="card cal"') < html.indexOf('id="lesson-attention"'));
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
  assert.match(html, /class="calbox of admin-pending"/); assert.match(html, /class="calbox needs-attention"/); assert.match(html, /class="calbox admin-ok"/);
  assert.doesNotMatch(html, /SHOULD_NOT_APPEAR/);
  ui.click('calday', {'data-date':'2026-09-21'});
  // 通常の「実施済」バッジは省略(1ec9f94)。実施済みは授業記録の状態タグと修正ボタンの data-done で表す。
  assert.match(dayDetails(ui.html()), /href="#lesson\?student=test-a&amp;slot=past" title="授業記録を開く">未記入<\/a>/);
  assert.match(dayDetails(ui.html()), /data-action="slotedit" data-done="1" data-id="past" data-sid="test-a"/);
  // 過去日の＋は授業の案内ではなく「実施済みの授業を追加」(3e8b3d7)。開いても案内は送らない。
  assert.match(dayDetails(ui.html()), /data-action="calendar-add" data-date="2026-09-21" aria-label="実施済みの授業を追加"/);
  assert.doesNotMatch(dayDetails(ui.html()), /この日に予定を追加/);
  ui.click('calendar-add', {'data-date':'2026-09-21'});
  assert.match(ui.html(), /data-action="performed-save"/); assert.doesNotMatch(ui.html(), /data-action="offerslot"/);
  assert.equal(ui.requests.length, 1);
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
  // 詳細はまず表で開き、「授業内容を編集」で同じ表の中の欄を直接直す(24e19b1)。削除・取り下げの操作は押さない
  assert.equal(ui.el('slot-editor').modal, true); ui.click('se-content');
  assert.match(slotDialog(ui), /data-slot-edit="date" type="date" value="2026-09-23"/); assert.match(slotDialog(ui), /data-slot-edit="start" type="time" value="17:00"/);
  slotField(ui, 'start', '18:00'); ui.click('se-detail-save');
  assert.equal(ui.requests.length,2);
  assert.equal(ui.requests[1].body.op,'editOffered');
  assert.equal(ui.requests[1].body.slotId,'offered');
  assert.equal(ui.requests[1].body.expectedSnapshot.start,'17:00');
  assert.equal(ui.requests[1].body.start,'18:00');
  ui.requests[1].reply({ok:true,admin:data({slots:[lesson('offered',{status:'offered',start:'18:00'})]})}); await flush();
  assert.match(ui.html(), /class="callabel">2026年9月/);
  assert.match(dayDetails(ui.html()), /18:00〜19:00/);
});

test('month retains shared events and teacher breaks without the wishes list', async () => {
  const ui = await ready({teacherOff:[{id:'off',date:today,start:'13:00',end:'14:00'}], events:[{id:'event',studentId:'test-a',studentName:'【テスト】生徒A',date:today,dateTo:today,title:'【テスト】定期テスト'}], wishes:[{id:'wish',studentId:'test-a',studentName:'【テスト】生徒A',date:'2026-10-02',start:'16:00',end:'18:00',kind:'ok'}]});
  assert.match(calendar(ui.html()), /13:00-<wbr>14:00<\/span><span class="s">休み/); assert.match(calendar(ui.html()), /【テスト】定期テスト/);
  assert.match(dayDetails(ui.html()), /data-action="tdeloff"/); assert.match(dayDetails(ui.html()), /data-action="delevent"/);
  assert.doesNotMatch(ui.html(), /生徒からの希望日程|data-action="usewish"/);
});


test('attention list selects missing completed records and cancellation requests without duplicates', async () => {
  const slots = [lesson('missing',{done:true,date:'2026-09-20',lessonRecordStatus:'none'}),
    lesson('draft',{done:true,date:'2026-09-21',lessonDraftStatus:'draft'}),
    lesson('recorded',{done:true,lessonRecordStatus:'active'}), lesson('upcoming'),
    lesson('cancel',{date:'2026-09-28',req:{reason:'【テスト】都合変更'}}),
    lesson('both',{done:true,req:{reason:'【テスト】確認'}})];
  const ui = await ready({slots});
  const section = ui.html().match(/<section id="lesson-attention">([^]*?)<\/section>/)[1];
  assert.match(section, /4件/); assert.match(section, /記録を再開/); assert.match(section, /【テスト】都合変更/);
  assert.equal((section.match(/class="line"/g)||[]).length,4);
  assert.doesNotMatch(section, /slot=recorded|slot=upcoming/);
  assert.doesNotMatch(ui.html(), /<summary>承認待ちの案内|生徒からの希望日程/);
  ui.click('cancelkeep',{'data-id':'cancel'});
  assert.equal(ui.requests.at(-1).body.op,'resolveCancel');
  assert.equal(ui.requests.at(-1).body.slotId,'cancel');
  assert.equal(ui.requests.at(-1).body.approve,false);
  ui.requests.at(-1).reply({admin:data({slots:slots.map(s=>s.id==='cancel'?{...s,req:null}:s)})}); await flush();
  assert.match(ui.html().match(/<section id="lesson-attention">([^]*?)<\/section>/)[1], /3件/);
});


test('admin calendar colors depend on required action rather than past dates', async () => {
  const ui=await ready({slots:[
    lesson('healthy',{date:'2026-09-20',done:true,lessonRecordStatus:'active'}),
    lesson('missing',{date:'2026-09-21',done:true,lessonRecordStatus:'none'}),
    lesson('unregistered',{date:'2026-09-22'}),
    lesson('future',{date:'2026-09-24'}),
    lesson('cancel',{date:'2026-09-25',req:{reason:'【テスト】'}})
  ]});
  const html=calendar(ui.html());
  for(const [date,cls] of [['20','admin-ok'],['21','needs-attention'],['22','needs-attention'],['24','admin-ok'],['25','needs-attention']]) {
    const cell=html.match(new RegExp('data-date="2026-09-'+date+'"[^>]*>([^]*?)</button>'))[1];
    assert.ok(cell.includes('calbox '+cls),date);
    assert.doesNotMatch(cell,/記録なし|実施未登録|calbox dn/);
  }
});

test('pending offers appear in attention with their edit action', async()=>{
 const ui=await ready({slots:[lesson('pending',{status:'offered'})]});
 const section=ui.html().match(/<section id="lesson-attention">([^]*?)<\/section>/)[1];
 assert.match(section,/1件/); assert.match(section,/承認待ち/); assert.match(section,/data-action="slotedit"/);
 assert.doesNotMatch(ui.html(),/<summary>承認待ちの案内/);
});

test('attention pending range includes today through two days later and groups collapse', async()=>{
 const ui=await ready({slots:[-1,0,1,2,3].map(n=>lesson('pending'+n,{status:'offered',date:'2026-09-'+String(23+n)}))});
 const section=ui.html().match(/<section id="lesson-attention">([^]*?)<\/section>/)[1];
 assert.match(section,/3件/);
 for(const n of [0,1,2]) assert.ok(section.includes('data-id="pending'+n+'"'));
 for(const n of [-1,3]) assert.ok(!section.includes('data-id="pending'+n+'"'));
 assert.match(section,/<details class="card"/);
 assert.doesNotMatch(section,/<details[^>]*open/);
});

test('AI schedule registration parses for the selected student before applying', async()=>{
 const ui=await ready(); ui.click('ai-open');ui.input('ai-student','test-a');
 ui.input('tnl-text','明日17時から60分、数学');ui.click('tnl-parse');
 const req=ui.requests.at(-1);assert.equal(req.body.op,'scheduleParseTeacher');assert.equal(req.body.studentId,'test-a');
 req.reply({items:[{kind:'offer',dates:['2026-09-24'],start:'17:00',min:60,subject:'数学'}]});await flush();
 assert.match(ui.html(),/チェックした内容で登録する/);
 ui.click('tnl-register');const apply=ui.requests.at(-1);assert.equal(apply.body.op,'nlApplyTeacher');assert.equal(apply.body.studentId,'test-a');assert.equal(apply.body.items[0].subject,'数学');
});

test('AI schedule starts with student and text together, preserving text across selection',async()=>{const ui=await ready();ui.click('ai-open');assert.ok(ui.el('tnl-text'));assert.ok(ui.el('ai-student'));assert.equal((ui.html().match(/id="ai-schedule"/g)||[]).length,1);ui.input('tnl-text','明日の17時から数学');const before=ui.requests.length;ui.click('tnl-parse');assert.equal(ui.requests.length,before);ui.input('ai-student','test-a');assert.equal(ui.el('tnl-text').value,'明日の17時から数学');ui.click('tnl-parse');assert.equal(ui.requests.at(-1).body.studentId,'test-a');});
