'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSchedulingHarness,failWriteOnce}=require('./helpers/scheduling-harness.cjs');
function setup(){const h=createSchedulingHarness(),s=h.seedSlot({status:'booked',done:'true',subject:'英数',kind:'講習'});const req=h.teacherRequest('editLessonSubject',{studentId:s.studentId,slotId:s.id,requestId:'subject-correction-1',expectedSnapshot:h.snapshot(s.id),expectedDone:'true',deliveryMode:s.deliveryMode,subject:'英語'});return {h,s,req};}
test('completed subject correction preserves execution and unrelated fields, and replay never overwrites a later edit',()=>{
 const {h,s,req}=setup(),before=h.rows('slots')[0];assert.equal(h.request(req).ok,true);
 assert.deepEqual(h.rows('slots')[0],{...before,subject:'英語'});
 const second={...req,requestId:'subject-correction-2',expectedSnapshot:h.snapshot(s.id),subject:'数学'};assert.equal(h.request(second).ok,true);
 assert.equal(h.request(req).replayed,true);assert.equal(h.snapshot(s.id).subject,'数学');
});
test('subject correction rejects unauthorized, stale, invalid and non-completed requests without writes',()=>{
 for(const patch of [{token:'bad'},{studentId:'test-b'},{expectedDone:''},{expectedSnapshot:{}},{subject:''},{subject:'=1'}]){const {h,req}=setup();assert.ok(h.request({...req,...patch}).error);assert.equal(h.rows('offerEdits').length,0);}
 const {h,s,req}=setup();h.setRow('slots','id',s.id,{done:''});assert.ok(h.request({...req,expectedDone:''}).error);
});
test('subject correction respects invoices and existing lesson records',()=>{
 for(const record of [false,true]){const {h,s,req}=setup();if(record){h.context().ensureLessonSchema_();h.append('lessonRecords',{id:'record-a',slotId:s.id,studentId:s.studentId,subject:'英数'});}else{h.context().ledgerSheet_('入金管理');const sh=h.ledger.getSheetByName('入金管理'),r={'年月':'2026-09','生徒ID':s.studentId,'状態':'未入金','請求額':3000};sh.appendRow(sh.values[0].map(k=>r[k]??''));}assert.equal(h.request(req).errorCode,record?'recordExists':'invoiceLocked');assert.equal(h.snapshot(s.id).subject,'英数');}
});
test('unfinished subject correction exposes the original done snapshot and resumes once',()=>{
 const {h,s,req}=setup();failWriteOnce(h.spreadsheet.getSheetByName('offerEdits'),v=>v[0][6]==='done');assert.equal(h.request(req).pending,true);
 const p=h.context().schedulingPendingEdits_(s.studentId)[0];assert.equal(p.before.done,'true');assert.equal(p.op,'editLessonSubject');
 assert.equal(h.request({...req,expectedSnapshot:p.before,expectedDone:p.before.done,subject:p.after.subject}).ok,true);assert.equal(h.rows('offerEdits').length,1);
});
