'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStudentEmailHarness}=require('./helpers/student-email-harness.cjs');
const {failWriteOnce}=require('./helpers/scheduling-harness.cjs');
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(verified=true){
  const h=createStudentEmailHarness();ok(h.admin('state'));
  if(verified){ok(h.student('studentEmailRequest',{email:'student-cancel@example.invalid'}));ok(h.request({action:'studentEmailVerify',challenge:h.latestChallenge()}));h.mailbox.length=0;}
  else h.setRow('students','id','test-a',{email:'legacy-unverified@example.invalid'});
  h.slot=(status='booked',patch={})=>{
    const row={id:'cancel-slot',studentId:'test-a',date:'2026-09-15',start:'15:00',min:60,status,done:'',eventId:'',meetUrl:'',subject:'数学',req:JSON.stringify({kind:'cancel',reason:'PRIVATE_CANCEL_REASON',at:'2026-09-07 13:00'}),deliveryMode:'in_person',...patch};
    const sh=h.spreadsheet.getSheetByName('slots');sh.appendRow(sh.values[0].map(k=>row[k]??''));return row;
  };
  h.cancel=(op='unbook',args={})=>h.admin(op,{studentId:'test-a',slotId:'cancel-slot',...args});
  return h;
}

test('teacher cancellation and declined-request routes send only verified public snapshots, once',()=>{
  for(const [op,status,extra,kind] of [['deleteSlot','offered',{},'cancelled'],['unbook','booked',{},'cancelled'],['resolveCancel','booked',{approve:true},'cancelled'],['resolveCancel','booked',{approve:false},'cancelDeclined']]){
    const h=fixture();h.slot(status);ok(h.cancel(op,extra));assert.equal(h.mailbox.length,1,op);
    const mail=h.mailbox[0];assert.match(mail.body,/2026-09-15 15:00/);assert.equal(mail.to,'student-cancel@example.invalid');assert.equal(mail.body.includes('PRIVATE_CANCEL_REASON'),false);assert.equal(mail.body.includes('synthetic-link-a'),false);
    assert.equal(h.rows('studentEmailOutbox').at(-1).kind,kind);assert.equal(h.rows('slotChangeNotices')[0].status,'done');
    ok(h.cancel(op,extra));assert.equal(h.mailbox.length,1,'replay does not send twice');
    if(kind==='cancelDeclined'){assert.equal(h.rows('slots')[0].status,'booked');assert.equal(h.rows('slots')[0].req,'');}
  }
});

test('legacy stored addresses cannot receive cancellation or deprecated mail entrypoints',()=>{
  const h=fixture(false);h.slot();ok(h.cancel());assert.equal(h.mailbox.length,0);assert.equal(h.rows('studentEmailOutbox')[0].status,'skipped');
  const c=h.context();c.mailStudent_(c.systemStudent_('test-a'),'subject','private body');c.offerMailToStudent_(c.systemStudent_('test-a'),['2026-09-15'],'15:00',60,'数学');assert.equal(h.mailbox.length,0);
});

test('cancellation journal failure before and after persistence leaves the booking recoverable',()=>{
  for(const after of [false,true]){
    const h=fixture();h.slot();failWriteOnce(h.spreadsheet.getSheetByName('slotChangeNotices'),()=>true,after);
    assert.equal(h.cancel().errorCode,'pending');assert.equal(h.rows('slots')[0].status,'booked');assert.equal(h.mailbox.length,0);
    if(after){assert.equal(h.context().slotCancellationPending_('cancel-slot').errorCode,'pending');assert.equal(h.admin('toggleDone',{studentId:'test-a',slotId:'cancel-slot',done:true}).errorCode,'pending');}
    ok(h.cancel());assert.equal(h.rows('slots')[0].status,'open');assert.equal(h.mailbox.length,1);assert.equal(h.rows('slotChangeNotices').length,1);
  }
});

test('interrupted booking-cell writes recover without repeating a notification or losing its original student',()=>{
  for(const after of [false,true]){
    const h=fixture();h.slot();failWriteOnce(h.spreadsheet.getSheetByName('slots'),v=>v[0][4]==='open',after);
    assert.equal(h.cancel().errorCode,'pending');assert.equal(h.mailbox.length,0);
    ok(h.cancel());assert.equal(h.mailbox.length,1);assert.equal(h.rows('studentEmailOutbox').at(-1).studentId,'test-a');assert.equal(h.rows('slots')[0].studentId,'');
  }
});

test('deleted offered rows recover notification setup from their durable original snapshot',()=>{
  for(const after of [false,true]){
    const h=fixture();h.slot('offered');const sh=h.spreadsheet.getSheetByName('slots'),del=sh.deleteRow;
    sh.deleteRow=function(index){sh.deleteRow=del;if(after)del.call(this,index);throw new Error('synthetic lost deletion');};
    assert.equal(h.cancel('deleteSlot').errorCode,'pending');assert.equal(h.mailbox.length,0);
    if(after){ok(h.admin('kanriStudent',{studentId:'test-a'}));assert.equal(h.mailbox.length,1,'teacher read completes only an already durable cancellation notice');}
    else{ok(h.admin('kanriStudent',{studentId:'test-a'}));assert.equal(h.mailbox.length,0,'teacher read must not perform the uncommitted deletion');}
    ok(h.cancel('deleteSlot'));assert.equal(h.rows('slots').length,0);assert.equal(h.mailbox.length,1);
  }
});

