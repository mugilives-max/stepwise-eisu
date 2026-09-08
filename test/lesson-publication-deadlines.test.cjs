'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(){
  const h=createHarness({iterations:10}); h.context().ensureLessonSchema_();
  h.slot=(id,date,start='13:00',subject='英語',studentId='test-a',status='booked')=>h.spreadsheet.getSheetByName('slots').appendRow([id,date,start,60,status,studentId,false,'','',''+subject,'']);
  h.slot('source','2026-09-07');
  h.lesson=(op,args={})=>clone(h.context().lessonAdmin_({action:'admin',op,token:TEACHER_TOKEN,studentId:'test-a',...args}));
  h.save=(args={})=>h.lesson('lessonRecordSave',{slotId:'source',requestId:'save-1',expectedRevision:0,record:{content:'公開する本文',progress:'公開する様子',nextFocus:'公開する次回の焦点',teacherNote:'PRIVATE_ONLY_743',homework:[]},...args});
  h.public=(studentId='test-a')=>clone(h.context().lessonPublishedForStudent_(studentId));
  return h;
}
function failWrite(h,name,predicate,after=false){
  const sh=h.spreadsheet.getSheetByName(name),getRange=sh.getRange;let fired=false;
  sh.getRange=function(...args){const range=getRange.apply(this,args),write=range.setValues;range.setValues=function(values){if(!fired&&predicate(values,args)){fired=true;if(after)write.call(this,values);throw new Error('SIMULATED_SHEET_FAILURE');}return write.call(this,values);};return range;};
  return()=>{sh.getRange=getRange;};
}
const nextItem=(extra={})=>({itemId:'hw-1',title:'単語の練習',type:'宿題',due:'',dueMode:'nextLesson',...extra});
function withHomework(h,items=[nextItem()]){
  return ok(h.save({record:{content:'授業内容',teacherNote:'PRIVATE_ONLY_743',homework:items}}));
}
function apply(h,r,requestId='apply-1'){return ok(h.lesson('lessonHomeworkApply',{recordId:r.recordId,expectedRevision:r.revision,requestId}));}
function due(h){return clone(h.context().lessonTaskDueView_(h.rows('tasks')[0]));}

test('new saves publish whitelisted snapshots to only the original student and omit private drafts',()=>{
  const h=fixture(),saved=ok(h.save());
  assert.equal(saved.publishedRevision,1); assert.equal(saved.context.record.publishedRevision,1);
  assert.equal(h.public()[0].content,'公開する本文'); assert.equal(h.public('test-b').length,0);
  assert.deepEqual(Object.keys(h.public()[0]).sort(),['recordId','revision','date','start','min','subject','content','progress','nextFocus','publishedAt','homework'].sort());
  ok(h.lesson('lessonReportDraftSave',{recordId:saved.recordId,expectedDraftRevision:0,sourceRevision:1,requestId:'draft-1',body:'PRIVATE_DRAFT_812'}));
  const serialized=JSON.stringify(h.public()); assert.equal(serialized.includes('PRIVATE_'),false); assert.equal(JSON.stringify(h.rows('lessonPublicSnapshots')).includes('PRIVATE_'),false);
  assert.equal(h.public()[0].revision,1); assert.equal(h.rows('tasks').length,0,'public lesson text does not implicitly create tasks');
  h.setRow('slots','id','source',{studentId:'test-b'});
  assert.equal(h.public('test-b').length,0); assert.equal(h.public()[0].content,'公開する本文');
  h.setRow('students','id','test-a',{active:false}); assert.equal(h.public().length,0);
});

test('an immutable prior public version remains readable across each interrupted save boundary',()=>{
  for(const [sheet,predicate] of [
    ['lessonPrivateNotes',v=>v[0][1]==='NEW_PRIVATE'],
    ['lessonRecords',v=>v[0][11]===2],
    ['lessonPublicSnapshots',v=>v[0][4]===2],
    ['lessonWrites',v=>v[0][4]==='applied']
  ])for(const after of [false,true]){
    const h=fixture();ok(h.save());const firstSnapshot=clone(h.rows('lessonPublicSnapshots')[0]);
    const restore=failWrite(h,sheet,predicate,after);
    const r=h.save({requestId:'save-2',expectedRevision:1,record:{content:'新しい公開版',teacherNote:'NEW_PRIVATE',homework:[]}});
    assert.equal(r.errorCode,'pending',sheet+' '+after);
    const receiptCommitted=sheet==='lessonWrites'&&after;
    assert.equal(h.public()[0].content,receiptCommitted?'新しい公開版':'公開する本文',sheet+' '+after);
    assert.deepEqual(h.rows('lessonPublicSnapshots')[0],firstSnapshot,'old snapshot is immutable');restore();
    ok(h.lesson('lessonWriteResume',{requestId:'save-2'})); assert.equal(h.public()[0].revision,2);
    assert.equal(h.rows('lessonPublicSnapshots').length,2); assert.equal(JSON.stringify(h.public()).includes('PRIVATE'),false);
    ok(h.lesson('lessonWriteResume',{requestId:'save-2'})); assert.equal(h.rows('lessonPublicSnapshots').length,2);
  }
});

