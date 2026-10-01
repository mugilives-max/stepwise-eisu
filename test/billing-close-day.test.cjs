'use strict';
// 月の請求の自動確定は翌月3日（1日・2日は先生が内容を確かめる期間。2026-10-01 から）
const test=require('node:test'),assert=require('node:assert/strict');
const {createBillingHarness}=require('./helpers/billing-harness.cjs');
function fixture(){
 const h=createBillingHarness(),c=h.context();c.ensureFamilySchema_();
 const a={id:'cccccccccccccccccccccccccccccccc',label:'【テスト】家族',status:'active',email:'parent@example.invalid',verifiedAt:'2026-09-01',passHash:'fixture'};c.familySave_(a);c.familySetChildren_(a,['test-a']);
 const l=h.admin('planLineSave',{studentId:'test-a',subject:'数学',kind:'通常',count:1,startDate:'2026-09-01',endDate:'2026-09-30',lessonMin:60,lessonFee:3000,propose:true}).line;
 assert.ok(h.admin('planLineApproveTeacher',{studentId:'test-a',lineId:l.id,expectedRevision:l.revision,via:'電話',consentDate:'2026-09-07',memo:'架空の承認'}).ok);
 h.seedSlot({studentId:'test-a',date:'2026-09-05',status:'booked',done:true,min:60,subject:'数学',kind:'通常'});
 return h;
}
const at=(h,iso)=>h.advance(Date.parse(iso)-h.now());

test('the previous month is not closed on the 1st or 2nd, and is closed once from the 3rd',()=>{
 const h=fixture();
 at(h,'2026-10-01T00:10:00+09:00');assert.equal(h.context().familyCloseMonths_().issued,0,'1日はまだ確定しない');
 at(h,'2026-10-02T23:59:00+09:00');assert.equal(h.context().familyCloseMonths_().issued,0,'2日もまだ確定しない');
 assert.equal(h.payments().length,0);
 at(h,'2026-10-03T00:10:00+09:00');assert.equal(h.context().familyCloseMonths_().issued,1);assert.equal(h.context().familyCloseMonths_().issued,0,'二度は確定しない');
 assert.equal(h.payments().length,1);
});

test('an older month still held is retried every day, without waiting for the 3rd',()=>{
 const h=fixture();
 at(h,'2026-11-01T00:10:00+09:00');assert.equal(h.context().familyCloseMonths_().issued,1,'9月分は10月3日を過ぎているので確定する');
});

test('the teacher can still record an invoice by hand during the checking days',()=>{
 const h=fixture();at(h,'2026-10-01T09:00:00+09:00');
 assert.equal(h.admin('kanriAddPayment',{studentId:'test-a',ym:'2026-09',requestId:'close-day-manual-01',silent:true}).ok,true);
 at(h,'2026-10-03T00:10:00+09:00');assert.equal(h.context().familyCloseMonths_().issued,0,'手で記録した月は自動で二重に記録しない');
});

test('the billing overview says when the month will close',()=>{
 const h=fixture(),c=()=>h.context();
 assert.equal(c().billingCloseOn_('2026-09'),'2026-10-03');assert.equal(c().billingCloseOn_('2026-12'),'2027-01-03');assert.equal(c().billingCloseOn_('2027-01'),'2027-02-03');
 at(h,'2026-10-02T12:00:00+09:00');let o=c().billingOverview_('2026-09').overview;
 assert.equal(o.closed,true);assert.equal(o.closeWaiting,true);assert.equal(o.closeOn,'2026-10-03');assert.equal(o.closeDay,3);
 assert.equal(c().billingOverview_('2026-10').overview.closeWaiting,false,'途中の月は確定待ちではない');
 at(h,'2026-10-03T00:10:00+09:00');o=c().billingOverview_('2026-09').overview;assert.equal(o.closeWaiting,false);
});
