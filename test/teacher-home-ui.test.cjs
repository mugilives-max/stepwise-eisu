'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createUI, flush} = require('./helpers/operations-ui-harness.cjs');
// 管理ホーム(#home)は授業の予定表(state)を表示する。旧ホーム(kanriDashboard)の画面は使われていない。
const day = '2026-09-23';
const slot = (id, patch={}) => ({id, studentId:'test-a', studentName:'【テスト】生徒A', date:day, start:'17:00', min:60, status:'booked', done:false, subject:'数学', kind:'夏期講習', deliveryMode:'in_person', lessonRecordStatus:'none', lessonDraftStatus:'none', ...patch});
const data = (patch={}) => ({today:day, students:[{id:'test-a', name:'【テスト】生徒A', active:true, deliveryMode:'in_person'}], slots:[], blocked:[], teacherOff:[], wishes:[], events:[], plans:[], lessonKinds:[{name:'通常',active:true},{name:'夏期講習',active:true}], ...patch});
// 授業の詳細の入力欄には id がないので、テストのときだけ id を付けて入力できるようにする
const detailIds = src => { const from = `'<input aria-label="'+esc(prop)+'" data-slot-edit="'`; assert.ok(src.includes(from), 'detail input template'); return src.replace(from, `'<input id="se-detail-'+prop+'" aria-label="'+esc(prop)+'" data-slot-edit="'`); };
async function ready(patch={}, window={}) {
  const ui=createUI('admin',{hash:'#home', now:day+'T12:00:00+09:00', window, source:detailIds});
  assert.equal(ui.requests[0].body.op,'state');
  ui.requests[0].reply({admin:data(patch)});await flush();return ui;
}
const daySection = html => html.slice(html.indexOf('<h2 class="schedule-day-heading">'), html.indexOf('<section id="lesson-attention">'));
const attention = html => html.match(/<section id="lesson-attention">[^]*?<\/section>/)[0];
const row = (html,id) => html.match(new RegExp('<div class="line">(?:(?!<div class="line">)[^])*?data-id="'+id+'"[^]*?</div>'))[0];
const cell = (html,date) => html.match(new RegExp('<button[^>]*data-date="'+date+'"[^]*?</button>'))[0];
const sel = (html,date) => new RegExp('class="calday[^"]*\\bsel\\b[^"]*" data-action="calday" data-date="'+date+'"').test(html);

test('home opens on the lesson calendar with today first and booked/offered kept distinct',async()=>{
  const a=slot('a',{start:'19:00'}), b=slot('b',{start:'16:00',status:'offered'});
  const ui=await ready({slots:[a,b,slot('future',{date:'2026-09-24'})]});
  const h=ui.html(), section=daySection(h);
  assert.ok(sel(h,day),'today is selected');
  assert.match(section,/9\/23\(水\)の授業/);
  assert.ok(h.indexOf('schedule-day-heading')<h.indexOf('id="lesson-attention"'));
  assert.equal((section.match(/data-action="slotedit"[^>]*data-id="a"/g)||[]).length,1);
  assert.ok(section.indexOf('data-id="b"')<section.indexOf('data-id="a"'));
  assert.match(row(section,'b'),/data-action="teacher-book-open" data-id="b">承認待ち/);
  assert.doesNotMatch(row(section,'a'),/承認待ち/);
  assert.match(row(section,'a'),/data-status="booked"/);assert.match(row(section,'b'),/data-status="offered"/);
  assert.doesNotMatch(section,/data-id="future"/);
  assert.match(cell(h,day),/calbox of admin-pending"><span class="t">16:00[^]*calbox admin-ok"><span class="t">19:00/);
  assert.equal(ui.requests.length,1,'rendering must not mutate or fetch every student');
});

