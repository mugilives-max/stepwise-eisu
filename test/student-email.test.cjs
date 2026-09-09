'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStudentEmailHarness}=require('./helpers/student-email-harness.cjs');
const EMAIL='student@example.invalid';
function ok(r){assert.equal(r.ok,true,JSON.stringify(r));return r;}
function rejected(r){assert.ok(r.error,JSON.stringify(r));return r;}
function register(h,email=EMAIL,k='synthetic-link-a'){return ok(h.student('studentEmailRequest',{email,k}));}
function verify(h,email=EMAIL,k='synthetic-link-a'){register(h,email,k);return ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));}
function slot(patch={}){return {id:'synthetic-email-slot',studentId:'test-a',date:'2026-09-15',start:'15:00',min:30,subject:'数学',deliveryMode:'in_person',status:'offered',...patch};}
function notify(h,key='synthetic-offer',kind='offered',slots=[slot()]){const c=h.context();return c.studentEmailNotify_(c.findStudent_('test-a'),key,kind,slots);}
function out(h,key){return h.rows('studentEmailOutbox').find(r=>r.eventKey===key);}
function contact(h,id='test-a'){return h.rows('studentEmails').find(r=>r.studentId===id);}
function failWriteOnce(sheet,predicate,after=false){
  const original=sheet.getRange;sheet.getRange=function(...args){const r=original.apply(this,args),write=r.setValues;r.setValues=function(values){if(!predicate(values))return write.call(this,values);sheet.getRange=original;if(after)write.call(this,values);throw new Error('Synthetic interrupted email write');};return r;};
}

