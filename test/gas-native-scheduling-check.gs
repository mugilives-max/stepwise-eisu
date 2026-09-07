/** Temporary editor-only check. Run stepwiseNativeSchedulingCheck() with the
 * production source files; remove this helper before deployment. It creates two
 * NEW books, calls actual admin_/accept_ paths, and never opens a business ID,
 * reads Script Properties, runs setup(), or sends Mail/Calendar requests.
 * Legacy past deliveryMode remains unknown; migration is a separate root task. */
function stepwiseNativeSchedulingCheck() {
  var app=null,ledger=null,stage='create_books',started=Date.now(),checks={},effects=0;
  var original={memo:MEMO_,ss:ss_,ledger:ledger_,lite:LITE_,write:writeSlotRow_,notify:notify_,mail:mailStudent_,offerMail:offerMailToStudent_,
    calendar:schedulingCalendarFor_,notice:schedulingAcceptNotice_,paymentCols:LEDGER_COLS['入金管理']};
  var ids=['native-schedule-a','native-schedule-b','native-schedule-c'],code='native-scheduling-link',token='native-scheduling-teacher-token';
  function check(ok,name){checks[name]=!!ok;if(!ok){var e=new Error(name);e.nativeCheck=name;throw e;}}
  function forbidden(){effects++;throw new Error('forbidden_external_effect');}
  function refresh(){memoClear_();}
  function call(op,args){refresh();var req={action:'admin',token:token,op:op,studentId:ids[0]};Object.keys(args||{}).forEach(function(k){req[k]=args[k];});return admin_(req);}
  function batch(slotIds,key){refresh();return schedulingAcceptMany_({k:code,slotIds:slotIds,requestId:key});}
  function slot(patch){var s={id:billingId_(),date:ym+'-15',start:'13:00',min:60,status:'offered',studentId:ids[0],done:'',eventId:'',meetUrl:'',subject:'数学',req:'',deliveryMode:'in_person'};
    Object.keys(patch||{}).forEach(function(k){s[k]=patch[k];});
    var sh=sheet_('slots');sh.getRange(sh.getLastRow()+1,1,1,12).setNumberFormat('@').setValues([[s.id,s.date,s.start,s.min,s.status,s.studentId,s.done,s.eventId,s.meetUrl,s.subject,s.req,s.deliveryMode]]);return s;}
  function books(){return {app:app?{id:app.getId(),url:app.getUrl()}:null,ledger:ledger?{id:ledger.getId(),url:ledger.getUrl()}:null};}
  function emptySlots(){var sh=sheet_('slots');while(sh.getLastRow()>1)sh.deleteRow(sh.getLastRow());}
  try {
    var stamp=Utilities.formatDate(new Date(),TZ,'yyyyMMdd-HHmmss');
    app=SpreadsheetApp.create('【テスト】授業形式・一括確定 予約 '+stamp);ledger=SpreadsheetApp.create('【テスト】授業形式・一括確定 台帳 '+stamp);
    MEMO_={ss:app,ledger:ledger,rows:{},lrows:{}};ss_=function(){return app;};ledger_=function(){return ledger;};
    notify_=forbidden;mailStudent_=forbidden;schedulingAcceptNotice_=forbidden;
    schedulingCalendarFor_=function(write,s,student){check(isTestStudent_(student),'calendar_test_student_guard');return original.calendar(write,s,student);};
    offerMailToStudent_=function(student,dates,start,min,subject){check(isTestStudent_(student),'offer_test_student_guard');return original.offerMail(student,dates,start,min,subject);};
    check(ss_().getId()===app.getId()&&ledger_().getId()===ledger.getId(),'new_books_only');
    var schema={config:['key','value'],students:['id','name','active','email','code','rate30','monthly','parentToken','parentExp'],
      slots:['id','date','start','min','status','studentId','done','eventId','meetUrl','subject','req'],
      plans:['id','studentId','ym','subject','count','status','proposedAt','approvedAt','approvedVia','memo'],
      blocked:['id','studentId','date','note','start','end'],log:['time','message'],parents:PARENT_AUTH_COLUMNS_.slice()};
    Object.keys(schema).forEach(function(name){ensureSheet_(app,name,schema[name]);});
    var ym=todayStr_().slice(0,7),pastYm=addDays_(ym+'-01',-1).slice(0,7);
    app.getSheetByName('students').getRange(2,1,3,9).setNumberFormat('@').setValues(ids.map(function(id,i){return [id,'【テスト】授業形式'+(i+1),true,'',i===0?code:'native-link-'+i,1500,'','',''];}));
    var legacy=[billingId_(),pastYm+'-01','10:00',60,'booked',ids[0],true,'','','数学',''];
    app.getSheetByName('slots').getRange(2,1,1,11).setValues([legacy]);
    // Sheets may interpret dates/times at fixture creation. Compare the actual
    // stored cells before/after schema change, not their input JS representation.
    var legacyBeforeSchema=JSON.stringify(app.getSheetByName('slots').getRange(2,1,1,11).getValues()[0]);
    var config={passHash:'native-placeholder-hash',passSalt:'native-placeholder-salt',adminToken:token,adminTokenExp:String(Date.now()+3600000),calendarSync:'on',emailNotify:'on',teacherEmail:''};
    Object.keys(config).forEach(function(k){setConfig_(k,config[k]);});
    ensureSchedulingSchema_();ensureBillingSchema_();ensureLessonSchema_();refresh();
    check(JSON.stringify(app.getSheetByName('slots').getRange(2,1,1,11).getValues()[0])===legacyBeforeSchema,'legacy_past_values_preserved');
    check(readRows_('slots')[0].deliveryMode===''&&readRows_('students')[0].deliveryMode==='','unknown_legacy_mode_not_guessed');
    check(app.getSheetByName('slots').getLastColumn()===12&&app.getSheetByName('students').getLastColumn()===10,'mode_schema_added');
    check(call('setDeliveryMode',{deliveryMode:'online',token:'invalid-test-token'}).badAuth,'teacher_auth_required');
    check(call('setDeliveryMode',{deliveryMode:'online'}).ok,'student_default_saved');refresh();
    check(readRows_('slots')[0].deliveryMode==='','default_does_not_rewrite_legacy_slot');
    check(call('setDeliveryMode',{deliveryMode:'in_person'}).ok,'student_default_restored');
    check(call('offer',{date:ym+'-20',start:'17:00',min:60,subject:'数学'}).ok,'offer_uses_default');refresh();
    check(readRows_('slots')[1].deliveryMode==='in_person','offer_mode_persisted');
    emptySlots();

    stage='capacity_boundaries';
    var offer={date:ym+'-15',start:'13:00',min:60,subject:'数学'};
    slot({studentId:ids[1]});check(call('offer',offer).ok,'second_in_person_allowed');
    var before=JSON.stringify(readRows_('slots'));
    check(!!call('offer',Object.assign({},offer,{studentId:ids[2],force:true})).error,'third_in_person_rejected_even_force');refresh();
    check(JSON.stringify(readRows_('slots'))===before,'failed_offer_no_write');
    emptySlots();slot({studentId:ids[1],deliveryMode:'online',start:'12:30'});
    check(!!call('offer',offer).error,'partial_online_overlap_rejected');
    check(call('offer',Object.assign({},offer,{start:'13:30'})).ok,'end_equals_start_allowed');
    emptySlots();slot({studentId:ids[1],min:30});slot({studentId:ids[2],start:'13:30',min:30});
    check(call('offer',offer).ok,'consecutive_others_not_overcounted');
    emptySlots();slot({studentId:ids[1],deliveryMode:''});
    check(call('offer',offer).errorCode==='deliveryModeRequired','unknown_overlapping_mode_fails_closed');
    emptySlots();slot({studentId:ids[1],date:addDays_(ym+'-15',7),deliveryMode:'online'});
    before=JSON.stringify(readRows_('slots'));
    check(!!call('offer',Object.assign({},offer,{repeat:3,force:true})).error,'repeat_preflight_checks_later_week');refresh();
    check(JSON.stringify(readRows_('slots'))===before,'repeat_failure_adds_nothing');
    emptySlots();

    stage='approval_and_batch';
    // acceptMany sorts IDs before writing. Stable a < b IDs ensure the injected
    // second-slot failure occurs after exactly one durable booking.
    var a=slot({id:'native-schedule-batch-a',date:ym+'-10'}),b=slot({id:'native-schedule-batch-b',date:ym+'-11'});
    refresh();check(accept_(a.id,code).errorCode==='approvalRequired','single_accept_preserves_approval_gate');
    check(call('planSet',{ym:ym,subject:'数学',count:12}).ok&&call('planPropose',{ym:ym,rate30:1500,monthly:0}).ok,'synthetic_plan_prepared');
    var rev=call('billingPreview',{ym:ym}).billing.revision;
    check(call('planApproveTeacher',{ym:ym,expectedRevision:rev,via:'電話',consentDate:todayStr_(),memo:'架空の検証用承諾'}).ok,'synthetic_plan_approved');
    check(!!batch([a.id,'missing-native-slot'],'native-invalid-selection').error,'invalid_selection_rejected');refresh();
    check(readRows_('acceptWrites').length===0&&readRows_('slots').every(function(s){return s.status==='offered';}),'invalid_selection_no_writes');
    var failOnce=true;writeSlotRow_=function(r){if(String(r.slot.id)===String(b.id)&&failOnce){failOnce=false;throw new Error('intentional_native_slot_failure');}return original.write(r);};
    var partial=batch([a.id,b.id],'native-batch-retry');
    check(partial.pending&&partial.completed===1,'partial_batch_reported');refresh();
    check(readRows_('slots').filter(function(s){return s.status==='booked';}).length===1,'first_booking_durable');
    var restored=studentState_(code).pendingAccepts;
    check(restored.length===1&&restored[0].requestId==='native-batch-retry'&&JSON.stringify(restored[0].slotIds)===JSON.stringify([a.id,b.id]),'pending_request_restored_in_student_state');
    check(schedulingPendingForStudent_(ids[1]).length===0,'pending_request_hidden_from_other_student');
    check(restored[0].slots.every(function(s){return Object.keys(s).sort().join('|')==='date|deliveryMode|id|min|start|subject';}),'pending_projection_excludes_journal_internals');
    check(!!batch([b.id],'native-other-request').error,'other_request_cannot_take_pending_slot');
    check(call('deleteSlot',{slotId:b.id}).errorCode==='pending','pending_slot_mutation_blocked');
    writeSlotRow_=original.write;
    var resumed=batch([b.id,a.id],'native-batch-retry');
    check(resumed.ok&&resumed.completed===2&&!resumed.pending,'batch_retry_completes');
    check(resumed.notification==='skipped','test_notification_skipped');refresh();
    var completedBefore=JSON.stringify(readRows_('acceptWrites'));
    check(batch([a.id,b.id],'native-batch-retry').ok,'batch_replay_success');refresh();
    check(readRows_('acceptWrites').length===1&&JSON.stringify(readRows_('acceptWrites'))===completedBefore,'batch_replay_no_duplicate_journal');
    check(readRows_('slots').filter(function(s){return s.status==='booked';}).length===2,'batch_no_duplicate_booking');
    check(call('setSlotDeliveryMode',{slotId:a.id,expectedMode:'in_person',deliveryMode:'online'}).ok,'lesson_override_saved');refresh();
    check(readRows_('students')[0].deliveryMode==='in_person','lesson_override_keeps_student_default');
    check(call('setSlotDeliveryMode',{slotId:a.id,expectedMode:'in_person',deliveryMode:'online'}).errorCode==='conflict','stale_mode_change_rejected');
    check(!app.getSheetByName('acceptWrites').getDataRange().getFormulas().some(function(row){return row.some(Boolean); }),'journal_has_no_formulas');
    check(readRows_('slots').every(function(s){return !s.eventId&&!s.meetUrl;})&&effects===0,'no_real_mail_calendar_effects');
    var result={ok:true,elapsedMS:Date.now()-started,checks:checks,testSpreadsheets:books()};Logger.log(JSON.stringify(result));return result;
  } catch(err) {
    var failed={ok:false,error:{stage:stage,code:err.nativeCheck||'unexpected_error',type:String(err.name||'Error')},checks:checks,testSpreadsheets:books()};Logger.log(JSON.stringify(failed));return failed;
  } finally {
    MEMO_=original.memo;ss_=original.ss;ledger_=original.ledger;LITE_=original.lite;writeSlotRow_=original.write;notify_=original.notify;mailStudent_=original.mail;
    offerMailToStudent_=original.offerMail;schedulingCalendarFor_=original.calendar;schedulingAcceptNotice_=original.notice;LEDGER_COLS['入金管理']=original.paymentCols;
  }
}
