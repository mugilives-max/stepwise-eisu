const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
function setup(){const h=createHarness();h.admin('state');const c=h.context();let mails=[];c.isTestStudent_=()=>false;c.notify_=(...args)=>mails.push(args);return {c,mails};}
const event={date:'2026-10-01',dateTo:'2026-10-01',title:'模試',kind:'test'};
test('PDF bulk event registration and teacher manual/AI event registration send no teacher email',()=>{
 const {c,mails}=setup();for(let i=1;i<=3;i++){const r=c.admin_({token:TEACHER_TOKEN,op:'documentEventAdd',studentId:'test-a',...event,date:'2026-10-0'+i,dateTo:'2026-10-0'+i});assert.equal(r.ok,true);}
 const r=c.admin_({token:TEACHER_TOKEN,op:'nlApplyTeacher',studentId:'test-a',items:[{kind:'event',dates:['2026-10-05'],title:'修学旅行'}]});assert.ok(!r.error,r.error);assert.equal(mails.length,0);assert.equal(c.eventRows_().length,4);
});
test('student/parent event notifications remain enabled and request flags cannot suppress them',()=>{
 const {c,mails}=setup();assert.equal(c.eventAdd_({k:'synthetic-link-a',...event,teacherInitiated:true}).ok,true);assert.equal(mails.length,1);
 assert.equal(c.eventAddMany_({k:'synthetic-link-a',title:'大会',ranges:[{date:'2026-10-02',dateTo:'2026-10-02'}],teacherInitiated:true}).ok,true);assert.equal(mails.length,2);
});
test('invalid teacher session cannot register events or send mail',()=>{
 const {c,mails}=setup();assert.ok(c.admin_({token:'invalid',op:'documentEventAdd',studentId:'test-a',...event}).error);assert.equal(c.eventRows_().length,0);assert.equal(mails.length,0);
});
