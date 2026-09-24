'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBillingHarness}=require('./helpers/billing-harness.cjs');
function fixture(){const h=createBillingHarness();const c=h.context();c.ensureFamilySchema_();const a={id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',label:'【テスト】家族',status:'active',email:'parent@example.invalid',verifiedAt:'2026-09-01',passHash:'fixture'};c.familySave_(a);c.familySetChildren_(a,['test-a','test-b']);return {h,a};}
function invoice(h,id,studentId,amount){h.seedPayment({'請求ID':id,'生徒ID':studentId,'請求額':amount});}
test('family reports preserve invoice balances, reject stale signatures and transition only on teacher payment',()=>{
 const {h,a}=fixture();invoice(h,'invoice-a','test-a',3000);invoice(h,'invoice-b','test-b',4000);let c=h.context(),m=c.familyBilling_(a,false)[0];assert.equal(m.amount,7000);assert.equal(m.status,'waiting');const ftoken=c.familyIssueSession_(a).ftoken;
 assert.ok(h.request({action:'familyReportTransfer',ftoken,ym:m.ym,signature:'stale'}).error);assert.ok(h.request({action:'familyReportTransfer',ym:m.ym,signature:m.signature}).error);
 const req={action:'familyReportTransfer',ftoken,ym:m.ym,signature:m.signature};const reported=h.request(req);assert.ok(reported.ok,JSON.stringify(reported));assert.equal(reported.billing[0].status,'reported');assert.equal(h.request(req).billing[0].status,'reported');assert.equal(h.rows('approvalEvents').filter(x=>x.event==='transferReported').length,1);assert.ok(h.payments().every(x=>!x['入金日']));
 assert.ok(h.request({action:'admin',op:'familyConfirmTransfer',familyId:a.id,ym:m.ym,signature:m.signature}).error);
 assert.ok(h.admin('familyConfirmTransfer',{familyId:a.id,ym:m.ym,signature:'old'}).error);
 assert.equal(h.admin('familyConfirmTransfer',{familyId:a.id,ym:m.ym,signature:m.signature}).ok,true);
 assert.equal(h.context().familyBilling_(a,false)[0].status,'paid');
});
test('closing waits for month end, blocks unapproved siblings and is idempotent after approval',()=>{
 const {h,a}=fixture();function plan(id,approved){const l=h.admin('planLineSave',{studentId:id,subject:'数学',kind:'通常',count:1,startDate:'2026-09-01',endDate:'2026-09-30',lessonMin:60,lessonFee:3000,propose:true}).line;assert.ok(l);if(approved)assert.ok(h.admin('planLineApproveTeacher',{studentId:id,lineId:l.id,expectedRevision:l.revision,via:'電話',consentDate:'2026-09-07',memo:'架空の承認'}).ok);return l;}
 plan('test-a',true);const pending=plan('test-b',false);for(const id of ['test-a','test-b'])h.seedSlot({studentId:id,date:'2026-09-05',status:'booked',done:true,min:60,subject:'数学',kind:'通常'});
 assert.equal(h.context().familyCloseMonths_().issued,0);h.advance(Date.parse('2026-10-01T00:10:00+09:00')-h.now());assert.equal(h.context().familyCloseMonths_().issued,0);assert.equal(h.context().familyBilling_(a,false)[0].status,'review');assert.equal(h.payments().length,0);
 assert.ok(h.admin('planLineApproveTeacher',{studentId:'test-b',lineId:pending.id,expectedRevision:pending.revision,via:'電話',consentDate:'2026-09-30',memo:'架空の承認'}).ok);
 assert.equal(h.context().familyCloseMonths_().issued,2);assert.equal(h.context().familyCloseMonths_().issued,0);assert.equal(h.payments().length,2);assert.equal(h.context().familyBilling_(a,false)[0].amount,6000);
});
