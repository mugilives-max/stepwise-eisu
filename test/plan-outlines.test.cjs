'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBillingHarness,TEACHER_TOKEN,MCP_KEY}=require('./helpers/billing-harness.cjs');
const {createParity}=require('./helpers/parity-harness.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(){
  const h=createBillingHarness();
  const line=ok(h.admin('planLineSave',{studentId:'test-a',subject:'数学',kind:'通常',count:10,startDate:'2026-09-01',endDate:'2026-09-30',lessonMin:60,lessonFee:3000,comment:'【テスト】基礎の復習',propose:true})).line;
  let seq=0;
  h.outline=(extra={})=>h.admin('planOutlineSave',{studentId:'test-a',lineId:line.id,expectedPlanRevision:line.revision,expectedRevision:0,items:[{id:'calc',title:'【テスト】方程式の計算',count:2}],publication:'publish',requestId:'outline-'+(++seq),...extra});
  h.slot=(extra={})=>h.seedSlot({date:'2026-09-03',status:'booked',done:true,...extra});
  h.save=(slot,extra={})=>h.admin('lessonRecordSave',{studentId:'test-a',slotId:slot.id,expectedRevision:0,requestId:'record-'+(++seq),record:{content:'【テスト】解き直し',progress:'',nextFocus:'',teacherNote:'PRIVATE_RECORD',homework:[],outline:{lineId:line.id,itemId:'calc',expectedRevision:1,expectedPlanRevision:line.revision}},...extra});
  h.publicOutline=()=>copy(h.context().planLineView_(h.context().planLine_('test-a',line.id)).outline);
  h.publicRecords=()=>copy(h.context().lessonPublishedForStudent_('test-a'));
  return {h,line};
}
test('optional outline: teacher draft is private, publish is explicit, no billing or schedule mutation',()=>{
  const {h,line}=fixture(), before=copy({slots:h.rows('slots'),plans:h.rows('planLines'),ledger:h.payments(),effects:h.effects});
  assert.equal(h.publicOutline(),null);
  const draft=ok(h.outline({publication:'keep',items:[{id:'calc',title:'PRIVATE_OUTLINE',count:2}]}));
  assert.equal(draft.outline.revision,1);assert.equal(h.publicOutline(),null);
  ok(h.outline({expectedRevision:1})); assert.equal(h.publicOutline().items[0].count,2);assert.equal(h.publicOutline().unallocated,8);
  ok(h.outline({expectedRevision:2,publication:'keep',items:[{id:'calc',title:'PRIVATE_NEW_DRAFT',count:3}]}));
  assert.equal(JSON.stringify(h.publicOutline()).includes('PRIVATE'),false);
  assert.equal(h.publicOutline().items[0].count,2);
  assert.deepEqual(copy({slots:h.rows('slots'),plans:h.rows('planLines'),ledger:h.payments(),effects:h.effects}),before);
  const student=h.request({action:'state',k:'synthetic-link-a'});
  assert.equal(JSON.stringify(student).includes('PRIVATE_NEW_DRAFT'),false);
  assert.equal(h.admin('planOutlineGet',{studentId:'test-b',lineId:line.id}).errorCode,'notFound');
  assert.equal(h.request({action:'admin',op:'planOutlineGet',mcpKey:MCP_KEY,studentId:'test-a',lineId:line.id}).badAuth,true);
});
test('completed chronological positions are 1/2, 2/2, 3/2; not scheduled counts or mastery',()=>{
  const {h}=fixture();ok(h.outline());
  for(let i=1;i<=3;i++){
    const slot=h.slot({date:'2026-09-0'+i});const r=ok(h.save(slot));
    assert.equal(r.context.record.outline.position.ordinal,i);assert.equal(r.context.record.outline.position.plannedCount,2);
    ok(h.save(slot,{requestId:h.rows('lessonWrites').at(-1).requestId})); // same logical write
  }
  const future=h.slot({date:'2026-09-04',done:false});
  assert.equal(ok(h.save(future)).context.record.outline.position.ordinal,null);
  const last=h.slot({date:'2026-09-05'});assert.equal(ok(h.save(last)).context.record.outline.position.ordinal,4);
  assert.equal(h.rows('lessonOutlineLinks').length,5);
});
test('unknown previous mapping remains unknown; cancelled, other subject and other student excluded',()=>{
  const {h}=fixture();ok(h.outline());
  h.slot({date:'2026-09-01',status:'cancelled'});h.slot({date:'2026-09-01',subject:'英語'});h.slot({date:'2026-09-01',studentId:'test-b'});
  const first=h.slot({date:'2026-09-02'});assert.equal(ok(h.save(first)).context.record.outline.position.ordinal,1);
  h.slot({date:'2026-09-03'});
  const last=h.slot({date:'2026-09-04'}),r=ok(h.save(last));
  assert.equal(r.context.record.outline.position.ordinal,null);assert.match(r.context.record.outline.position.reason,/1件/);
});
test('historical published position freezes until explicit correction; private changes cannot leak',()=>{
  const {h,line}=fixture();ok(h.outline());const slot=h.slot(),r=ok(h.save(slot)), prior=h.publicRecords();
  ok(h.outline({expectedRevision:1,items:[{id:'calc',title:'【テスト】改訂した計算',count:3}]}));
  assert.deepEqual(h.publicRecords(),prior);
  const form={content:'本文だけ訂正',progress:'',nextFocus:'',teacherNote:'PRIVATE',homework:[]};
  ok(h.save(slot,{expectedRevision:1,record:form}));assert.equal(h.publicRecords()[0].outline.plannedCount,2);
  ok(h.save(slot,{expectedRevision:2,record:{...form,outline:{lineId:line.id,itemId:'calc',expectedRevision:2,expectedPlanRevision:line.revision,refresh:true}}}));
  assert.equal(h.publicRecords()[0].outline.plannedCount,3);
  ok(h.outline({expectedRevision:2,publication:'hide'}));assert.equal(h.publicOutline(),null);assert.equal(h.publicRecords()[0].outline.plannedCount,3);
  const privateSlot=h.slot({date:'2026-09-04'});
  const privateSave=ok(h.save(privateSlot,{record:{...form,outline:{lineId:line.id,itemId:'calc',expectedRevision:3,expectedPlanRevision:line.revision}}}));
  assert.equal(privateSave.context.record.outline.publicPosition,null);assert.equal(h.publicRecords().find(x=>x.recordId===privateSave.recordId).outline,null);
});
test('reduced approval requires manual reallocation; no automatic scaling and stale revisions conflict',()=>{
  const {h,line}=fixture();ok(h.outline({items:[{id:'calc',title:'計算',count:10}]}));
  h.setRow('planLines','id',line.id,{status:'approved',approvedCount:8,revision:line.revision+1});
  assert.equal(h.publicOutline().adjustmentRequired,true);assert.deepEqual(h.publicOutline().items,[]);
  assert.equal(h.outline({expectedRevision:1}).errorCode,'conflict');
  assert.equal(h.outline({expectedRevision:1,expectedPlanRevision:line.revision+1,items:[{id:'calc',title:'計算',count:10}]}).errorCode,'validation');
  ok(h.outline({expectedRevision:1,expectedPlanRevision:line.revision+1,publication:'keep',items:[{id:'calc',title:'計算',count:10}]}));
  assert.equal(h.rows('planOutlines')[0].itemsJson.includes('10'),true);assert.equal(h.rows('planLines')[0].approvedCount,8);
});
test('pending outline publication is hidden, resumable and idempotent after receipt failure',()=>{
  const {h,line}=fixture(),sh=h.spreadsheet.getSheetByName('lessonWrites'),original=sh.getRange;let fail=true;
  sh.getRange=function(...args){const range=original.apply(this,args),write=range.setValues;range.setValues=function(values){if(fail&&values[0][4]==='applied'){fail=false;throw Error('TEST');}return write.call(this,values);};return range;};
  const result=h.outline({requestId:'pending-outline'});assert.equal(result.errorCode,'pending');assert.equal(h.publicOutline(),null);
  assert.equal(ok(h.admin('planOutlineGet',{studentId:'test-a',lineId:line.id})).outline.pending.requestId,'pending-outline');
  const res=ok(h.admin('lessonWriteResume',{studentId:'test-a',requestId:'pending-outline'}));assert.equal(res.outline.pending,null);assert.equal(h.publicOutline().items.length,1);
  ok(h.outline({requestId:'pending-outline'}));assert.equal(h.rows('planOutlines')[0].revision,1);
});
test('D1 Worker saves and publishes outline-linked record, preserving private projection boundaries',async()=>{
  const {generate}=await import('../scripts/build-gas-bundle.mjs');generate();
  const {h,line}=fixture(),slot=h.slot(),p=await createParity(h);
  const {runWrite}=await import('../cf/worker/write.mjs');
  const request=(op,args)=>runWrite({action:'admin',op,token:TEACHER_TOKEN,studentId:'test-a',...args},{DB:p.d1,NL_ENABLED:'0'},{now:h.now()});
  ok((await request('planOutlineSave',{lineId:line.id,expectedRevision:0,expectedPlanRevision:line.revision,items:[{id:'calc',title:'計算',count:2}],publication:'publish',requestId:'d1-outline'})).result);
  const result=ok((await request('lessonRecordSave',{slotId:slot.id,expectedRevision:0,requestId:'d1-record',record:{content:'【テスト】解き直し',progress:'',nextFocus:'',teacherNote:'PRIVATE',homework:[],outline:{lineId:line.id,itemId:'calc',expectedRevision:1,expectedPlanRevision:line.revision}}})).result);
  assert.equal(result.context.record.outline.position.ordinal,1);
  const row=await p.d1.prepare('select bodyJson from lessonOutlineSnapshots where recordId = ?').bind(result.recordId).first();
  assert.equal(JSON.parse(row.bodyJson).plannedCount,2);assert.equal(row.bodyJson.includes('PRIVATE'),false);
  ok((await request('planOutlineGet',{lineId:line.id})).result);
});
test('strict item bounds, unknown fields and stale input cannot mutate outline or finance',()=>{
  const {h,line}=fixture();
  for(const items of [null,[{id:'x',title:' ',count:1}],[{id:'x',title:'内容',count:0}],[{id:'x',title:'内容',count:1.5}],[{id:'x',title:'内容',count:'2'}],[{id:'x',title:'内容',count:1,privateNote:'unexpected'}],[{id:'x',title:'内容',count:1},{id:'x',title:'重複',count:1}],Array.from({length:31},(_,i)=>({id:'i'+i,title:'内容',count:1}))])assert.equal(h.outline({items}).errorCode,'validation');
  assert.equal(h.rows('planOutlines').length,0);
  assert.equal(h.outline({studentId:'test-b'}).errorCode,'notFound');
  ok(h.outline());assert.equal(h.outline().errorCode,'conflict');
  const foreign=h.slot({subject:'英語'});assert.equal(h.save(foreign).errorCode,'validation');
  const slot=h.slot();assert.equal(h.save(slot,{record:{content:'内容',homework:[],outline:{lineId:line.id,itemId:'missing',expectedRevision:1,expectedPlanRevision:line.revision}}}).errorCode,'validation');
});
test('same-day ordering counts sessions once regardless of duration, and voided history becomes unknown',()=>{
  const {h}=fixture();ok(h.outline());const early=h.slot({start:'10:00',min:30}),late=h.slot({start:'11:00',min:90});
  const r=ok(h.save(early));assert.equal(ok(h.save(late)).context.record.outline.position.ordinal,2);
  ok(h.admin('lessonRecordVoid',{studentId:'test-a',recordId:r.recordId,expectedRevision:1,reason:'【テスト】取消',requestId:'void-for-count'}));
  const next=h.slot({start:'13:00'});assert.equal(ok(h.save(next)).context.record.outline.position.ordinal,null);
  const future=h.slot({date:'2026-09-20',done:true});
  const choices=ok(h.admin('lessonContext',{studentId:'test-a',slotId:future.id})).context.outlineChoices;
  assert.equal(choices[0].items[0].position.ordinal,null);assert.equal(choices[0].items[0].position.reason,'授業日以降に確定');
});
test('outline snapshot failure never changes last committed report and resumes the same captured position',()=>{
  const {h,line}=fixture();ok(h.outline());const slot=h.slot(),r=ok(h.save(slot)),before=h.publicRecords();
  const sh=h.spreadsheet.getSheetByName('lessonOutlineSnapshots'),original=sh.getRange;let fail=true;
  sh.getRange=function(...args){const range=original.apply(this,args),write=range.setValues;range.setValues=function(values){if(fail){fail=false;throw Error('TEST');}return write.call(this,values);};return range;};
  const result=h.save(slot,{expectedRevision:1,requestId:'snapshot-failure',record:{content:'訂正',homework:[],outline:null}});
  assert.equal(result.errorCode,'pending');assert.deepEqual(h.publicRecords(),before);
  ok(h.admin('lessonWriteResume',{studentId:'test-a',requestId:'snapshot-failure'}));
  assert.equal(h.publicRecords()[0].outline,null);assert.equal(h.publicRecords()[0].revision,2);
});
