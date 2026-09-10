const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(){const h=createFamilyHarness();h.admin('state');const f=ok(h.admin('familyCreate',{label:'【テスト】通知',studentIds:['test-a']}));ok(h.family('familyRegister',{inviteCode:f.inviteCode,email:'notices@example.invalid',pass:'Synthetic password!'}));ok(h.family('familyVerify',{challenge:h.latestChallenge()}));ok(h.family('familyCompleteRegistration',{challenge:h.latestChallenge(),pass:'Synthetic password!'}));h.token=ok(h.family('familyLogin',{email:'notices@example.invalid',pass:'Synthetic password!'})).ftoken;h.call=(action='familyNotices',args={})=>h.family(action,{ftoken:h.token,...args});return h;}
function row(h,sheet,data,cols){const c=h.context();if(cols)c.ensureSheet_(c.ss_(),sheet,cols);const sh=h.spreadsheet.getSheetByName(sheet);sh.appendRow(sh.values[0].map(k=>data[k]??''));}
test('notices scope children, exclude auth secrets, persist reads and reject foreign IDs',()=>{
 const h=fixture();const cols=h.context().STUDENT_EMAIL_OUTBOX_COLS_;
 for(const [id,studentId,kind] of [['own','test-a','changed'],['foreign','test-b','cancelled'],['secret','test-a','verify']])row(h,'studentEmailOutbox',{id,studentId,kind,snapshotJson:'[{"date":"2026-09-12","start":"17:00","secret":"PRIVATE"}]',email:'PRIVATE',createdAt:'2026-09-10'},cols);
 const items=ok(h.call()).notices;assert.ok(items.some(x=>x.id==='schedule:own'));assert.ok(!JSON.stringify(items).includes('PRIVATE'));assert.ok(!items.some(x=>x.id.includes('foreign')||x.id.includes('secret')));
 assert.ok(h.call('familyNoticeRead',{noticeId:'schedule:foreign'}).error);
 assert.equal(ok(h.call('familyNoticeRead',{noticeId:'schedule:own'})).notices.find(x=>x.id==='schedule:own').read,true);ok(h.call('familyNoticeRead',{noticeId:'schedule:own'}));assert.equal(h.rows('familyNoticeReads').length,1);assert.equal(ok(h.call()).notices.find(x=>x.id==='schedule:own').read,true);
 assert.ok(h.family('familyNotices',{ftoken:'invalid'}).error);
});
test('reading a notice never approves a plan, pays an invoice or marks a lesson report read',()=>{
 const h=fixture(),ctx=h.context();const account=ctx.familyRequire_({ftoken:h.token}).account;
 ctx.parentDataForStudent_=()=>({ok:true,data:{planMonths:[{ym:'2026-09',status:'proposed',revision:2}],payments:[{ym:'2026-09',amount:1000,status:'未入金',billDate:'2026-09-10'}],lessonRecords:[{recordId:'report-a',revision:1,date:'2026-09-10'}]}});
 const items=ctx.familyNotices_(account,{action:'familyNotices'}).notices;assert.equal(items.filter(x=>x.required).length,2);
 const result=ctx.familyNotices_(account,{action:'familyNoticeRead',noticeId:items[0].id});assert.equal(result.notices[0].required,true);assert.equal(result.notices[0].read,true);assert.equal(h.rows('approvalEvents').length,0);assert.equal(h.rows('lessonReadReceipts').length,0);
});
