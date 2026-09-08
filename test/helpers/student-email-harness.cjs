'use strict';
const {createHarness,TEACHER_TOKEN}=require('../gas-harness.cjs');
function createStudentEmailHarness(options={}){
  const h=createHarness({iterations:10,...options}),mailbox=[];let quota=100,fail=false,afterSend=false,testGuard=false;
  const original=h.context;
  function context(){
    const c=original();c.MailApp.getRemainingDailyQuota=()=>quota;
    c.MailApp.sendEmail=message=>{if(fail&&!afterSend)throw new Error('Synthetic mail failure with private body '+message.body);mailbox.push(message);if(fail)throw new Error('Synthetic response lost after send');};
    if(!testGuard)c.studentEmailTest_=()=>false;return c;
  }
  function request(req){return JSON.parse(context().doPost({postData:{contents:JSON.stringify(req)}}).getContent());}
  return Object.assign(h,{context,request,mailbox,
    student:(action,args={})=>request({action,k:'synthetic-link-a',...args}),
    admin:(op,args={})=>request({action:'admin',op,token:TEACHER_TOKEN,...args}),
    latestChallenge:()=>decodeURIComponent(mailbox.filter(m=>m.body.includes('#student-email?verify=')).at(-1).body.match(/\?verify=([^\s]+)/)[1]),
    setQuota:n=>{quota=n;},setMailFailure:(enabled,resultLost=false)=>{fail=enabled;afterSend=resultLost;},enableTestGuard:()=>{testGuard=true;}
  });
}
module.exports={createStudentEmailHarness};
