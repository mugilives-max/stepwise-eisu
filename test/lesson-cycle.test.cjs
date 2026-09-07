'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, TEACHER_TOKEN, MCP_KEY } = require('./gas-harness.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const h = createHarness({ iterations: 10 });
  const c = h.context(); c.ensureLessonSchema_();
  h.spreadsheet.getSheetByName('slots').appendRow(['slot-a','2026-09-07','13:00',60,'booked','test-a',false,'event-unmodified','https://example.invalid/meet','英語','']);
  h.spreadsheet.getSheetByName('slots').appendRow(['slot-b','2026-09-07','14:00',60,'booked','test-b',false,'','','数学','']);
  h.lesson = (op,args={}) => clone(h.context().lessonAdmin_({ action:'admin',op,token:TEACHER_TOKEN,studentId:'test-a',...args }));
  h.contextFor = (args={}) => h.lesson('lessonContext',{slotId:'slot-a',...args});
  return h;
}
const record = (extra={}) => ({content:'一次関数のグラフ',progress:'切片を自分で説明できた',nextFocus:'変化の割合',teacherNote:'PRIVATE_SENTINEL_7x',homework:[{itemId:'item-1',title:'基本問題1〜3',due:'2026-09-09',type:'宿題'}],...extra});
const ok = r => { assert.equal(r.ok,true,JSON.stringify(r)); return r; };
const bad = (r,code) => { assert.notEqual(r.ok,true); assert.equal(r.errorCode,code,JSON.stringify(r)); return r; };
function save(h,args={}) { return h.lesson('lessonRecordSave',{slotId:'slot-a',expectedRevision:0,requestId:'save-1',record:record(),...args}); }
function apply(h,r,args={}) { return h.lesson('lessonHomeworkApply',{recordId:r.recordId,expectedRevision:r.revision,requestId:'apply-1',...args}); }
function snapshot(h) { return {slots:clone(h.rows('slots')),students:clone(h.rows('students')),ledger:clone([...h.ledger.sheets.entries()].map(([n,s])=>[n,s.values])),effects:clone(h.effects)}; }
function failWrite(h,name,predicate,after=false) {
  const sh=h.spreadsheet.getSheetByName(name), original=sh.getRange;
  let remaining=1;
  sh.getRange=function (...args) {
    const range=original.apply(this,args), write=range.setValues;
    range.setValues=function (values) {
      if (remaining && predicate(values,args)) { remaining--; if (after) write.call(this,values); throw new Error('SYNTHETIC_WRITE_FAILURE'); }
      return write.call(this,values);
    }; return range;
  };
  return ()=>{sh.getRange=original;};
}

test('schema appends four task columns, preserves old rows, is idempotent and preflights mismatches',()=>{
  const h=createHarness({iterations:10}), c=h.context(); c.ensureTasksSheet_();
  const sh=h.spreadsheet.getSheetByName('tasks'); sh.appendRow(['legacy-task','test-a','宿題','既存課題','',new Date(),'teacher','done-value']);
  const before=clone(sh.values[1]); c.ensureLessonSchema_(); c.ensureLessonSchema_();
  assert.deepEqual(clone(sh.values[1]),before); assert.equal(sh.values[0].length,12);
  assert.equal(h.spreadsheet.getSheetByName('lessonRecords').values.length,1);
  const broken=createHarness(), bc=broken.context(); bc.ensureTasksSheet_(); broken.spreadsheet.getSheetByName('tasks').values[0][2]='unexpected';
  assert.throws(()=>bc.ensureLessonSchema_(),/シート構成/);
  assert.equal(broken.spreadsheet.getSheetByName('lessonRecords'),null);
});

test('save is idempotent, revisions conflict, and records never change booking or billing state',()=>{
  const h=fixture(), before=snapshot(h), first=ok(save(h));
  assert.equal(first.revision,1); assert.equal(first.context.record.teacherNote,'PRIVATE_SENTINEL_7x');
  assert.equal(h.rows('tasks').length,0); assert.deepEqual(snapshot(h),before);
  const replay=ok(save(h)); assert.equal(replay.recordId,first.recordId); assert.equal(h.rows('lessonRecords').length,1); assert.equal(h.rows('lessonWrites').length,1);
  bad(save(h,{record:record({content:'変更'})}),'conflict');
  bad(save(h,{requestId:'stale-request'}),'conflict');
  const second=ok(save(h,{expectedRevision:1,requestId:'save-2',record:record({nextFocus:'更新'})}));
  assert.equal(second.recordId,first.recordId); assert.equal(second.revision,2); assert.deepEqual(snapshot(h),before);
  assert.equal(h.rows('lessonRecords')[0].createdBy,'teacher:primary');
  assert.equal(JSON.stringify(h.rows('lessonWrites')).includes(TEACHER_TOKEN),false);
});