test('new publication is hidden until the initial save receipt commits',()=>{
  const h=fixture(),restore=failWrite(h,'lessonWrites',v=>v[0][4]==='applied');
  assert.equal(h.save().errorCode,'pending');assert.equal(h.rows('lessonPublicSnapshots').length,1);assert.deepEqual(h.public(),[]);
  restore();ok(h.lesson('lessonWriteResume',{requestId:'save-1'}));assert.equal(h.public().length,1);
});

test('legacy pending or applied saves and report drafts never publish retrospectively',()=>{
  for(const status of ['pending','applied']){
    const h=fixture(),restore=failWrite(h,'lessonRecords',()=>true);
    assert.equal(h.save().errorCode,'pending');restore();
    const w=h.rows('lessonWrites')[0],plan=JSON.parse(w.payloadJson);delete plan.publicSnapshot;
    h.setRow('lessonWrites','requestId','save-1',{payloadJson:JSON.stringify(plan)});
    const old=ok(h.lesson('lessonWriteResume',{requestId:'save-1'}));
    if(status==='applied')ok(h.save()); // Exact old normalization/hash must still replay.
    assert.equal(h.public().length,0);assert.equal(h.rows('lessonPublicSnapshots').length,0);
    ok(h.lesson('lessonReportDraftSave',{recordId:old.recordId,expectedDraftRevision:0,sourceRevision:1,requestId:'draft-only',body:'古い未公開報告'}));
    assert.equal(h.public().length,0);
    ok(h.save({expectedRevision:1,requestId:'explicit-new-save'}));assert.equal(h.public()[0].revision,2);
    assert.equal(JSON.stringify(h.public()).includes('古い未公開報告'),false);
  }
});

test('void removes all public versions without deleting snapshots or applied homework',()=>{
  const h=fixture(),r=withHomework(h);apply(h,r);
  ok(h.lesson('lessonRecordVoid',{recordId:r.recordId,expectedRevision:1,requestId:'void-1',reason:'記録を訂正する'}));
  assert.equal(h.public().length,0);assert.equal(h.rows('lessonPublicSnapshots').length,1);assert.equal(h.rows('tasks').length,1);
  const replacement=ok(h.save({requestId:'replacement'}));assert.notEqual(replacement.recordId,r.recordId);assert.equal(h.public().length,1);assert.equal(h.public()[0].recordId,replacement.recordId);
});

test('next lesson resolves by original same-subject booked time and retains an overdue target',()=>{
  const h=fixture();
  h.slot('earlier','2026-09-06');h.slot('simultaneous','2026-09-07');
  h.slot('offered','2026-09-07','13:01','英語','test-a','offered');
  h.slot('other-subject','2026-09-07','13:02','数学');h.slot('other-student','2026-09-07','13:03','英語','test-b');
  h.slot('next','2026-09-07','15:00');h.slot('later','2026-09-14');
  const r=withHomework(h);assert.equal(r.context.homeworkState[0].dueStart,'15:00');apply(h,r);
  assert.deepEqual(due(h),{due:'2026-09-07',dueMode:'nextLesson',dueSubject:'英語',dueStart:'15:00',nextLessonPending:false});
  assert.equal(h.rows('tasks')[0].dueAfter,'2026-09-07T13:00');
  h.advance(20*86400000);assert.equal(due(h).due,'2026-09-07','must not jump past a now overdue booking');
  h.setRow('slots','id','next',{date:'2026-09-08',start:'16:30'});assert.equal(due(h).due,'2026-09-08');assert.equal(due(h).dueStart,'16:30');
  h.setRow('slots','id','next',{status:'open'});assert.equal(due(h).due,'2026-09-14');
  assert.equal(h.public()[0].homework[0].due,'2026-09-14');
  h.setRow('slots','id','later',{subject:'数学'});assert.equal(due(h).nextLessonPending,true);
  assert.equal(h.lesson('lessonContext',{slotId:'source'}).context.homeworkState[0].status,'applied','calendar changes are not draft edits');
});