test('outbox preparation failure keeps a recoverable cancellation; saved outbox failure is retryable separately',()=>{
  for(const after of [false,true]){
    const h=fixture();h.slot('offered');failWriteOnce(h.spreadsheet.getSheetByName('studentEmailOutbox'),v=>v[0][3]==='cancelled',after);
    const res=ok(h.cancel('deleteSlot'));assert.match(res.notificationWarning,/通知/);assert.equal(h.rows('slots').length,0);assert.equal(h.mailbox.length,0);
    if(!after){assert.equal(h.rows('slotChangeNotices')[0].status,'pending');ok(h.admin('state'));assert.equal(h.mailbox.length,1);}
    else{assert.equal(h.rows('slotChangeNotices')[0].status,'done');const out=h.rows('studentEmailOutbox').at(-1);ok(h.admin('studentEmailRetryNotification',{studentId:'test-a',notificationId:out.id}));assert.equal(h.mailbox.length,1);}
  }
});

test('uncertain delivery and lost cancellation receipts never send twice',()=>{
  const h=fixture();h.slot();h.setMailFailure(true,true);const res=ok(h.cancel());assert.match(res.notificationWarning,/通知/);assert.equal(h.mailbox.length,1);
  h.setMailFailure(false);ok(h.cancel());ok(h.admin('state'));assert.equal(h.mailbox.length,1);
  const hh=fixture();hh.slot();failWriteOnce(hh.spreadsheet.getSheetByName('slotChangeNotices'),v=>v[0][6]==='done');assert.equal(hh.cancel().errorCode,'pending');assert.equal(hh.mailbox.length,1);ok(hh.cancel());assert.equal(hh.mailbox.length,1);
});

test('pending cancellation cannot be redirected to another student, another decision or a changed slot',()=>{
  const h=fixture();h.slot();failWriteOnce(h.spreadsheet.getSheetByName('slots'),v=>v[0][4]==='open');assert.equal(h.cancel().errorCode,'pending');
  assert.equal(h.cancel('unbook',{studentId:'test-b'}).errorCode,'conflict');assert.equal(h.cancel('resolveCancel',{approve:true}).errorCode,'pending');
  assert.equal(h.student('cancelReq',{slotId:'cancel-slot',withdraw:true}).errorCode,'pending');
  h.setRow('slots','id','cancel-slot',{studentId:'test-b'});assert.equal(h.cancel().errorCode,'conflict');assert.equal(h.mailbox.length,0);assert.equal(h.rows('slots')[0].studentId,'test-b');
});

test('legacy Calendar creates teacher-only events and all writes suppress external updates',()=>{
  const h=fixture(false),c=h.context(),calls=[];c.setConfig_('calendarSync','on');
  c.Calendar={Events:{insert(body,calendar,options){calls.push({op:'insert',body,options});return{id:'synthetic-event',iCalUID:'synthetic-event@google.com'};},get(){return{};},patch(body,calendar,id,options){calls.push({op:'patch',body,options});return{hangoutLink:'https://meet.example.invalid/synthetic'};},remove(calendar,id,options){calls.push({op:'remove',options});}}};
  const s={id:'synthetic-calendar-student',name:'架空の検証生徒',email:'unverified@example.invalid'},slot={id:'legacy-slot',studentId:s.id,date:'2026-09-15',start:'15:00',min:60,subject:'数学',deliveryMode:'online'};
  const event=c.createCalEvent_(slot,s);assert.equal(event.meetUrl,'https://meet.example.invalid/synthetic');c.deleteCalEvent_({...slot,eventId:event.eventId});
  assert.equal(calls.length,3);for(const call of calls){assert.equal(call.options.sendUpdates,'none');assert.equal(JSON.stringify(call).includes('unverified@example.invalid'),false);assert.equal(call.body?.attendees,undefined);assert.equal(call.body?.guests,undefined);}
});

test('Calendar deletion failure leaves the booking and stable cancellation journal for a safe retry',()=>{
  const h=fixture();h.setRow('students','id','test-a',{name:'架空のカレンダー検証'});h.slot('booked',{eventId:'synthetic-legacy-event@google.com'});
  const c=h.context();let fail=true,count=0;c.Calendar={Events:{remove(calendar,id,options){count++;assert.equal(options.sendUpdates,'none');if(fail)throw new Error('503 synthetic failure');}}};
  assert.equal(c.slotCancellation_({slotId:'cancel-slot',studentId:'test-a'},'unbook').errorCode,'pending');assert.equal(h.rows('slots')[0].status,'booked');assert.equal(h.mailbox.length,0);
  fail=false;ok(c.slotCancellation_({slotId:'cancel-slot',studentId:'test-a'},'unbook'));assert.equal(h.rows('slots')[0].status,'open');assert.equal(count,2);assert.equal(h.mailbox.length,1);
});