test('ownership, authentication, inactive enrollment, unknown fields and strict input bounds',()=>{
  const h=fixture();
  assert.equal(h.lesson('lessonContext',{slotId:'slot-a',token:''}).badAuth,true);
  assert.equal(h.lesson('lessonContext',{slotId:'slot-a',mcpKey:MCP_KEY}).badAuth,true);
  bad(save(h,{slotId:'slot-b'}),'notFound');
  for (const rec of [record({content:''}),record({content:'x'.repeat(2001)}),record({teacherNote:'x'.repeat(2001)}),record({done:true}),record({homework:null}),record({homework:[{itemId:'a',title:'x',due:'2026-02-30'}]}),record({homework:[{itemId:'a',title:'x',due:'2026-99-01'}]}),record({homework:[{itemId:'a',title:'x'},{itemId:'a',title:'y'}]}),record({homework:Array.from({length:11},(_,i)=>({itemId:'i'+i,title:'x'}))})]) bad(save(h,{record:rec}),'validation');
  bad(save(h,{expectedRevision:'0'}),'validation'); bad(save(h,{done:true}),'validation');
  assert.equal(h.rows('lessonWrites').length,0);
  const r=ok(save(h));
  bad(h.lesson('lessonHomeworkApply',{studentId:'test-b',recordId:r.recordId,expectedRevision:1,requestId:'foreign'}),'notFound');
  h.setRow('students','id','test-a',{active:false});
  ok(save(h,{requestId:'inactive-edit',expectedRevision:1}));
  bad(apply(h,r,{expectedRevision:2}),'validation');
  h.spreadsheet.getSheetByName('slots').appendRow(['slot-inactive','2026-09-08','13:00',60,'booked','test-a',false,'','','英語','']);
  bad(save(h,{slotId:'slot-inactive',requestId:'inactive-new'}),'validation');
});

test('homework publication is explicit, stable across reorder, and preserves completed tasks',()=>{
  const h=fixture(); let r=ok(save(h)); const first=ok(apply(h,r));
  assert.deepEqual(first.added,['item-1']); const original=clone(h.rows('tasks')[0]);
  ok(apply(h,r)); assert.equal(h.rows('tasks').length,1);
  h.setRow('tasks','id',original.id,{doneAt:'2026-09-07T14:00:00Z'});
  r=ok(save(h,{requestId:'save-2',expectedRevision:1,record:record({homework:[{itemId:'item-2',title:'別課題',due:'',type:'宿題'},{itemId:'item-1',title:'変更した課題',due:'2026-09-10',type:'宿題'}]})}));
  const second=ok(apply(h,r,{requestId:'apply-2'})); assert.deepEqual(second.held,['item-1']); assert.deepEqual(second.added,['item-2']);
  const done=h.rows('tasks').find(t=>t.id===original.id); assert.equal(done.title,original.title); assert.equal(done.doneAt,'2026-09-07T14:00:00Z'); assert.equal(done.createdAt,original.createdAt);
  r=ok(save(h,{requestId:'save-3',expectedRevision:2,record:record({homework:[]})}));
  ok(apply(h,r,{requestId:'apply-3'})); assert.equal(h.rows('tasks').length,2); assert.ok(r.context.homeworkState.every(t=>t.status==='removed'));
  const withdrawal=ok(h.lesson('lessonHomeworkWithdraw',{recordId:r.recordId,itemId:'item-1',expectedRevision:3,requestId:'withdraw-1'}));
  assert.ok(h.rows('tasks').find(t=>t.id===original.id).withdrawnAt); assert.equal(h.rows('tasks').find(t=>t.id===original.id).doneAt,'2026-09-07T14:00:00Z');
  r=ok(save(h,{requestId:'save-4',expectedRevision:3}));
  ok(apply(h,r,{requestId:'apply-4'})); assert.equal(h.rows('tasks').length,2); assert.equal(r.context.homeworkState[0].status,'withdrawn');
  assert.equal(withdrawal.context.openTasks.some(t=>t.id===original.id),false);
});