test('completion freezes the deadline and apply/retry keeps it even after calendar changes',()=>{
  const h=fixture();h.slot('next','2026-09-08','16:30');let r=withHomework(h);apply(h,r);
  const id=h.rows('tasks')[0].id;ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],true));
  const done=clone(h.rows('tasks')[0]);assert.equal(done.due,'2026-09-08');assert.equal(done.dueTime,'16:30');
  h.setRow('slots','id','next',{date:'2026-09-10',start:'18:00'});assert.equal(due(h).due,'2026-09-08');
  r=ok(h.save({expectedRevision:1,requestId:'save-2',record:{content:'追加の授業内容',homework:[nextItem()]}}));apply(h,r,'apply-2');
  assert.equal(h.rows('tasks')[0].doneAt,done.doneAt);assert.equal(due(h).dueStart,'16:30');assert.equal(h.rows('tasks')[0].id,id);
  ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],true));assert.equal(h.rows('tasks')[0].doneAt,done.doneAt);
  ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],false));assert.equal(due(h).due,'2026-09-10');
});

test('completed pending deadlines stay unset, while reopening resumes dynamic resolution',()=>{
  const h=fixture(),r=withHomework(h);apply(h,r);assert.equal(due(h).nextLessonPending,true);
  ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],true));h.slot('new-booking','2026-09-11');
  assert.equal(due(h).due,'');assert.equal(due(h).nextLessonPending,true);
  ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],false));assert.equal(due(h).due,'2026-09-11');
});

test('completion failure cannot persist half a deadline and retry preserves a committed completion',()=>{
  for(const after of [false,true]){
    const h=fixture();h.slot('next','2026-09-08');apply(h,withHomework(h));
    const restore=failWrite(h,'tasks',v=>!!v[0][7],after);
    assert.throws(()=>h.context().lessonSetTaskDone_(h.rows('tasks')[0],true),/SIMULATED/);restore();
    const before=clone(h.rows('tasks')[0]);assert.equal(!!before.doneAt,after);assert.equal(before.due,after?'2026-09-08':'');
    h.setRow('slots','id','next',{date:'2026-09-09'});ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],true));
    assert.equal(due(h).due,after?'2026-09-08':'2026-09-09');
  }
});

test('date/none legacy tasks retain semantics and explicit mode changes on completed homework are held',()=>{
  const h=fixture(),r=withHomework(h,[{itemId:'hw-1',title:'日付指定',due:'2026-09-10',type:'宿題'}]);apply(h,r);
  assert.equal(due(h).dueMode,'date');assert.equal(due(h).due,'2026-09-10');
  ok(h.context().lessonSetTaskDone_(h.rows('tasks')[0],true));
  const next=ok(h.save({requestId:'save-2',expectedRevision:1,record:{content:'編集',homework:[nextItem({title:'日付指定'})]}}));
  assert.deepEqual(apply(h,next,'apply-2').held,['hw-1']);assert.equal(due(h).dueMode,'date');
  assert.equal(h.context().lessonTaskDueView_({due:'',doneAt:'',studentId:'test-a'}).dueMode,'none');
  assert.equal(h.context().lessonTaskDueView_({due:'2020-01-01',doneAt:'legacy-done',studentId:'test-a'}).due,'2020-01-01');
});

test('generic task deadlines use server JST or a validated owned booked source slot',()=>{
  const h=fixture(),c=h.context();
  assert.deepEqual(clone(c.lessonTaskAddFields_({dueMode:'nextLesson',dueSubject:'英語'},'test-a')),{due:'',dueMode:'nextLesson',dueSubject:'英語',dueAfter:'2026-09-07T13:00',dueTime:''});
  h.slot('other','2026-09-08','15:00','英語','test-b');h.slot('math','2026-09-08','14:00','数学');h.slot('offer','2026-09-09','14:00','英語','test-a','offered');
  for(const req of [{dueMode:'nextLesson'},{dueMode:'surprise'},{dueMode:'date',due:''},{dueMode:'date',due:'2026-02-30'},{dueMode:'nextLesson',dueSubject:'英語',afterSlotId:'other'},{dueMode:'nextLesson',dueSubject:'英語',afterSlotId:'math'},{dueMode:'nextLesson',dueSubject:'英語',afterSlotId:'offer'}])assert.throws(()=>h.context().lessonTaskAddFields_(req,'test-a'));
  const fields=h.context().lessonTaskAddFields_({dueMode:'nextLesson',dueSubject:'英語',afterSlotId:'source'},'test-a');assert.equal(fields.dueAfter,'2026-09-07T13:00');
  assert.equal(c.lessonTaskAddFields_({due:'2026-09-10'},'test-a').dueMode,'date');assert.equal(c.lessonTaskAddFields_({dueMode:'none',due:'2026-09-10'},'test-a').due,'');
});

