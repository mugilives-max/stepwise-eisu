/** Temporary editor-only verification against newly created test spreadsheets.
 * Load with Code.gs and LessonCycle.gs, then run stepwiseNativeLessonCheck().
 * Do not deploy this helper. No existing IDs, teacher passwords, shared schema
 * cache or Script Properties are read. Test books are retained for inspection.
 * Calls handlers directly; only this execution can access these fresh fixtures.
 */
function stepwiseNativeLessonCheck() {
  var app=null, ledger=null, stage='create_test_books', started=Date.now(), checks={};
  var original={memo:MEMO_,ss:ss_,ledger:ledger_,put:lessonPut_,schemaBook:LESSON_SCHEMA_BOOK_,notify:notify_,mail:mailStudent_,offerMail:offerMailToStudent_,createCalendar:createCalEvent_,deleteCalendar:deleteCalEvent_,meet:addMeet_};
  var token='native-lesson-fixture-token', studentId='native-lesson-student', effectCalls=0;
  function check(value,name) { checks[name]=!!value; if (!value) { var err=new Error(name); err.checkCode=name; throw err; } }
  function forbidden() { effectCalls++; throw new Error('unexpected_side_effect'); }
  function call(op,args) {
    var req={action:'admin',token:token,studentId:studentId,op:op};
    Object.keys(args || {}).forEach(function (k) { req[k]=args[k]; });
    return lessonAdmin_(req);
  }
  function books() { return {app:app ? {id:app.getId(),url:app.getUrl()} : null,ledger:ledger ? {id:ledger.getId(),url:ledger.getUrl()} : null}; }
  function unchanged() { return JSON.stringify(['config','students','slots','plans'].map(function (n) { return app.getSheetByName(n).getDataRange().getValues(); }).concat([ledger.getSheetByName('入金管理').getDataRange().getValues()])); }
  try {
    var stamp=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd-HHmmss');
    app=SpreadsheetApp.create('【テスト】授業サイクル検証 予約 '+stamp);
    ledger=SpreadsheetApp.create('【テスト】授業サイクル検証 台帳 '+stamp);
    MEMO_={ss:app,ledger:ledger,rows:{},lrows:{}}; ss_=function () { return app; }; ledger_=function () { return ledger; };
    notify_=forbidden; mailStudent_=forbidden; offerMailToStudent_=forbidden; createCalEvent_=forbidden; deleteCalEvent_=forbidden; addMeet_=forbidden;
    stage='initialize_fixture';
    ensureSheet_(app,'config',['key','value']);
    ensureSheet_(app,'students',['id','name','active','email','code','rate30','monthly','parentToken','parentExp']);
    ensureSheet_(app,'slots',['id','date','start','min','status','studentId','done','eventId','meetUrl','subject','req']);
    ensureSheet_(app,'plans',['id','studentId','ym','subject','count','status','proposedAt','approvedAt','approvedVia','memo']);
    ensureSheet_(ledger,'入金管理',LEDGER_COLS['入金管理']);
    app.getSheetByName('students').appendRow([studentId,'【テスト】授業サイクル検証',true,'','native-lesson-link',1500,'','','']);
    app.getSheetByName('slots').appendRow(['native-lesson-slot','2026-09-08','13:00',60,'booked',studentId,false,'unchanged-event','','英語','']);
    setConfig_('passHash','native-placeholder-not-real-hash'); setConfig_('adminToken',token); setConfig_('adminTokenExp',String(Date.now()+3600000)); setConfig_('lessonCycleEnabled','on');
    ensureLessonSchema_();
    var baseline=unchanged();
    var req={slotId:'native-lesson-slot',expectedRevision:0,requestId:'native-save-1',record:{content:'=1+1\n<script>文字列</script>',progress:'基礎を確認',nextFocus:'次回の基本問題',teacherNote:"'NATIVE_PRIVATE_SENTINEL",homework:[{itemId:'native-item-1',title:'=1+1',due:'2026-09-10',type:'宿題'},{itemId:'native-item-2',title:'問題2',due:'',type:'宿題'}]}};
    stage='save_and_replay';
    var first=call('lessonRecordSave',req); check(first.ok,'initial_save');
    check(first.context.record.content===req.record.content && first.context.record.teacherNote===req.record.teacherNote,'literal_round_trip');
    check(!app.getSheetByName('lessonRecords').getDataRange().getFormulas().some(function (row) { return row.some(Boolean); }),'no_record_formulas');
    check(!app.getSheetByName('lessonPrivateNotes').getDataRange().getFormulas().some(function (row) { return row.some(Boolean); }),'no_private_formulas');
    check(first.context.draftTemplate.indexOf('NATIVE_PRIVATE_SENTINEL')<0,'draft_excludes_private_note');
    check(call('lessonRecordSave',req).recordId===first.recordId && lessonRows_('lessonRecords').length===1,'save_retry_does_not_duplicate');
    check(lessonRows_('tasks').length===0,'save_does_not_publish_homework');
    check(call('lessonContext',{slotId:'native-lesson-slot',token:'invalid-test-token'}).badAuth,'unauthorized_context_rejected');
    stage='partial_homework_and_resume';
    var failOnce=true;
    lessonPut_=function (name,key,id,row) { if (name==='tasks' && row.sourceItemId==='native-item-2' && failOnce) { failOnce=false; throw new Error('intentional_test_write_failure'); } return original.put(name,key,id,row); };
    var applyReq={recordId:first.recordId,expectedRevision:1,requestId:'native-apply-1'};
    check(call('lessonHomeworkApply',applyReq).errorCode==='pending','partial_apply_reported');
    check(lessonRows_('tasks').length===1,'first_homework_only');
    var during=call('lessonContext',{slotId:'native-lesson-slot'}); check(during.ok && during.context.pending && during.context.record===null,'pending_hides_mixed_record');
    lessonPut_=original.put;
    app.getSheetByName('tasks').getRange(2,8).setValue('native-completed'); memoClear_();
    var resumed=call('lessonWriteResume',{requestId:'native-apply-1'}); check(resumed.ok && !resumed.context.pending,'pending_resumed');
    check(lessonRows_('tasks').length===2 && lessonRows_('tasks')[0].doneAt==='native-completed','completion_preserved');
    check(!app.getSheetByName('tasks').getDataRange().getFormulas().some(function (row) { return row.some(Boolean); }),'no_task_formulas');
    check(call('lessonHomeworkApply',applyReq).ok && lessonRows_('tasks').length===2,'apply_retry_does_not_duplicate');
    stage='draft_and_withdraw';
    var drafted=call('lessonReportDraftSave',{recordId:first.recordId,expectedDraftRevision:0,sourceRevision:1,requestId:'native-draft-1',body:'未公開の下書き'});
    check(drafted.ok && drafted.context.draft.revision===1,'draft_saved');
    check(call('lessonHomeworkWithdraw',{recordId:first.recordId,itemId:'native-item-1',expectedRevision:1,requestId:'native-withdraw-1'}).ok,'withdraw_saved');
    check(!!lessonRows_('tasks')[0].withdrawnAt && lessonRows_('tasks')[0].doneAt==='native-completed','withdraw_keeps_completion');
    check(unchanged()===baseline,'booking_billing_config_unchanged'); check(effectCalls===0,'no_mail_calendar_calls');
    var result={ok:true,elapsedMS:Date.now()-started,checks:checks,testSpreadsheets:books()}; Logger.log(JSON.stringify(result)); return result;
  } catch (err) {
    var failed={ok:false,error:{stage:stage,code:err.checkCode || 'unexpected_error',type:String(err.name || 'Error')},testSpreadsheets:books()}; Logger.log(JSON.stringify(failed)); return failed;
  } finally {
    MEMO_=original.memo; ss_=original.ss; ledger_=original.ledger; lessonPut_=original.put; LESSON_SCHEMA_BOOK_=original.schemaBook;
    notify_=original.notify; mailStudent_=original.mail; offerMailToStudent_=original.offerMail; createCalEvent_=original.createCalendar; deleteCalEvent_=original.deleteCalendar; addMeet_=original.meet;
  }
}