test('second-task failure is pending and retry converges without overwriting student completion',()=>{
  const h=fixture(), r=ok(save(h,{record:record({homework:[{itemId:'item-1',title:'問題1',type:'宿題',due:''},{itemId:'item-2',title:'問題2',type:'宿題',due:''}]})}));
  const restore=failWrite(h,'tasks',values=>values[0][9]==='item-2');
  const pending=bad(apply(h,r),'pending'); assert.equal(pending.retryRequired,true); assert.equal(h.rows('tasks').length,1);
  const visible=ok(h.contextFor()).context; assert.equal(visible.record,null); assert.equal(visible.pending.operation,'lessonHomeworkApply');
  bad(save(h,{expectedRevision:1,requestId:'blocked-save'}),'pending');
  h.setRow('tasks','id',h.rows('tasks')[0].id,{doneAt:'student-completed-during-retry'}); restore();
  const completed=ok(h.lesson('lessonWriteResume',{requestId:'apply-1'})); assert.equal(completed.context.pending,null);
  assert.equal(h.rows('tasks').length,2); assert.equal(h.rows('tasks')[0].doneAt,'student-completed-during-retry');
  ok(apply(h,r)); assert.equal(h.rows('tasks').length,2);
});

test('private-note failure and receipt failure never expose mixed record versions',()=>{
  const h=fixture(); const r=ok(save(h));
  const restore=failWrite(h,'lessonRecords',values=>values[0][11]===2);
  bad(save(h,{requestId:'save-2',expectedRevision:1,record:record({content:'新しい本文',teacherNote:'NEW_PRIVATE'})}),'pending');
  assert.equal(h.rows('lessonRecords')[0].content,'一次関数のグラフ');
  const context=ok(h.contextFor()).context; assert.equal(context.record,null); assert.equal(context.draftTemplate,''); restore();
  ok(h.lesson('lessonWriteResume',{requestId:'save-2'})); assert.equal(ok(h.contextFor()).context.record.content,'新しい本文');
  const receiptFailure=failWrite(h,'lessonWrites',values=>values[0][4]==='applied');
  bad(save(h,{requestId:'save-3',expectedRevision:2}),'pending'); assert.equal(h.rows('lessonRecords')[0].revision,3); receiptFailure();
  ok(save(h,{requestId:'save-3',expectedRevision:2})); assert.equal(h.rows('lessonRecords')[0].revision,3); assert.equal(h.rows('lessonRecords').length,1);
  assert.equal(r.recordId,h.rows('lessonRecords')[0].id);
});

test('failure writing the journal starts no downstream write, including ambiguous acknowledgement',()=>{
  const h=fixture(); const restore=failWrite(h,'lessonWrites',()=>true);
  bad(save(h),'pending'); assert.equal(h.rows('lessonRecords').length,0); assert.equal(h.rows('lessonPrivateNotes').length,0); restore();
  const restoreAfter=failWrite(h,'lessonWrites',()=>true,true);
  bad(save(h),'pending'); assert.equal(h.rows('lessonRecords').length,0); assert.equal(h.rows('lessonWrites').length,1); restoreAfter();
  ok(save(h)); assert.equal(h.rows('lessonRecords').length,1);
});

