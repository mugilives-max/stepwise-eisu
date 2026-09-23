'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createUI, flush} = require('./helpers/operations-ui-harness.cjs');
const day = '2026-09-23';
const slot = (id, patch={}) => ({id, studentId:'test-a', studentName:'【テスト】生徒A', date:day, start:'17:00', min:60, status:'booked', done:false, subject:'数学', kind:'夏期講習', deliveryMode:'in_person', lessonRecordStatus:'none', lessonDraftStatus:'none', ...patch});
const dash = (patch={}) => ({today:day, slots:[], lessonsToday:[], lessonsWeek:[], pending:[], unpaid:[], students:[], meetings:[], ...patch});
async function ready(patch={}, window={}) {
  const ui=createUI('admin',{hash:'#home', search:'?homePreview=1', now:day+'T12:00:00+09:00', window});
  ui.requests[0].reply({data:dash(patch)});await flush();return ui;
}
const todaySection = html => html.match(/<section class="card home-day"[^]*?<\/section>/)[0];
const row = (html,id) => html.match(new RegExp('<article class="home-lesson" data-home-slot="'+id+'"[^]*?<\/article>'))[0];

test('new home puts today first, separates booked/offered counts, sorts and deduplicates slots',async()=>{
  const a=slot('a',{start:'19:00'}), b=slot('b',{start:'16:00',status:'offered'});
  const ui=await ready({slots:[a,b,slot('future',{date:'2026-09-24'})],lessonsToday:[a],pending:[b]});
  const h=ui.html(), section=todaySection(h);
  assert.doesNotMatch(h,/class="card cal"|data-action="calday"|予定の編集/);
  assert.match(h,/href="#lessons">授業の予定表へ/);
  assert.ok(h.indexOf('今日の授業')<h.indexOf('確認・対応すること'));
  assert.match(section,/確定 1件 · 承認待ち 1件/);
  assert.equal((section.match(/data-home-slot="a"/g)||[]).length,1);
  assert.ok(section.indexOf('data-home-slot="b"')<section.indexOf('data-home-slot="a"'));
  assert.doesNotMatch(section,/data-home-slot="future"/);
  assert.equal(ui.requests.length,1,'rendering must not mutate or fetch every student');
});

test('empty today still exposes schedule and record queue without claiming all work finished',async()=>{
  const ui=await ready({slots:[slot('past',{date:'2026-09-22',done:true})]});
  assert.match(ui.html(),/今日の授業はありません/);assert.match(ui.html(),/data-home-slot="past"/);
  assert.doesNotMatch(ui.html(),/すべて完了|宿題共有済み|保護者確認済み/);
});

test('execution and record status remain independent with correct record links',async()=>{
  const ui=await ready({slots:[slot('done',{done:true}),slot('saved',{lessonRecordStatus:'active'}),slot('draft',{done:true,lessonRecordStatus:'active',lessonDraftStatus:'draft'}),slot('void',{lessonRecordStatus:'void'})]});
  assert.match(row(ui.html(),'done'),/実施済み[^]*記録未入力[^]*#lesson\?student=test-a&amp;slot=done[^]*記録を入力/);
  assert.match(row(ui.html(),'saved'),/>確定<[^]*記録済み[^]*記録を見る/);
  assert.match(row(ui.html(),'draft'),/下書き・未公開[^]*記録を再開/);
  assert.match(row(ui.html(),'void'),/記録無効化済み[^]*記録を確認/);
  ui.click('toggledone',{'data-id':'saved'});
  assert.deepEqual([ui.requests.at(-1).body.op,ui.requests.at(-1).body.slotId,ui.requests.at(-1).body.studentId,ui.requests.at(-1).body.done],['toggleDone','saved','test-a',true]);
});

test('recent record queue has an explicit seven-day scope and retains older work separately',async()=>{
  const ui=await ready({slots:[slot('start',{date:'2026-09-16',done:true}),slot('old',{date:'2026-09-15',done:true}),slot('draft',{date:'2026-09-22',done:true,lessonRecordStatus:'active',lessonDraftStatus:'draft'}),slot('not-done',{date:'2026-09-22'}),slot('saved',{date:'2026-09-22',done:true,lessonRecordStatus:'active'}),slot('void',{date:'2026-09-22',done:true,lessonRecordStatus:'void'})]});
  assert.match(ui.html(),/前日までの記録待ち <span class="cnt">2件・直近7日/);
  assert.match(ui.html(),/それ以前の記録待ち <span class="cnt">1件/);
  assert.match(ui.html(),/宿題の反映・保護者の既読は記録画面で確認/);
  assert.doesNotMatch(ui.html(),/data-home-slot="not-done"|data-home-slot="saved"|data-home-slot="void"/);
});

test('unconfirmed offer edits keep ID, kind, snapshot and input; no delete is sent',async()=>{
  const s=slot('offered',{date:'2026-09-25',status:'offered'}),ui=await ready({slots:[s],pending:[s],lessonKinds:[{name:'通常',active:true},{name:'夏期講習',active:true},{name:'英検対策',active:true}]});
  ui.click('slotedit',{'data-id':s.id});
  assert.equal(ui.focused(),'se-date');assert.equal(ui.el('se-kind').value,'夏期講習');
  assert.match(ui.html(),/<option value="英検対策">英検対策/);
  ui.input('se-start','18:00');ui.click('se-save');
  const r=ui.requests.at(-1), sent=structuredClone(r.body);
  assert.deepEqual([sent.op,sent.slotId,sent.start,sent.kind,sent.expectedSnapshot.start],['editOffered','offered','18:00','夏期講習','17:00']);
  r.fail();await flush();ui.click('se-retry');assert.deepEqual(ui.requests.at(-1).body,sent);
  ui.requests.at(-1).reply({ok:true,dash:dash({slots:[{...s,start:'18:00'}],pending:[{...s,start:'18:00'}]})});await flush();
  assert.match(row(ui.html(),'offered'),/18:00/);assert.equal(ui.el('se-start'),undefined);
  assert.equal(ui.requests.some(r=>r.body.op==='deleteSlot'),false);
});

test('cancel requests keep reasons, timestamps and explicit decision actions',async()=>{
  const ui=await ready({cancelReqs:[slot('cancel',{req:{requestType:'exception',reason:'【テスト】体調不良',at:'2026-09-22T03:00:00Z'}})]});
  assert.match(ui.html(),/data-home-fold="cancel" open/);assert.match(ui.html(),/期限後の例外申請[^]*【テスト】体調不良[^]*受付/);
  ui.click('cancelkeep',{'data-id':'cancel'});
  assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.slotId,'cancel');
});

