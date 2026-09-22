'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createUI,adminReady,card,line,flush}=require('./helpers/operations-ui-harness.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const position={title:'方程式の計算',plannedCount:2,ordinal:1,course:'数学（夏期講習）',total:10};
const choice={lineId:'line-1',label:'数学・夏期講習',revision:2,planRevision:7,items:[{id:'calc',title:'方程式の計算',position,publicPosition:position},{id:'private',title:'PRIVATE_OUTLINE',position:{...position,title:'PRIVATE_OUTLINE'},publicPosition:null}]};
function context(extra={}){return {today:'2026-09-08',student:{id:'test-a',name:'【テスト】生徒',active:true},slot:{id:'slot-a',date:'2026-09-08',start:'13:00',min:60,subject:'数学',status:'booked',done:true},record:null,previous:null,otherPrevious:[],homeworkState:[],openTasks:[],draft:null,pending:null,slotChanged:false,outlineChoices:[choice],...extra};}
async function lessonReady(c=context()){const ui=createUI('admin',{hash:'#lesson?student=test-a&slot=slot-a'});ui.requests[0].reply({ok:true,context:c});await flush();return ui;}
function record(form,revision=1){return {id:'record-a',revision,status:'active',...form};}
test('primary fields precede optional details; choosing outline keeps all input and snapshots public preview only',async()=>{
  const ui=await lessonReady();ui.input('lc-content','今回のコメント');ui.input('lc-report-actualUnit','計算');ui.input('lc-title-0','ワーク p21');ui.input('lc-teacherNote','PRIVATE_NOTE');
  ui.input('lc-outline','line-1|calc');assert.equal(ui.el('lc-content').value,'今回のコメント');assert.equal(ui.el('lc-title-0').value,'ワーク p21');assert.match(ui.html(),/今回 1 \/ 2 コマ目/);
  assert.ok(ui.html().indexOf('id="lc-title-0"')<ui.html().indexOf('id="lc-report-understanding"'));
  ui.click('lc-review');const preview=ui.html().match(/<section class="lc-share-preview"[\s\S]*?<\/section>/)[0];
  assert.match(preview,/今回 1 \/ 2/);assert.doesNotMatch(preview,/PRIVATE_NOTE|PRIVATE_OUTLINE/);assert.equal(ui.requests.length,1);
  ui.click('lc-cancelshare');ui.input('lc-outline','line-1|private');ui.click('lc-review');
  assert.doesNotMatch(ui.html().match(/<section class="lc-share-preview"[\s\S]*?<\/section>/)[0],/PRIVATE_OUTLINE/);
});
test('one confirmed share chains report then homework; network retry repeats only the outstanding operation',async()=>{
  const ui=await lessonReady();ui.input('lc-content','報告');ui.input('lc-title-0','ワーク p21');ui.click('lc-review');ui.click('lc-share');
  const save=ui.requests.at(-1);assert.equal(save.body.op,'lessonRecordSave');const r=record(save.body.record);
  save.reply({ok:true,operation:'lessonRecordSave',context:context({record:r})});await flush();
  const apply=ui.requests.at(-1),body=copy(apply.body);assert.equal(body.op,'lessonHomeworkApply');assert.equal(body.recordId,r.id);
  apply.fail();await flush();assert.match(ui.html(),/報告は公開済みですが、宿題の反映は完了していません/);
  ui.click('lc-retry');assert.deepEqual(copy(ui.requests.at(-1).body),body);
  ui.requests.at(-1).reply({ok:true,context:context({record:r}),held:['held-item']});await flush();assert.match(ui.html(),/宿題は変更を保留/);
  assert.equal(ui.requests.filter(x=>x.body.op==='lessonRecordSave').length,1);
});
test('editing after preview requires another confirmation; no hidden automatic save or attendance write',async()=>{
  const ui=await lessonReady();ui.input('lc-content','報告');ui.click('lc-review');ui.input('lc-content','訂正');
  assert.equal(ui.el('lc-share-confirm').disabled,true);ui.click('lc-share');assert.equal(ui.requests.length,1);
  ui.click('lc-review');ui.click('lc-share');assert.equal(ui.requests.at(-1).body.record.content,'訂正');assert.equal(ui.requests.length,2);
});
test('historical position persists until explicit refresh or clearing correspondence',async()=>{
  const r=record({content:'報告',progress:'',nextFocus:'',teacherNote:'',homework:[],outline:{lineId:'line-1',itemId:'calc',position:{...position,plannedCount:5},publicPosition:{...position,plannedCount:5}}});
  const ui=await lessonReady(context({record:r}));assert.match(ui.html(),/今回 1 \/ 5/);ui.click('lc-outline-refresh');assert.match(ui.html(),/今回 1 \/ 2/);
  ui.click('lc-save');assert.equal(ui.requests.at(-1).body.record.outline.refresh,true);
});
const outline=(extra={})=>({lineId:'line-1',planRevision:7,subject:'英語',kind:'',period:'2026年9月',status:'proposed',limit:4,revision:0,items:[],published:null,hasPublication:false,pending:null,...extra});
async function planReady(o=outline()){const ui=await adminReady(card({plan:{lines:[line()],defaultRows:[]}}),'billing');ui.click('po-open',{'data-line':'line-1'});assert.equal(ui.requests.at(-1).body.op,'planOutlineGet');ui.requests.at(-1).reply({ok:true,outline:o});await flush();return ui;}
test('advanced outline draft is separate from plan approval, validates over-allocation, and retries same request',async()=>{
  const ui=await planReady(outline({items:[{id:'calc',title:'計算',count:2}]}));ui.input('po-title-calc','PRIVATE_DRAFT');ui.input('po-count-calc','5');
  ui.click('po-publish',{'data-line':'line-1'});assert.equal(ui.requests.length,2);assert.match(ui.html(),/案内・承認回数以内/);
  ui.click('po-keep',{'data-line':'line-1'});const body=copy(ui.requests.at(-1).body);assert.equal(body.publication,'keep');assert.equal(body.items[0].count,5);assert.equal(body.expectedPlanRevision,7);
  ui.requests.at(-1).fail();await flush();assert.equal(ui.el('po-title-calc').value,'PRIVATE_DRAFT');ui.click('po-retry',{'data-line':'line-1'});assert.deepEqual(copy(ui.requests.at(-1).body),body);
});
test('outline revision conflict compares current draft; resume works after reopening',async()=>{
  const ui=await planReady(outline({items:[{id:'calc',title:'計算',count:2}]}));ui.input('po-title-calc','手元の入力');ui.click('po-keep',{'data-line':'line-1'});
  ui.requests.at(-1).reply({error:'版競合',errorCode:'conflict'});await flush();ui.click('po-refresh',{'data-line':'line-1'});
  ui.requests.at(-1).reply({ok:true,outline:outline({revision:2,items:[{id:'calc',title:'他の端末の入力',count:3}]})});await flush();
  assert.equal(ui.el('po-title-calc').value,'手元の入力');assert.match(ui.html(),/他の端末の入力/);ui.click('po-rebase',{'data-line':'line-1'});ui.click('po-keep',{'data-line':'line-1'});assert.equal(ui.requests.at(-1).body.expectedRevision,2);
  const pending=await planReady(outline({pending:{requestId:'resume-outline'}}));pending.click('po-resume',{'data-line':'line-1'});assert.equal(pending.requests.at(-1).body.op,'lessonWriteResume');assert.equal(pending.requests.at(-1).body.requestId,'resume-outline');
});
test('public renderers escape titles, distinguish unknown / overrun, and do not reveal legacy or private fields',()=>{
  const report=require('../assets/lesson-report.js');assert.match(report.position({...position,ordinal:3}),/3 \/ 2/);assert.match(report.position({...position,ordinal:null,reason:'要確認'}),/未確定/);
  assert.doesNotMatch(report.outline({items:[{title:'<img src=x>',count:2}]}),/<img/);
  const body=report.body({report:{actualUnit:'計算',understanding:'LEGACY',parentMessage:'PARENT_ONLY'},content:'報告',teacherNote:'PRIVATE'},false);
  assert.doesNotMatch(body,/PRIVATE|LEGACY|PARENT_ONLY/);
});
test('late outline response cannot switch the current student screen or target another student',async()=>{
  const ui=await planReady(outline({items:[{id:'calc',title:'計算',count:2}]}));ui.input('po-title-calc','Aの下書き');ui.click('po-keep',{'data-line':'line-1'});const pending=ui.requests.at(-1);
  ui.navigate('#s=test-b&tab=billing');ui.requests.at(-1).reply({data:card({id:'test-b',name:'【テスト】生徒B',plan:{lines:[line({id:'line-b'})],defaultRows:[]}})});await flush();
  pending.reply({ok:true,outline:outline({revision:1,items:[{id:'calc',title:'Aの下書き',count:2}]})});await flush();
  assert.match(ui.html(),/生徒B/);assert.doesNotMatch(ui.html(),/Aの下書き/);
  ui.click('po-open',{'data-line':'line-b'});assert.equal(ui.requests.at(-1).body.studentId,'test-b');assert.equal(ui.requests.at(-1).body.lineId,'line-b');
});