test('recovery after cancellation finishes historical saves and stops new homework publication',()=>{
  const h=fixture(); const restore=failWrite(h,'lessonRecords',()=>true);
  bad(save(h),'pending'); h.setRow('slots','id','slot-a',{studentId:'test-b'}); restore();
  const recovered=ok(h.lesson('lessonWriteResume',{requestId:'save-1'}));
  assert.equal(recovered.context.record.studentId,'test-a'); assert.equal(recovered.context.slotChanged,true);
  const other=ok(h.lesson('lessonContext',{studentId:'test-b',slotId:'slot-a'})); assert.equal(other.context.record,null);
  const hh=fixture(), r=ok(save(hh,{record:record({homework:[{itemId:'item-1',title:'問題1',type:'宿題',due:''},{itemId:'item-2',title:'問題2',type:'宿題',due:''}]})}));
  const restoreTask=failWrite(hh,'tasks',v=>v[0][9]==='item-2'); bad(apply(hh,r),'pending'); restoreTask();
  hh.setRow('students','id','test-a',{active:false});
  const stopped=bad(hh.lesson('lessonWriteResume',{requestId:'apply-1'}),'conflict');
  assert.equal(stopped.partial,true); assert.equal(stopped.retryRequired,false); assert.deepEqual(stopped.failed,['item-2']); assert.equal(stopped.context.pending,null);
  assert.equal(hh.rows('lessonWrites').find(w=>w.requestId==='apply-1').status,'failed'); assert.equal(hh.rows('tasks').length,1);
  bad(apply(hh,r),'conflict'); assert.equal(hh.rows('tasks').length,1);
  ok(hh.lesson('lessonHomeworkWithdraw',{recordId:r.recordId,itemId:'item-1',requestId:'withdraw-after-stop'}));
});

test('restoring a copied dummy ledger retains request identities and resumes pending work',()=>{
  const h=fixture(), restore=failWrite(h,'lessonRecords',()=>true);
  bad(save(h),'pending'); restore();
  const copy=fixture(), Sheet=h.spreadsheet.getSheetByName('students').constructor;
  copy.spreadsheet.sheets=new Map([...h.spreadsheet.sheets].map(([name,sheet])=>[name,new Sheet(name,clone(sheet.values))]));
  const resumed=ok(copy.lesson('lessonWriteResume',{requestId:'save-1'}));
  ok(save(copy)); assert.equal(copy.rows('lessonRecords').length,1); assert.equal(copy.rows('lessonRecords')[0].id,resumed.recordId);
  assert.equal(copy.rows('lessonPrivateNotes')[0].teacherNote,'PRIVATE_SENTINEL_7x');
  assert.equal(h.rows('lessonRecords').length,0,'source dummy backup remains untouched');
});

test('previous record excludes other students, subjects, future entries and pending versions beyond 60 lessons',()=>{
  const h=fixture(); let previous;
  for (let i=1;i<=65;i++) {
    const date=new Date(Date.UTC(2026,5,i)).toISOString().slice(0,10), sid='history-'+i;
    h.spreadsheet.getSheetByName('slots').appendRow([sid,date,'13:00',60,'booked','test-a',false,'','','英語','']);
    previous=ok(save(h,{slotId:sid,requestId:'save-history-'+i,record:record({content:'記録'+i})}));
  }
  h.spreadsheet.getSheetByName('slots').appendRow(['other-subject','2026-09-06','13:00',60,'booked','test-a',false,'','','数学','']);
  ok(save(h,{slotId:'other-subject',requestId:'save-math'}));
  h.spreadsheet.getSheetByName('slots').appendRow(['future','2026-09-09','13:00',60,'booked','test-a',false,'','','英語','']);
  ok(save(h,{slotId:'future',requestId:'save-future'})); ok(save(h,{studentId:'test-b',slotId:'slot-b',requestId:'save-other'}));
  const context=ok(h.contextFor()).context; assert.equal(context.previous.id,previous.recordId); assert.equal(context.otherPrevious.length,1); assert.equal(context.lessonChoices.length,68);
  assert.equal(JSON.stringify(context.previous).includes('PRIVATE_SENTINEL'),false);
  assert.equal(context.lessonChoices.some(x=>x.id==='slot-b'),false);
  const tasks=h.spreadsheet.getSheetByName('tasks'); tasks.appendRow(['old-undone','test-a','宿題','期限切れ','2020-01-01','','teacher','']); tasks.appendRow(['no-due','test-a','宿題','期限なし','','','teacher','']);
  assert.equal(ok(h.contextFor()).context.openTasks.length,2);
});

