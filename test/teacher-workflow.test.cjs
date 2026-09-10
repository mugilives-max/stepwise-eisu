'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const h=createHarness({iterations:10}); h.context().ensureSchema_();
 h.spreadsheet.getSheetByName('slots').appendRow(['prep-slot','2026-09-10','13:00',60,'booked','test-a',false,'','','英語','']);
 h.save=(patch={})=>h.admin('lessonPreparationSave',{studentId:'test-a',slotId:'prep-slot',requestId:'prep-write-1',expectedRevision:0,body:'PRIVATE_PREPARATION_SENTINEL',expectedSlot:{date:'2026-09-10',start:'13:00',min:60,subject:'英語'},...patch});
 return h;
}
test('private preparation is journaled, replayable, and excluded from public records and other business state',()=>{
 const h=fixture(), before=clone({slots:h.rows('slots'),effects:h.effects,ledger:[...h.ledger.sheets].map(([n,s])=>[n,s.values])});
 const r=h.save(); assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.context.preparation.body,'PRIVATE_PREPARATION_SENTINEL'); assert.equal(r.context.record,null);
 assert.equal(h.save().ok,true); assert.equal(h.rows('lessonPreparations').length,1); assert.equal(h.rows('lessonWrites').length,1);
 for(const name of ['lessonRecords','lessonPublicSnapshots','lessonPrivateNotes','tasks']) assert.equal(h.rows(name).length,0,name);
 assert.deepEqual(clone({slots:h.rows('slots'),effects:h.effects,ledger:[...h.ledger.sheets].map(([n,s])=>[n,s.values])}),before);
 assert.equal(JSON.stringify(h.context().lessonCommittedPublic_('test-a')).includes('PRIVATE_PREPARATION_SENTINEL'),false);
 assert.equal(h.save({requestId:'prep-stale'}).errorCode,'conflict');
 assert.equal(h.save({requestId:'prep-write-2',expectedRevision:1,body:''}).ok,true);
 assert.equal(h.rows('lessonPreparations')[0].body,'');
});
test('preparation checks authentication, ownership, revision and the displayed booking snapshot',()=>{
 const h=fixture();
 assert.equal(h.save({token:''}).badAuth,true);
 assert.equal(h.save({studentId:'test-b'}).errorCode,'notFound');
 assert.equal(h.save({expectedSlot:{date:'2026-09-11',start:'13:00',min:60,subject:'英語'}}).errorCode,'conflict');
 assert.equal(h.save({body:'x'.repeat(4001)}).errorCode,'validation');
 assert.equal(h.save({expectedSlot:{date:'2026-09-10',start:'13:00',min:60,subject:'英語',done:true}}).errorCode,'validation');
 assert.equal(h.rows('lessonPreparations').length,0);
});
test('a preparation write interrupted after persistence resumes without duplicate rows or revision increments',()=>{
 const h=fixture(), sh=h.spreadsheet.getSheetByName('lessonPreparations'), orig=sh.getRange;
 let fail=true;
 sh.getRange=function(...args){const r=orig.apply(this,args),write=r.setValues;r.setValues=function(v){const out=write.call(this,v);if(fail&&args[0]>1){fail=false;throw Error('SYNTHETIC_INTERRUPTION');}return out;};return r;};
 const first=h.save(); assert.notEqual(first.ok,true); assert.equal(h.rows('lessonPreparations').length,1);
 const replay=h.save(); assert.equal(replay.ok,true,JSON.stringify(replay)); assert.equal(replay.revision,1); assert.equal(h.rows('lessonPreparations').length,1);
});
test('missed completion alerts include old booked lessons only, independently of recording status',()=>{
 const h=fixture(), sh=h.spreadsheet.getSheetByName('slots');
 for(const [id,date,status,done] of [['old','2025-01-01','booked',false],['yesterday','2026-09-06','booked',false],['today','2026-09-07','booked',false],['done','2026-09-06','booked',true],['offer','2026-09-06','offered',false],['cancel','2026-09-06','free',false]]) sh.appendRow([id,date,'14:00',60,status,'test-a',done,'','','英語','']);
 for(const data of [h.context().kanriDashboard_(),h.context().kanriStudent_('test-a','overview')]) assert.deepEqual(clone(data.unrecordedLessons.map(x=>x.id).sort()),['old','yesterday']);
});
test('section reads avoid unrelated tables while the legacy full response remains available',()=>{
 const h=fixture();
 function read(section){const counts={};const c=h.context();const ledger=c.ledgerRows_, rows=c.readRows_;c.ledgerRows_=function(n){counts[n]=(counts[n]||0)+1;return ledger(n);};c.readRows_=function(n){counts[n]=(counts[n]||0)+1;return rows(n);};return {data:clone(c.kanriStudent_('test-a',section)),counts};}
 const overview=read('overview'), settings=read('settings'),progress=read('progress'),full=read();
 for(const n of ['成績推移','面談記録','入金管理']) assert.equal(overview.counts[n],undefined,n);
 assert.equal(settings.counts.slots,undefined); assert.equal(progress.counts.slots,undefined);
 assert.equal(overview.data.section,'overview'); assert.equal(overview.data.parentAuth,undefined); assert.equal(overview.data.billing,undefined);
 assert.ok(settings.data.parentAuth); assert.ok(full.data.billing); assert.equal(full.data.section,'all');
 assert.equal(h.admin('kanriStudent',{studentId:'test-a',section:'invalid'}).error,'表示する項目が正しくありません');
});
test('reassigned slots keep each student preparation separate',()=>{
 const h=fixture();assert.equal(h.save().ok,true);
 // Simulate an independently confirmed reassignment without sending calendar or email.
 const sh=h.spreadsheet.getSheetByName('slots');sh.values[1][5]='test-b';
 const next=h.save({studentId:'test-b',requestId:'other-preparation',body:'OTHER_STUDENT_PREP'});
 assert.equal(next.ok,true,JSON.stringify(next));assert.equal(next.context.preparation.body,'OTHER_STUDENT_PREP');
 assert.equal(h.rows('lessonPreparations').length,2);assert.equal(h.rows('lessonPreparations').find(p=>p.studentId==='test-a').body,'PRIVATE_PREPARATION_SENTINEL');
});
test('record badge index is reused and invalidated by record and draft writes',()=>{
 const h=fixture(),c=h.context();assert.equal(c.lessonMetadata_('test-a','prep-slot').lessonRecordStatus,'none');
 c.lessonPut_('lessonRecords','id','synthetic-record',{id:'synthetic-record',studentId:'test-a',slotId:'prep-slot',status:'active'});
 assert.equal(c.lessonMetadata_('test-a','prep-slot').lessonRecordStatus,'active');const index=c.MEMO_.lessonMeta;
 c.lessonMetadata_('test-a','prep-slot');assert.equal(c.MEMO_.lessonMeta,index);
 c.lessonPut_('lessonReportDrafts','recordId','synthetic-record',{recordId:'synthetic-record',body:'draft'});
 assert.equal(c.lessonMetadata_('test-a','prep-slot').lessonDraftStatus,'draft');
});
test('home calendar includes saved historical booked and offered lessons',()=>{
 const h=fixture(),sh=h.spreadsheet.getSheetByName('slots');
 for(const [id,status] of [['past-done','booked'],['past-offer','offered'],['past-cancel','free']])sh.appendRow([id,'2025-01-01','14:00',60,status,'test-a',true,'','','英語','']);
 const ids=h.context().kanriDashboard_().slots.map(s=>s.id);assert.ok(ids.includes('past-done'));assert.ok(ids.includes('past-offer'));assert.ok(!ids.includes('past-cancel'));
});