test('legacy student email stays unchanged and unverified through schema preparation',()=>{
  const h=createStudentEmailHarness();h.setRow('students','id','test-a',{email:'Legacy@Example.Invalid'});ok(h.admin('state'));
  assert.equal(h.studentRow().email,'Legacy@Example.Invalid');assert.equal(h.rows('studentEmails').length,0);
  const c=h.context(),status=c.studentEmailStatus_('test-a');assert.equal(status.email,'legacy@example.invalid');assert.equal(status.verified,false);assert.equal(c.studentEmailVerifiedAddress_('test-a'),'');
  assert.equal(notify(h).status,'skipped');assert.equal(h.mailbox.length,0);
});
test('student link grants only the linked student email operations',()=>{
  const h=createStudentEmailHarness();rejected(h.student('studentEmailRequest',{k:'missing',email:EMAIL}));rejected(h.student('studentEmailRemove',{k:'synthetic-link-inactive'}));
  register(h);const before=contact(h);
  ok(h.student('studentEmailRemove',{k:'synthetic-link-b',studentId:'test-a'}));assert.deepEqual(contact(h),before);
  rejected(h.request({action:'studentEmailRequest',email:EMAIL}));
});
test('verification is required, one-use, has separate token namespace and leaks neither student link nor credentials',()=>{
  const h=createStudentEmailHarness();const result=register(h,' Student@Example.Invalid '),challenge=h.latestChallenge();
  assert.equal(result.emailStatus.verified,false);assert.equal(result.emailStatus.pendingEmail,EMAIL);assert.equal(h.studentRow().email,'');
  assert.match(challenge,/^se1\.[a-f0-9]{32}\.[a-f0-9]{64}$/);assert.equal(h.mailbox[0].body.includes('synthetic-link-'),false);
  const rows=JSON.stringify(['studentEmails','studentEmailOutbox','log'].map(name=>h.rows(name)));assert.equal(rows.includes(challenge),false);assert.equal(rows.includes('synthetic-link-a'),false);
  const verified=ok(h.request({action:'studentEmailVerify',challenge}));assert.equal(verified.verified,true);assert.equal(verified.studentId,undefined);assert.equal(verified.emailStatus,undefined);assert.equal(JSON.stringify(verified).includes('synthetic-link'),false);
  assert.equal(h.studentRow().email,EMAIL);assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),EMAIL);rejected(h.request({action:'studentEmailVerify',challenge}));
  rejected(h.request({action:'studentEmailVerify',challenge:challenge.replace('se1.','fc1.')}));
});
test('expired challenge and five wrong proofs cannot activate email',()=>{
  const h=createStudentEmailHarness();register(h);const challenge=h.latestChallenge();h.advance(30*60000+1);rejected(h.request({action:'studentEmailVerify',challenge}));
  ok(h.student('studentEmailResend'));const next=h.latestChallenge(),bad=next.slice(0,-1)+(next.endsWith('a')?'b':'a');
  for(let i=0;i<5;i++)rejected(h.request({action:'studentEmailVerify',challenge:bad}));
  rejected(h.request({action:'studentEmailVerify',challenge:next}));assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');
});
test('resend rotates proof and enforces per-student cooldown without sending again',()=>{
  const h=createStudentEmailHarness();register(h);const first=h.latestChallenge();
  assert.equal(rejected(h.student('studentEmailResend')).errorCode,'rateLimited');assert.equal(h.mailbox.length,1);
  h.advance(61000);ok(h.student('studentEmailResend'));assert.equal(h.mailbox.length,2);rejected(h.request({action:'studentEmailVerify',challenge:first}));
  ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));
});
test('per-student limit applies across different recipients and has a daily bound',()=>{
  const h=createStudentEmailHarness();for(let i=0;i<5;i++){register(h,'address'+i+'@example.invalid');h.advance(61000);}
  assert.equal(rejected(h.student('studentEmailRequest',{email:'extra@example.invalid'})).errorCode,'rateLimited');assert.equal(h.mailbox.length,5);
  h.advance(3600000);for(let i=5;i<10;i++){register(h,'address'+i+'@example.invalid');h.advance(61000);}
  h.advance(3600000);assert.equal(rejected(h.student('studentEmailRequest',{email:'extra@example.invalid'})).errorCode,'rateLimited');assert.equal(h.mailbox.length,10);
});
test('recipient limit spans different student links',()=>{
  const h=createStudentEmailHarness();for(let i=0;i<5;i++){register(h,EMAIL,i%2?'synthetic-link-b':'synthetic-link-a');h.advance(61000);}
  assert.equal(rejected(h.student('studentEmailRequest',{email:EMAIL,k:'synthetic-link-b'})).errorCode,'rateLimited');assert.equal(h.mailbox.length,5);
});
test('new contact keeps verified old email until proof, then cancels stale queued mail',()=>{
  const h=createStudentEmailHarness();verify(h);h.advance(61000);h.setQuota(0);assert.equal(notify(h,'old-recipient').status,'failed');h.setQuota(100);
  register(h,'new@example.invalid');const challenge=h.latestChallenge();assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),EMAIL);assert.equal(h.studentRow().email,EMAIL);
  ok(h.request({action:'studentEmailVerify',challenge}));assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'new@example.invalid');
  const before=h.mailbox.length;const result=ok(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out(h,'old-recipient').id}));
  assert.equal(h.mailbox.length,before);assert.equal(result.notifications.find(o=>o.id===out(h,'old-recipient').id).status,'cancelled');
});
test('removing email clears active and pending proof and cannot resurrect old address',()=>{
  const h=createStudentEmailHarness();verify(h);h.advance(61000);register(h,'new@example.invalid');const challenge=h.latestChallenge();
  const removed=ok(h.student('studentEmailRemove'));assert.equal(removed.emailStatus.email,'');assert.equal(removed.emailStatus.verified,false);assert.equal(removed.emailStatus.pendingEmail,'');
  rejected(h.request({action:'studentEmailVerify',challenge}));assert.equal(notify(h,'after-remove').status,'skipped');assert.equal(h.studentRow().email,'');
});
test('link rotation, student stopping and teacher email replacement cannot reuse pending proofs',()=>{
  const h=createStudentEmailHarness();register(h);const first=h.latestChallenge();
  ok(h.admin('newCode',{studentId:'test-a'}));rejected(h.request({action:'studentEmailVerify',challenge:first}));
  h.advance(61000);register(h,EMAIL,h.studentRow().code);const second=h.latestChallenge();ok(h.admin('hideStudent',{studentId:'test-a'}));rejected(h.request({action:'studentEmailVerify',challenge:second}));
  h.setRow('students','id','test-a',{active:true});rejected(h.request({action:'studentEmailVerify',challenge:second}));
  h.advance(61000);verify(h,EMAIL,h.studentRow().code);ok(h.admin('setEmail',{studentId:'test-a',email:'teacher-edited@example.invalid'}));
  assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');assert.equal(h.studentRow().email,'teacher-edited@example.invalid');
});
test('direct legacy column changes fail closed even if caller forgot explicit invalidation',()=>{
  const h=createStudentEmailHarness();verify(h);h.setRow('students','id','test-a',{email:'tampered@example.invalid'});
  assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');assert.equal(notify(h,'mismatched').status,'skipped');
});
test('student email does not change legacy parents or family account and links',()=>{
  const h=createStudentEmailHarness();ok(h.admin('state'));ok(h.admin('familyCreate',{label:'【テスト】既存家族',studentIds:['test-a','test-b']}));
  const names=['parents','familyAccounts','familyLinks','familyChallenges','familyOutbox'],before=JSON.stringify(names.map(n=>h.rows(n)));
  verify(h);ok(h.student('studentEmailRemove'));assert.equal(JSON.stringify(names.map(n=>h.rows(n))),before);
});
test('offer, change and cancellation notify only verified student; body/projection exclude internal notes and dedicated links',()=>{
  const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;
  const one=slot({req:'PRIVATE_NOTE',teacherNote:'PRIVATE_NOTE',code:'synthetic-link-a',meetUrl:'PRIVATE_MEET_URL'}),two=slot({start:'16:00'});
  ok(notify(h,'offered','offered',[one]));ok(notify(h,'changed','changed',[one,two]));ok(notify(h,'cancelled','cancelled',[two]));ok(notify(h,'declined','cancelDeclined',[two]));
  assert.equal(h.mailbox.length,4);assert.ok(h.mailbox.every(m=>m.to===EMAIL));
  const body=h.mailbox.map(m=>m.body).join('\n');assert.equal(/PRIVATE_|synthetic-link|\?k=/.test(body),false);assert.match(body,/変更前：2026-09-15 15:00/);assert.match(body,/変更後：2026-09-15 16:00/);
  assert.equal(/PRIVATE_|synthetic-link|\?k=/.test(JSON.stringify(h.rows('studentEmailOutbox'))),false);
  const notices=ok(h.admin('studentEmailNotifications',{studentId:'test-a'}));assert.equal(/challengeHash|challengeLinkHash|snapshotJson|contactRevision/.test(JSON.stringify(notices)),false);
});
test('event keys are idempotent and cannot be reused with changed lesson content',()=>{
  const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;ok(notify(h));ok(notify(h));assert.equal(h.mailbox.length,1);
  const conflict=notify(h,'synthetic-offer','offered',[slot({start:'17:00'})]);assert.equal(conflict.ok,false);assert.equal(h.mailbox.length,1);
  assert.equal(h.rows('studentEmailOutbox').filter(o=>o.kind==='offered').length,1);
});
test('a skipped old event never becomes retrospective mail after later verification',()=>{
  const h=createStudentEmailHarness();ok(h.admin('state'));assert.equal(notify(h).status,'skipped');verify(h);const before=h.mailbox.length;
  assert.equal(notify(h).status,'skipped');assert.equal(h.mailbox.length,before);
});
test('quota failure is retryable and sent or uncertain email never retries',()=>{
  const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;h.setQuota(0);assert.equal(notify(h,'quota').status,'failed');assert.equal(h.mailbox.length,0);
  h.setQuota(100);ok(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out(h,'quota').id}));assert.equal(h.mailbox.length,1);
  rejected(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out(h,'quota').id}));
  h.setMailFailure(true,true);assert.equal(notify(h,'uncertain').status,'uncertain');assert.equal(h.mailbox.length,2);h.setMailFailure(false);
  assert.equal(notify(h,'uncertain').status,'uncertain');rejected(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out(h,'uncertain').id}));assert.equal(h.mailbox.length,2);
});
test('auth emails cannot be resent from teacher outbox and notifications reject student or other-child authority',()=>{
  const h=createStudentEmailHarness();register(h);const authMail=h.rows('studentEmailOutbox')[0];
  rejected(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:authMail.id}));
  rejected(h.request({action:'admin',op:'studentEmailNotifications',k:'synthetic-link-a',studentId:'test-a'}));
  ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));h.setQuota(0);notify(h,'queued');
  rejected(h.admin('studentEmailRetryNotification',{studentId:'test-b',notificationId:out(h,'queued').id}));
});
test('test guard suppresses verification and all student business emails',()=>{
  const h=createStudentEmailHarness();h.enableTestGuard();const r=register(h);assert.equal(r.mailStatus,'suppressed');assert.equal(h.mailbox.length,0);
  let c=h.context(),record=c.studentEmailRecord_('test-a');record.email=EMAIL;record.verifiedAt=new Date(h.now()).toISOString();c.studentEmailSave_(record);c.studentEmailSetMirror_('test-a',EMAIL);
  assert.equal(notify(h).status,'suppressed');assert.equal(h.mailbox.length,0);
});
test('auth delivery exceptions are secret-safe and do not make the email verified',()=>{
  const h=createStudentEmailHarness();h.setMailFailure(true);const result=register(h);assert.equal(result.mailStatus,'uncertain');assert.equal(result.emailStatus.verified,false);
  assert.equal(/Synthetic mail|se1\./.test(JSON.stringify(h.rows('studentEmailOutbox'))),false);assert.equal(h.studentRow().email,'');
});
test('sent receipt failure remains uncertain and suppresses duplicates',()=>{
  const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;const sh=h.spreadsheet.getSheetByName('studentEmailOutbox'),status=sh.values[0].indexOf('status');
  failWriteOnce(sh,rows=>rows[0][status]==='sent');assert.equal(notify(h).status,'uncertain');assert.equal(out(h,'synthetic-offer').status,'uncertain');
  ok(notify(h));assert.equal(h.mailbox.length,1);
});
test('interrupted verification mirror write consumes proof and recovers only through a fresh request',()=>{
  const h=createStudentEmailHarness();register(h);const challenge=h.latestChallenge();const sh=h.spreadsheet.getSheetByName('students');
  failWriteOnce(sh,values=>values[0][0]===EMAIL);rejected(h.request({action:'studentEmailVerify',challenge}));
  assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');rejected(h.request({action:'studentEmailVerify',challenge}));
  h.advance(61000);ok(h.student('studentEmailResend'));ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),EMAIL);
});
test('interrupted final verification never enables mismatched email and can safely re-verify',()=>{
  const h=createStudentEmailHarness();register(h);const challenge=h.latestChallenge();const sh=h.spreadsheet.getSheetByName('studentEmails'),verified=sh.values[0].indexOf('verifiedAt');
  failWriteOnce(sh,values=>!!values[0][verified]);rejected(h.request({action:'studentEmailVerify',challenge}));assert.equal(h.studentRow().email,EMAIL);assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');
  h.advance(61000);ok(h.student('studentEmailResend'));ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));
});
test('interrupted removal cannot revive pending proof or continue verified delivery',()=>{
  const h=createStudentEmailHarness();verify(h);h.advance(61000);register(h,'new@example.invalid');const challenge=h.latestChallenge(),sh=h.spreadsheet.getSheetByName('students');
  failWriteOnce(sh,values=>values[0][0]==='');rejected(h.student('studentEmailRemove'));
  assert.equal(h.context().studentEmailVerifiedAddress_('test-a'),'');rejected(h.request({action:'studentEmailVerify',challenge}));ok(h.student('studentEmailRemove'));assert.equal(h.studentRow().email,'');
});
test('new email cannot reactivate a stale failed notice after removing and re-registering the same address',()=>{
  const h=createStudentEmailHarness();verify(h);h.setQuota(0);notify(h,'stale');h.setQuota(100);ok(h.student('studentEmailRemove'));h.advance(61000);verify(h);const before=h.mailbox.length;
  ok(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out(h,'stale').id}));assert.equal(out(h,'stale').status,'cancelled');assert.equal(h.mailbox.length,before);
});
test('student email schema validates every existing header before creating other tables',()=>{
  const h=createStudentEmailHarness();h.spreadsheet.insertSheet('studentEmailOutbox').appendRow(['wrong']);assert.throws(()=>h.context().ensureStudentEmailSchema_(),/列構成/);
  assert.equal(h.spreadsheet.getSheetByName('studentEmails'),null);
});
test('legacy empty subject and format are displayed safely before a valid edit, while new invalid values are rejected',()=>{
  const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;
  const before=slot({subject:'',deliveryMode:''}),after=slot({subject:'化学',deliveryMode:'in_person'});
  const sent=notify(h,'legacy-edit','changed',[before,after]);assert.equal(sent.recorded,true);assert.equal(sent.status,'sent');
  assert.match(h.mailbox[0].body,/変更前：.*科目未登録（形式未登録）/);assert.match(h.mailbox[0].body,/変更後：.*化学（対面）/);
  const bad=notify(h,'bad-new-edit','changed',[after,before]);assert.equal(bad.ok,false);assert.equal(bad.recorded,false);assert.equal(h.mailbox.length,1);
  assert.equal(notify(h,'legacy-cancel','cancelled',[before]).status,'sent');
});
test('notification reservation reports whether its outbox persisted across a lost initial write receipt',()=>{
  for(const durable of [false,true]){
    const h=createStudentEmailHarness();verify(h);h.mailbox.length=0;const sh=h.spreadsheet.getSheetByName('studentEmailOutbox'),key=sh.values[0].indexOf('eventKey');
    failWriteOnce(sh,values=>values[0][key]==='lost-initial-receipt',durable);
    const first=notify(h,'lost-initial-receipt');assert.equal(first.ok,false);assert.equal(first.recorded,durable);assert.equal(h.mailbox.length,0);
    const resumed=notify(h,'lost-initial-receipt');assert.equal(resumed.recorded,true);assert.equal(resumed.status,'sent');assert.equal(h.mailbox.length,1);
    assert.equal(h.rows('studentEmailOutbox').filter(o=>o.eventKey==='lost-initial-receipt').length,1);
  }
});
test('business send failure with a reserved outbox is distinguished from a missing reservation',()=>{
  const h=createStudentEmailHarness();verify(h);h.setQuota(0);const result=notify(h,'quota-reserved');assert.equal(result.recorded,true);assert.equal(result.status,'failed');
  const c=h.context();c.studentEmailOutboxAdd_=()=>{throw new Error('Synthetic cannot create outbox');};
  const absent=c.studentEmailNotifyOffered_(c.findStudent_('test-a'),'no-outbox',[slot()]);assert.equal(absent.recorded,false);assert.equal(absent.ok,false);
});