test('deleted, unbooked, reassigned and rescheduled slots retain original ownership and block edits',()=>{
  for (const change of ['delete','unbook','reassign','reschedule']) {
    const h=fixture(), r=ok(save(h)); ok(apply(h,r));
    if (change==='delete') h.spreadsheet.getSheetByName('slots').deleteRow(2);
    else h.setRow('slots','id','slot-a',change==='unbook'?{studentId:'',status:'open'}:change==='reassign'?{studentId:'test-b'}:{date:'2026-09-08'});
    const context=ok(h.contextFor()).context; assert.equal(context.slotChanged,true); assert.equal(context.record.studentId,'test-a'); assert.equal(context.record.date,'2026-09-07');
    bad(save(h,{expectedRevision:1,requestId:'blocked-edit'}),change==='reschedule'?'conflict':'notFound');
    assert.equal(h.lesson('lessonContext',{studentId:'test-b',slotId:'slot-a',recordId:r.recordId}).errorCode,'notFound');
    ok(h.lesson('lessonHomeworkWithdraw',{recordId:r.recordId,itemId:'item-1',requestId:'orphan-withdraw'}));
    assert.equal(h.rows('lessonRecords').length,1); assert.equal(h.rows('tasks').length,1);
  }
});

test('void is separate from tasks and a replacement gets a fresh identity',()=>{
  const h=fixture(), first=ok(save(h)); ok(apply(h,first));
  const result=ok(h.lesson('lessonRecordVoid',{recordId:first.recordId,expectedRevision:1,requestId:'void-1',reason:'対象を確認し直す'}));
  assert.equal(result.context.record.status,'void'); assert.equal(h.rows('tasks').length,1);
  bad(apply(h,first,{requestId:'apply-void',expectedRevision:2}),'conflict');
  const next=ok(save(h,{requestId:'new-after-void'})); assert.notEqual(first.recordId,next.recordId); assert.equal(h.rows('lessonRecords').length,2);
  ok(apply(h,next,{requestId:'new-apply'})); assert.equal(h.rows('tasks').length,2);
});

test('draft is teacher-only, revisioned, and never overwritten when source changes',()=>{
  const h=fixture(); let r=ok(save(h));
  assert.equal(r.context.draftTemplate.includes('PRIVATE_SENTINEL'),false);
  const draft=ok(h.lesson('lessonReportDraftSave',{recordId:r.recordId,expectedDraftRevision:0,sourceRevision:1,requestId:'draft-1',body:'先生が編集した未公開本文'}));
  assert.equal(draft.context.draft.revision,1);
  r=ok(save(h,{requestId:'save-2',expectedRevision:1})); assert.equal(r.context.draft.body,'先生が編集した未公開本文'); assert.equal(r.context.draft.stale,true);
  bad(h.lesson('lessonReportDraftSave',{recordId:r.recordId,expectedDraftRevision:0,sourceRevision:2,requestId:'draft-stale',body:'消さない'}),'conflict');
  bad(h.lesson('lessonReportDraftSave',{recordId:r.recordId,expectedDraftRevision:1,sourceRevision:1,requestId:'source-stale',body:'消さない'}),'conflict');
  const c=h.context(), safe=[c.studentState_('synthetic-link-a'),c.kanriStudent_('test-a'),c.lessonMetadata_('test-a','slot-a')];
  const text=JSON.stringify(safe); assert.equal(text.includes('PRIVATE_SENTINEL'),false); assert.equal(text.includes('先生が編集した未公開本文'),false);
});

test('formula-like, HTML, newlines and leading apostrophes round-trip as plain text',()=>{
  const h=fixture(), content='=IMPORTXML("https://example.invalid","x")\n<script>literal</script>', note="'apostrophe";
  const saved=ok(save(h,{record:record({content,teacherNote:note,progress:'+hello',nextFocus:'-focus',homework:[{itemId:'item-1',title:'=1+1',due:'',type:'宿題'}]})}));
  assert.equal(saved.context.record.content,content); assert.equal(saved.context.record.teacherNote,note); assert.equal(saved.context.record.progress,'+hello');
  ok(apply(h,saved)); assert.equal(h.rows('tasks')[0].title,'=1+1');
});

test('empty context, feature stop and metadata avoid private payloads',()=>{
  const h=fixture(); assert.equal(ok(h.lesson('lessonContext',{studentId:'test-inactive',slotId:''})).context.slot,null);
  const r=ok(save(h)); assert.equal(ok(h.lesson('lessonContext',{slotId:''})).context.record.id,r.recordId);
  assert.deepEqual(clone(h.context().lessonMetadata_('test-a','slot-a')),{lessonRecordStatus:'active',lessonDraftStatus:'none'});
  h.context().setConfig_('lessonCycleEnabled','off'); bad(h.contextFor(),'disabled'); bad(save(h),'disabled');
});