test('execution checks, expired offers, bills, wishes and contact inbox remain reachable',async()=>{
  let mounted;
  const expired=slot('expired',{date:'2026-09-22',status:'offered'});
  const ui=await ready({unrecordedLessons:[slot('unrecorded',{date:'2026-09-22'})],expired:[expired],pending:[expired],unpaid:[{studentId:'test-a',name:'【テスト】A',ym:'2026-09',amount:3000}],wishes:[{date:'2026-09-25',studentName:'【テスト】A',start:'17:00',end:'19:00',note:'希望'}],contactPendingCount:3}, {StepwiseServices:{mount:(host,cfg)=>{mounted={host,cfg};},clear(){}}});
  assert.match(ui.html(),/data-action="toggledone"[^>]*data-id="unrecorded"/);
  assert.match(ui.html(),/data-action="finishoffered"[^>]*data-id="expired"/);
  assert.match(ui.html(),/data-action="delslot"[^>]*data-id="expired"/);
  assert.match(ui.html(),/承認待ちの案内 <span class="cnt">0件/);
  assert.match(ui.html(),/href="#s=test-a&amp;tab=billing">請求・入金を確認/);
  assert.match(ui.html(),/希望[^]*授業ページで日程調整/);
  assert.equal(mounted.host.id,'home-services');assert.equal(mounted.cfg.pendingCount,3);assert.equal(mounted.cfg.inbox,true);
});

test('record navigation and return keep the new home preview active',async()=>{
  const s=slot('record');const ui=await ready({slots:[s]});
  ui.navigate('#lesson?student=test-a&slot=record');
  assert.equal(ui.requests.at(-1).body.op,'lessonContext');
  ui.navigate('#home');ui.requests.at(-1).reply({data:dash({slots:[{...s,done:true,lessonRecordStatus:'active'}]})});await flush();
  assert.match(todaySection(ui.html()),/実施済み[^]*記録済み[^]*記録を見る/);assert.doesNotMatch(ui.html(),/class="card cal"/);
});

test('names and pending reasons are escaped in the preview',async()=>{
  const s=slot('unsafe',{studentName:'<script>bad</script>'});
  const ui=await ready({slots:[s],cancelReqs:[{...s,req:{reason:'<img src=x onerror=bad>'}}]});
  assert.doesNotMatch(ui.html(),/<script>bad|<img src=x/);assert.match(ui.html(),/&lt;script&gt;bad/);
});

test('an ended offer is not treated as confirmed or as an ordinary editable future offer',async()=>{
  const s=slot('ended',{status:'offered',start:'09:00'}),ui=await ready({slots:[s],pending:[s],expired:[s]});
  assert.match(row(ui.html(),'ended'),/時間終了・実施未確認[^]*data-action="finishandrecord"/);
  assert.doesNotMatch(row(ui.html(),'ended'),/data-action="slotedit"|記録未入力/);
  assert.match(todaySection(ui.html()),/確定 0件/);
  assert.doesNotMatch(todaySection(ui.html()),/承認待ち/);
});