test('invalid record deadline modes and forged anchors reject before any journal or snapshot',()=>{
  const h=fixture();
  for(const item of [nextItem({dueMode:'unknown'}),nextItem({dueMode:'date'}),nextItem({dueAfter:'1900-01-01T00:00'}),nextItem({dueSubject:'数学'})]){
    const result=h.save({record:{content:'保存不可',homework:[item]}});assert.equal(result.errorCode,'validation');
  }
  assert.equal(h.rows('lessonWrites').length,0);assert.equal(h.rows('lessonPublicSnapshots').length,0);
  h.setRow('slots','id','source',{subject:''});assert.equal(h.save({record:{content:'科目未設定',homework:[nextItem()]}}).errorCode,'validation');
  assert.equal(h.rows('lessonWrites').length,0,'source subject must be checked before accepting the write');
});

test('real public/teacher task routes resolve deadlines and preserve ownership and completion snapshots',()=>{
  const h=fixture();h.slot('next','2026-09-09','16:00');
  const added=ok(h.request({action:'taskAdd',k:'synthetic-link-a',title:'本人の宿題',dueMode:'nextLesson',dueSubject:'英語'}));
  assert.equal(added.state.tasks[0].due,'2026-09-09');assert.equal(added.state.tasks[0].dueSubject,'英語');
  const task=h.rows('tasks')[0];assert.equal(task.dueAfter,'2026-09-07T13:00');
  assert.ok(h.request({action:'taskDone',k:'synthetic-link-b',taskId:task.id,done:true}).error);
  const completed=ok(h.request({action:'taskDone',k:'synthetic-link-a',taskId:task.id,done:true}));assert.equal(completed.state.tasks[0].done,true);
  h.setRow('slots','id','next',{date:'2026-09-10'});assert.equal(h.get({action:'state',k:'synthetic-link-a'}).tasks[0].due,'2026-09-09');
  ok(h.admin('taskDone',{studentId:'test-a',taskId:task.id,done:false}));assert.equal(h.get({action:'state',k:'synthetic-link-a'}).tasks[0].due,'2026-09-10');
  ok(h.admin('taskAdd',{studentId:'test-a',title:'先生の指定日課題',dueMode:'date',due:'2026-09-12'}));assert.equal(h.rows('tasks')[1].dueMode,'date');
  const count=h.rows('tasks').length;assert.ok(h.admin('taskAdd',{studentId:'test-a',title:'不正な期限',dueMode:'date',due:'2026-02-30'}).error);assert.equal(h.rows('tasks').length,count);
});

test('family data publishes each linked child independently and rejects unlinked scopes without leaking notes',()=>{
  const h=createFamilyHarness(),pass='Synthetic family lesson password!';
  const family=ok(h.admin('familyCreate',{label:'【テスト】授業共有',studentIds:['test-a','test-b']}));
  ok(h.family('familyRegister',{inviteCode:family.inviteCode,email:'lesson-parent@example.invalid',pass}));
  ok(h.family('familyVerify',{challenge:h.latestChallenge()}));const login=ok(h.family('familyLogin',{email:'lesson-parent@example.invalid',pass}));
  for(const studentId of ['test-a','test-b']){
    h.spreadsheet.getSheetByName('slots').appendRow(['slot-'+studentId,'2026-09-07','13:00',60,'booked',studentId,false,'','','英語','']);
    ok(h.admin('lessonRecordSave',{studentId,slotId:'slot-'+studentId,requestId:'save-'+studentId,expectedRevision:0,record:{content:'本人だけの本文-'+studentId,teacherNote:'PRIVATE_FAMILY_325',homework:[]}}));
  }
  for(const studentId of ['test-a','test-b']){
    const data=ok(h.family('familyData',{ftoken:login.ftoken,studentId})).data;
    assert.equal(data.lessonRecords.length,1);assert.equal(data.lessonRecords[0].content,'本人だけの本文-'+studentId);assert.equal(JSON.stringify(data).includes('PRIVATE_FAMILY_325'),false);
  }
  const denied=h.family('familyData',{ftoken:login.ftoken,studentId:'test-inactive'});assert.ok(denied.error);assert.equal(JSON.stringify(denied).includes('本人だけの本文'),false);
  const original=h.rows('lessonRecords').find(r=>r.studentId==='test-a');
  ok(h.admin('lessonRecordVoid',{studentId:'test-a',recordId:original.id,requestId:'void-a',expectedRevision:1,reason:'テストの無効化'}));
  assert.equal(ok(h.family('familyData',{ftoken:login.ftoken,studentId:'test-a'})).data.lessonRecords.length,0);
  assert.equal(ok(h.family('familyData',{ftoken:login.ftoken,studentId:'test-b'})).data.lessonRecords.length,1);
});