test('HTTP teacher dispatch preserves isolation and public/MCP outputs exclude private records',()=>{
  const h=fixture(); ok(h.admin('lessonContext',{studentId:'test-a',slotId:'slot-a'}));
  const before=snapshot(h), req={studentId:'test-a',slotId:'slot-a',expectedRevision:0,requestId:'http-save',record:record()};
  const r=ok(h.admin('lessonRecordSave',req)); assert.deepEqual(snapshot(h),before);
  ok(h.admin('lessonHomeworkApply',{studentId:'test-a',recordId:r.recordId,expectedRevision:1,requestId:'http-apply'}));
  const task=h.rows('tasks')[0];
  const issue=ok(h.admin('parentIssueSetupCode',{studentId:'test-a'}));
  const parent=ok(h.parent('parentSetup',{setupCode:issue.setupCode,pass:'TestParentPassword!'}));
  const output=[h.get({action:'state',k:'synthetic-link-a'}),ok(h.parent('parentData',{ptoken:parent.ptoken})),ok(h.admin('kanriStudent',{studentId:'test-a'}))];
  for (const op of ['mcpStudents','mcpStudent','mcpPending','mcpBilling','mcpSchedule']) output.push(ok(h.request({action:'admin',op,studentId:'test-a',mcpKey:MCP_KEY})));
  const json=JSON.stringify(output); assert.equal(json.includes('PRIVATE_SENTINEL'),false); assert.equal(json.includes('一次関数のグラフ'),false); assert.equal(json.includes('sourceRecordId'),false);
  assert.equal(h.request({action:'admin',op:'lessonContext',studentId:'test-a',slotId:'slot-a',mcpKey:MCP_KEY}).ok,undefined);
  assert.equal(h.request({action:'admin',op:'lessonContext',studentId:'test-a',slotId:'slot-a',token:parent.ptoken}).badAuth,true);
  assert.ok(h.admin('taskDel',{studentId:'test-b',taskId:task.id}).error);
  ok(h.admin('taskDel',{studentId:'test-a',taskId:task.id}));
  assert.equal(h.rows('tasks').length,1); assert.ok(h.rows('tasks')[0].withdrawnAt);
  assert.equal(h.get({action:'state',k:'synthetic-link-a'}).tasks.length,0);
  const mcp=ok(h.request({action:'admin',op:'mcpStudent',studentId:'test-a',mcpKey:MCP_KEY})); assert.equal(JSON.stringify(mcp).includes(task.title),false);
  assert.ok(h.request({action:'taskDone',k:'synthetic-link-a',taskId:task.id,done:true}).error); assert.equal(h.rows('tasks')[0].doneAt,'');
  assert.equal(JSON.stringify(h.rows('log')).includes('PRIVATE_SENTINEL'),false); assert.equal(JSON.stringify(h.rows('mcpLog')).includes('PRIVATE_SENTINEL'),false);
});

test('HTTP lock timeout has a retryable response and successful or invalid operations release once',()=>{
  const h=fixture(), c=h.context(); let acquired=0,released=0;
  c.LockService.getScriptLock=()=>({waitLock(){throw new Error('synthetic timeout');},releaseLock(){released++;}});
  const request={action:'admin',token:TEACHER_TOKEN,op:'lessonRecordSave',studentId:'test-a',slotId:'slot-a',expectedRevision:0,requestId:'locked-save',record:record()};
  const res=JSON.parse(c.doPost({postData:{contents:JSON.stringify(request)}}).getContent()); bad(res,'pending'); assert.equal(released,0);assert.equal(h.rows('lessonRecords').length,0);
  c.LockService.getScriptLock=()=>({waitLock(){acquired++;},releaseLock(){released++;}});
  ok(JSON.parse(c.doPost({postData:{contents:JSON.stringify(request)}}).getContent()));
  bad(JSON.parse(c.doPost({postData:{contents:JSON.stringify({...request,requestId:'bad-input',record:{content:''}})}}).getContent()),'validation');
  assert.equal(acquired,2);assert.equal(released,2);
});