test('empty today still exposes schedule and record queue without claiming all work finished',async()=>{
  const ui=await ready({slots:[slot('past',{date:'2026-09-22',done:true})]});
  assert.match(daySection(ui.html()),/この日の授業はありません/);
  assert.match(attention(ui.html()),/授業記録の未記入[^]*#lesson\?student=test-a&amp;slot=past[^]*記録を入力/);
  assert.doesNotMatch(ui.html(),/すべて完了|宿題共有済み|保護者確認済み/);
});

test('execution and record status remain independent with correct record links',async()=>{
  const ui=await ready({slots:[slot('done',{start:'09:00',done:true}),slot('saved',{start:'10:00',lessonRecordStatus:'active'}),slot('draft',{start:'10:30',done:true,lessonDraftStatus:'draft'}),slot('void',{start:'11:00',lessonRecordStatus:'void'})]});
  const section=daySection(ui.html());
  assert.match(row(section,'done'),/#lesson\?student=test-a&amp;slot=done[^]*未記入[^]*data-done="1"/);
  assert.match(row(section,'saved'),/data-done="0"[^]*#lesson\?student=test-a&amp;slot=saved">記録済み/);
  assert.match(row(section,'void'),/data-done="0"[^]*#lesson\?student=test-a&amp;slot=void">無効化済み/);
  assert.match(attention(ui.html()),/slot=draft">記録を再開/);
  ui.click('slotedit',{'data-id':'saved'});ui.click('se-content');ui.input('detail-done','true');ui.click('se-detail-save');
  assert.deepEqual([ui.requests.at(-1).body.op,ui.requests.at(-1).body.slotId,ui.requests.at(-1).body.studentId,ui.requests.at(-1).body.done],['toggleDone','saved','test-a',true]);
});

test('unconfirmed offer edits keep ID, kind, snapshot and input; no delete is sent',async()=>{
  const s=slot('offered',{date:'2026-09-25',status:'offered'}),ui=await ready({slots:[s]});
  ui.click('calday',{'data-date':s.date});ui.click('slotedit',{'data-id':s.id});ui.click('se-content');
  assert.equal(ui.el('se-detail-date').value,'2026-09-25');assert.equal(ui.el('se-detail-start').value,'17:00');
  ui.input('se-detail-start','18:00');ui.click('se-detail-save');
  const r=ui.requests.at(-1), sent=structuredClone(r.body);
  assert.deepEqual([sent.op,sent.slotId,sent.start,sent.kind,sent.expectedSnapshot.start],['editOffered','offered','18:00','夏期講習','17:00']);
  r.fail();await flush();assert.match(ui.html(),/同じ内容で結果を確認/);ui.click('se-detail-save');assert.deepEqual(ui.requests.at(-1).body,sent);
  ui.requests.at(-1).reply({ok:true,admin:data({slots:[{...s,start:'18:00'}]})});await flush();
  assert.match(row(daySection(ui.html()),'offered'),/18:00〜19:00/);assert.equal(ui.el('slot-editor'),undefined);
  assert.equal(ui.requests.some(r=>r.body.op==='deleteSlot'),false);
});

test('cancel requests keep reasons and explicit decision actions',async()=>{
  const ui=await ready({slots:[slot('cancel',{date:'2026-09-24',req:{requestType:'exception',reason:'【テスト】体調不良',at:'2026-09-22T03:00:00Z'}})]});
  assert.match(attention(ui.html()),/取消依頼 <span class="cnt">1件[^]*取消依頼中[^]*【テスト】体調不良[^]*data-action="cancelok"[^]*data-action="cancelkeep"/);
  ui.click('cancelkeep',{'data-id':'cancel'});
  assert.equal(ui.requests.at(-1).body.op,'resolveCancel');assert.equal(ui.requests.at(-1).body.approve,false);
  assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.slotId,'cancel');
});

test('execution checks, expired offers, bills and wishes remain reachable',async()=>{
  const expired=slot('expired',{date:'2026-09-22',status:'offered'});
  const ui=await ready({slots:[slot('unrecorded',{date:'2026-09-22',start:'15:00'}),expired],wishes:[{id:'wish',studentId:'test-a',date:'2026-09-25',studentName:'【テスト】A',start:'17:00',end:'19:00',note:'希望'}]});
  assert.match(cell(ui.html(),'2026-09-22'),/calbox needs-attention"><span class="t">15:00/);
  assert.match(ui.html(),/返事がないまま終わった案内[^]*data-action="finishoffered" data-id="expired"[^]*data-action="delslot" data-id="expired"[^]*data-mode="noshow"/);
  assert.match(ui.el('nav').innerHTML,/href="#billing"/);
  assert.match(cell(ui.html(),'2026-09-25'),/希 /);
  ui.click('calday',{'data-date':'2026-09-22'});ui.click('slotedit',{'data-id':'unrecorded'});ui.click('se-content');ui.input('detail-done','true');ui.click('se-detail-save');
  assert.deepEqual([ui.requests.at(-1).body.op,ui.requests.at(-1).body.slotId,ui.requests.at(-1).body.done],['toggleDone','unrecorded',true]);
});

test('teacher contact inbox remains reachable from home',async()=>{
  let mounted;
  await ready({}, {StepwiseServices:{mount:(host,cfg)=>{mounted={host,cfg};},clear(){}}});
  assert.ok(mounted,'contact inbox is mounted on home');assert.equal(mounted.cfg.inbox,true);assert.equal(mounted.cfg.teacher,true);
});

test('record navigation and return keep the home calendar active',async()=>{
  const s=slot('record',{start:'10:00',done:true});const ui=await ready({slots:[s]});
  ui.navigate('#lesson?student=test-a&slot=record');
  assert.equal(ui.requests.at(-1).body.op,'lessonContext');
  ui.navigate('#home');assert.equal(ui.requests.at(-1).body.op,'state');ui.requests.at(-1).reply({admin:data({slots:[{...s,lessonRecordStatus:'active'}]})});await flush();
  assert.match(row(daySection(ui.html()),'record'),/slot=record" title="授業記録を開く">記入済/);assert.match(ui.html(),/class="card cal"/);
});

test('names and pending reasons are escaped on home',async()=>{
  const s=slot('unsafe',{studentName:'<script>bad</script>',req:{reason:'<img src=x onerror=bad>'}});
  const ui=await ready({slots:[s],cancellations:[{id:'c',studentId:'test-a',studentName:'<script>bad</script>',date:day,start:'13:00',min:60,subject:'英語',label:'欠席',amount:1000,relief:{status:'pending',requestId:'r',reason:'<img src=x onerror=bad>'}}]});
  assert.doesNotMatch(ui.html(),/<script>bad|<img src=x/);assert.match(ui.html(),/&lt;script&gt;bad/);assert.match(ui.html(),/&lt;img src=x onerror=bad&gt;/);
});

test('an ended offer is not treated as confirmed',async()=>{
  const s=slot('ended',{status:'offered',start:'09:00'}),ui=await ready({slots:[s]});
  assert.match(row(daySection(ui.html()),'ended'),/data-status="offered"/);
  assert.doesNotMatch(row(daySection(ui.html()),'ended'),/#lesson\?|未記録|未記入/);
  assert.match(cell(ui.html(),day),/calbox of admin-pending"><span class="t">09:00/);
  assert.doesNotMatch(attention(ui.html()),/授業記録の未記入|取消依頼/);
  assert.match(ui.html(),/返事がないまま終わった案内[^]*data-action="finishoffered" data-id="ended"/);
});

test('selecting a date replaces the day list, preserves its real actions and supports empty dates',async()=>{
  const ui=await ready({slots:[slot('today'),slot('future',{date:'2026-09-25',status:'offered'}),slot('past',{date:'2026-09-15',done:true})]});
  ui.click('calday',{'data-date':'2026-09-25'});
  assert.match(daySection(ui.html()),/9\/25\(金\)の授業/);
  assert.match(daySection(ui.html()),/data-action="slotedit"[^>]*data-id="future"/);
  assert.doesNotMatch(daySection(ui.html()),/data-id="today"/);
  assert.ok(sel(ui.html(),'2026-09-25'));
  ui.click('calday',{'data-date':'2026-09-15'});
  assert.match(row(daySection(ui.html()),'past'),/slot=past[^]*未記入/);
  ui.click('calday',{'data-date':'2026-09-26'});
  assert.match(ui.html(),/この日の授業はありません/);
  ui.click('calday',{'data-date':day});assert.match(daySection(ui.html()),/data-id="today"/);
  assert.equal(ui.requests.length,1,'date browsing is local and read-only');
});

test('month browsing stays within the calendar range',async()=>{
  const ui=await ready();
  for(let n=0;n<12;n++)ui.click('calprev');
  assert.match(ui.html(),/class="callabel">2025年9月/);assert.match(ui.html(),/data-action="calprev" disabled/);
  ui.click('calprev');assert.match(ui.html(),/class="callabel">2025年9月/);
  for(let n=0;n<15;n++)ui.click('calnext');
  assert.match(ui.html(),/class="callabel">2026年12月/);assert.match(ui.html(),/data-action="calnext" disabled/);
  ui.click('calnext');assert.match(ui.html(),/class="callabel">2026年12月/);
  for(let n=0;n<10;n++)ui.click('calprev');
  assert.match(ui.html(),/class="callabel">2026年2月/);assert.match(ui.html(),/data-date="2026-02-28"/);assert.doesNotMatch(ui.html(),/data-date="2026-02-29"/);
  assert.equal(ui.requests.length,1);
});

test('selected date survives record navigation and refreshed record data',async()=>{
  const s=slot('past',{date:'2026-09-22',done:true}),ui=await ready({slots:[s]});
  ui.click('calday',{'data-date':s.date});
  ui.navigate('#lesson?student=test-a&slot=past');ui.navigate('#home');
  ui.requests.at(-1).reply({admin:data({slots:[{...s,lessonRecordStatus:'active'}]})});await flush();
  assert.match(daySection(ui.html()),/9\/22\(火\)の授業[^]*記入済/);
  assert.ok(sel(ui.html(),'2026-09-22'));
});

test('editing an offered lesson from a selected date refreshes that date without deleting it',async()=>{
  const s=slot('selected-offer',{date:'2026-09-25',status:'offered'}),ui=await ready({slots:[s]});
  ui.click('calday',{'data-date':s.date});ui.click('slotedit',{'data-id':s.id});ui.click('se-content');
  ui.input('se-detail-start','18:00');ui.click('se-detail-save');
  ui.requests.at(-1).reply({ok:true,admin:data({slots:[{...s,start:'18:00'}]})});await flush();
  assert.match(daySection(ui.html()),/9\/25\(金\)の授業[^]*18:00/);
  assert.ok(sel(ui.html(),'2026-09-25'));
  assert.equal(ui.requests.some(r=>r.body.op==='deleteSlot'),false);
});
