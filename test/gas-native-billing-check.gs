/** Temporary editor-only verification using two newly created test spreadsheets.
 * Load with Code.gs, BillingApproval.gs and LessonCycle.gs, then run
 * stepwiseNativeBillingCheck(). Do not deploy this helper.
 * It calls real admin_/accept_ handlers against fresh books only. It never calls
 * setup(), ensureSchema_() or doPost(), and never reads Script Properties or the
 * shared schema cache. Test books are retained; output contains checks/timings
 * and their URLs, never credentials or business rows.
 */
function stepwiseNativeBillingCheck() {
  var app=null, ledger=null, stage='create_test_books', started=Date.now(), checks={}, timings=[];
  var original={memo:MEMO_,ss:ss_,ledger:ledger_,lite:LITE_,audit:billingAudit_,agreementWrite:billingWriteAgreement_,paymentCols:LEDGER_COLS['入金管理'],
    notify:notify_,mail:mailStudent_,offerMail:offerMailToStudent_,createCalendar:createCalEvent_,deleteCalendar:deleteCalEvent_,meet:addMeet_};
  var studentId='native-billing-student', studentCode='native-billing-link', token='native-billing-fixture-token';
  var forbiddenCalls=0;
  function check(condition,name) {
    checks[name]=!!condition;
    if(!condition){var err=new Error(name);err.nativeBillingCode=name;throw err;}
  }
  function forbidden(){forbiddenCalls++;throw new Error('unexpected_side_effect');}
  function refresh(){memoClear_();}
  function call(op,args){
    refresh();
    var req={action:'admin',token:token,studentId:studentId,op:op};
    Object.keys(args||{}).forEach(function(k){req[k]=args[k];});
    var begin=Date.now(),res=admin_(req);
    timings.push({operation:op,elapsedMS:Date.now()-begin});
    return res;
  }
  function accept(id){refresh();return accept_(id,studentCode);}
  function payments(){refresh();return billingInvoiceRows_(studentId);}
  function books(){return {app:app?{id:app.getId(),url:app.getUrl()}:null,ledger:ledger?{id:ledger.getId(),url:ledger.getUrl()}:null};}
  function noFormulas(book,name){return !book.getSheetByName(name).getDataRange().getFormulas().some(function(row){return row.some(Boolean);});}
  try {
    // The first spreadsheet operations create new books; no existing ID is used.
    var stamp=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd-HHmmss');
    app=SpreadsheetApp.create('【テスト】月間承認・請求検証 予約 '+stamp);
    ledger=SpreadsheetApp.create('【テスト】月間承認・請求検証 台帳 '+stamp);
    MEMO_={ss:app,ledger:ledger,rows:{},lrows:{}};
    ss_=function(){return app;};ledger_=function(){return ledger;};
    notify_=forbidden;mailStudent_=forbidden;addMeet_=forbidden;
    createCalEvent_=function(slot,student){
      check(isTestStudent_(student)&&String(student.id)===studentId,'calendar_test_student_guard');
      return original.createCalendar(slot,student); // Real early return for test students.
    };
    deleteCalEvent_=function(slot){if(slot.eventId)forbidden();return original.deleteCalendar(slot);};
    offerMailToStudent_=function(student,dates,start,min,subject){
      if(!isTestStudent_(student)||String(student.id)!==studentId)forbidden();
      return original.offerMail(student,dates,start,min,subject);
    };
    check(ss_().getId()===app.getId()&&ledger_().getId()===ledger.getId(),'new_books_only');

    stage='initialize_fixture_and_legacy_schema';
    var schema={
      config:['key','value'],
      students:['id','name','active','email','code','rate30','monthly','parentToken','parentExp'],
      slots:['id','date','start','min','status','studentId','done','eventId','meetUrl','subject','req'],
      plans:['id','studentId','ym','subject','count','status','proposedAt','approvedAt','approvedVia','memo'],
      parents:PARENT_AUTH_COLUMNS_.slice(),log:['time','message']
    };
    Object.keys(schema).forEach(function(name){ensureSheet_(app,name,schema[name]);});
    app.getSheetByName('students').getRange(2,1,1,9).setNumberFormat('@').setValues([
      [studentId,'【テスト】月間承認・請求検証',true,'',studentCode,1500,'','','']
    ]);
    var config={passHash:'native-placeholder-not-real-hash',passSalt:'native-placeholder-salt',adminToken:token,
      adminTokenExp:String(Date.now()+3600000),calendarSync:'off',emailNotify:'off',teacherEmail:''};
    Object.keys(config).forEach(function(k){setConfig_(k,config[k]);});
    var today=todayStr_(),ym=addDays_(today.slice(0,7)+'-01',-1).slice(0,7);
    var oldCols=['年月','生徒ID','氏名','請求額','請求日','入金日','入金方法','状態','備考'];
    var oldRow=[ym,'native-legacy-billing-student','【テスト】旧請求',1234,ym+'-03','','','未入金','架空の旧9列請求'];
    ensureSheet_(ledger,'入金管理',oldCols).getRange(2,1,1,9).setNumberFormat('@').setValues([oldRow]);
    ensureBillingSchema_();refresh();
    check(JSON.stringify(ledger.getSheetByName('入金管理').getRange(2,1,1,9).getValues()[0])===JSON.stringify(oldRow),'legacy_values_preserved');
    check(ledger.getSheetByName('入金管理').getLastColumn()===21&&!!ledger.getSheetByName('入金管理').getRange(2,10).getValue(),'legacy_header_and_id_migrated');
    var configBefore=JSON.stringify(app.getSheetByName('config').getDataRange().getValues());
    ['01','02','03'].forEach(function(day,i){
      app.getSheetByName('slots').getRange(i+2,1,1,11).setNumberFormat('@').setValues([
        ['native-billing-slot-'+(i+1),ym+'-'+day,'13:00',60,'offered',studentId,false,'','','数学','']
      ]);
    });
    refresh();
    check(call('billingPreview',{ym:ym,token:'invalid-native-fixture-token'}).badAuth,'teacher_authorization_required');
    check(!!accept('native-billing-slot-1').error,'unapproved_accept_rejected');

    stage='interrupted_plan_retry';
    // This older month has no slots/invoices and is separate from that fixture. The real
    // Sheets plan row commits before the injected agreement/audit failure.
    var retryYm=addDays_(ym+'-01',-1).slice(0,7);
    check(call('planSet',{ym:retryYm,subject:'数学',count:1}).ok &&
      call('planPropose',{ym:retryYm,rate30:1500,monthly:0}).ok,'retry_plan_fixture_prepared');
    refresh();
    var retryBefore=billingAgreement_(studentId,retryYm),retryRev=Number(retryBefore.revision),retryInterrupted=false;
    billingWriteAgreement_=function(a){
      if(String(a.ym)===retryYm && a.status==='draft' && a.planJson==='[{"subject":"数学","count":3}]')throw new Error('intentional_native_snapshot_failure');
      return original.agreementWrite(a);
    };
    try{call('planSet',{ym:retryYm,subject:'数学',count:3,expectedRevision:retryRev});}catch(err){retryInterrupted=true;}
    billingWriteAgreement_=original.agreementWrite;refresh();
    var interruptedDraft=billingAgreement_(studentId,retryYm);
    check(retryInterrupted && interruptedDraft.status==='draft' && !interruptedDraft.proposedAt &&
      Number(interruptedDraft.revision)===retryRev+1 && billingPlanList_(studentId,retryYm)[0].count===3,'changed_plan_survives_snapshot_failure');
    check(!!call('planSet',{ym:retryYm,subject:'数学',count:3,expectedRevision:retryRev}).error,'plan_repair_rejects_old_revision');
    var retryCurrent=Number(interruptedDraft.revision);
    check(call('planSet',{ym:retryYm,subject:'数学',count:3,expectedRevision:retryCurrent}).ok,'changed_plan_same_count_repaired');
    refresh();
    var repairedDraft=billingAgreement_(studentId,retryYm),repairedJson=JSON.stringify(repairedDraft),retryAuditId=repairedDraft.id+':'+retryCurrent+':changed';
    check(Number(repairedDraft.revision)===retryCurrent && Number(repairedDraft.rate30)===1500 && Number(repairedDraft.monthly)===0 &&
      repairedDraft.planJson==='[{"subject":"数学","count":3}]' && readRows_('approvalEvents').filter(function(e){return String(e.id)===retryAuditId;}).length===1,'plan_snapshot_terms_revision_and_single_audit_preserved');
    var retryEventsJson=JSON.stringify(readRows_('approvalEvents'));
    var retryReplay=call('planSet',{ym:retryYm,subject:'数学',count:3,expectedRevision:retryCurrent});refresh();
    check(retryReplay.ok && JSON.stringify(billingAgreement_(studentId,retryYm))===repairedJson &&
      JSON.stringify(readRows_('approvalEvents'))===retryEventsJson,'completed_plan_retry_does_not_rewrite');
    billingAudit_=function(a,event,id,extra){
      if(String(a.ym)===retryYm && event==='planChanged')throw new Error('intentional_native_plan_audit_failure');
      return original.audit(a,event,id,extra);
    };
    retryInterrupted=false;
    try{call('planSet',{ym:retryYm,subject:'数学',count:0,expectedRevision:retryCurrent});}catch(err){retryInterrupted=true;}
    billingAudit_=original.audit;refresh();
    var deletedDraft=billingAgreement_(studentId,retryYm),deletedRev=Number(deletedDraft.revision);
    var deletedMonth=billingMonths_(studentId).filter(function(m){return m.ym===retryYm;})[0];
    check(retryInterrupted && billingPlanList_(studentId,retryYm).length===0 && deletedDraft.planJson==='[]' && deletedRev===retryCurrent+1 &&
      !!deletedMonth && typeof deletedMonth.revision==='number' && deletedMonth.revision===deletedRev,'deleted_plan_survives_audit_failure');
    var deletionReplay=call('planSet',{ym:retryYm,subject:'数学',count:0,expectedRevision:deletedMonth.revision});refresh();
    check(deletionReplay.ok && Number(billingAgreement_(studentId,retryYm).revision)===deletedRev &&
      readRows_('approvalEvents').filter(function(e){return String(e.id)===deletedDraft.id+':'+deletedRev+':changed';}).length===1,'deleted_plan_same_count_repairs_one_audit');

    stage='proposal_and_consent';
    check(call('planSet',{ym:ym,subject:'数学',count:2}).ok,'plan_saved');
    check(!!call('planPropose',{ym:ym}).error,'past_fees_must_be_explicit');
    var proposed=call('planPropose',{ym:ym,rate30:1500,monthly:0});
    check(proposed.ok&&proposed.revision>0,'proposal_revision_created');
    check(!!call('planApproveTeacher',{ym:ym,expectedRevision:proposed.revision-1,via:'電話',consentDate:today,memo:'架空の承諾記録'}).error,'stale_revision_rejected');
    check(call('planApproveTeacher',{ym:ym,expectedRevision:proposed.revision,via:'=1+1',consentDate:today,memo:'=1+1'}).ok,'consent_saved');
    check(noFormulas(app,'plans')&&noFormulas(app,'monthAgreements')&&noFormulas(app,'approvalEvents'),'consent_text_not_formula');
    check(call('billingPreview',{ym:ym}).billing.planStatus==='approved','approval_visible');

    stage='quota_and_completion';
    check(accept('native-billing-slot-1').ok,'first_slot_accepted');
    check(accept('native-billing-slot-2').ok,'second_slot_accepted');
    check(!!accept('native-billing-slot-3').error,'quota_excess_rejected');
    check(call('toggleDone',{slotId:'native-billing-slot-1',done:true}).ok,'first_lesson_completed');
    check(call('billingPreview',{ym:ym}).billing.canBill===false,'unfinished_booking_blocks_invoice');
    check(call('toggleDone',{slotId:'native-billing-slot-2',done:true}).ok,'second_lesson_completed');
    var preview=call('billingPreview',{ym:ym}).billing;
    check(preview.canBill&&preview.amount===6000&&preview.minutes===120&&preview.count===2,'server_billing_total');

    stage='durable_invoice_retry_and_audit';
    var invoiceReq={ym:ym,requestId:'native-billing-invoice-request'},failOnce=true,interrupted=false;
    billingAudit_=function(a,event,id,extra){
      if(event==='invoiced'&&failOnce){failOnce=false;throw new Error('intentional_native_audit_failure');}
      return original.audit(a,event,id,extra);
    };
    try{call('kanriAddPayment',invoiceReq);}catch(err){interrupted=!failOnce;}
    billingAudit_=original.audit;
    check(interrupted&&payments().length===1,'invoice_survives_audit_failure');
    var savedId=payments()[0]['請求ID'];
    var replay=call('kanriAddPayment',invoiceReq);
    check(replay.ok&&replay.replayed&&replay.invoice.id===savedId&&payments().length===1,'invoice_retry_is_idempotent');
    refresh();
    check(readRows_('approvalEvents').filter(function(r){return r.event==='invoiced';}).length===1,'invoice_audit_repaired_once');
    check(call('kanriAddPayment',invoiceReq).ok&&payments().length===1,'second_retry_is_idempotent');
    var row=payments()[0];
    check(Number(row['請求額'])===6000&&Number(row['確定単価(30分)'])===1500&&JSON.parse(String(row['実績JSON'])).length===2,'invoice_snapshot_saved');
    check(!!call('kanriAddPayment',{ym:ym,requestId:'native-billing-duplicate-request'}).error,'second_invoice_rejected');

    stage='invoice_freeze';
    var slotsBefore=JSON.stringify(app.getSheetByName('slots').getDataRange().getValues());
    check(!!call('toggleDone',{slotId:'native-billing-slot-1',done:false}).error,'invoice_blocks_done_change');
    check(!!call('unbook',{slotId:'native-billing-slot-1'}).error,'invoice_blocks_unbooking');
    check(!!call('finishOffered',{slotId:'native-billing-slot-3'}).error,'invoice_blocks_completion_shortcut');
    check(!!call('planSet',{ym:ym,subject:'数学',count:3}).error,'invoice_blocks_plan_change');
    check(JSON.stringify(app.getSheetByName('slots').getDataRange().getValues())===slotsBefore,'frozen_slots_unchanged');
    check(call('setFee',{rate30:2500,monthly:0}).ok,'standard_fee_updated');
    check(call('billingPreview',{ym:ym}).billing.amount===6000,'invoice_amount_remains_fixed');

    stage='void_and_reissue';
    check(!!call('kanriVoidInvoice',{invoiceId:savedId}).error,'void_requires_reason');
    check(call('kanriVoidInvoice',{invoiceId:savedId,reason:'架空の請求訂正'}).ok,'unpaid_invoice_voided');
    var stale=call('kanriAddPayment',invoiceReq);
    check(stale.ok&&stale.invoice.id===savedId&&stale.invoice.status==='取消'&&payments().length===1,'old_request_cannot_reissue_void_invoice');
    var replacement=call('kanriAddPayment',{ym:ym,requestId:'native-billing-replacement-request'});
    check(replacement.ok&&replacement.invoice.id!==savedId&&payments().length===2,'new_request_reissues_preserving_history');
    check(payments().filter(function(p){return p['状態']!=='取消';}).length===1,'only_one_active_invoice');
    check(noFormulas(ledger,'入金管理'),'invoice_cells_not_formulas');
    check(JSON.stringify(app.getSheetByName('config').getDataRange().getValues())===configBefore,'fixture_credentials_unchanged');
    check(forbiddenCalls===0,'no_notification_or_calendar_side_effect');
    var result={ok:true,elapsedMS:Date.now()-started,checks:checks,timings:timings,testSpreadsheets:books()};
    Logger.log(JSON.stringify(result));return result;
  }catch(err){
    var failed={ok:false,error:{stage:stage,code:err.nativeBillingCode||'unexpected_error',type:String(err.name||'Error')},checks:checks,timings:timings,testSpreadsheets:books()};
    Logger.log(JSON.stringify(failed));return failed;
  }finally{
    MEMO_=original.memo;ss_=original.ss;ledger_=original.ledger;LITE_=original.lite;billingAudit_=original.audit;billingWriteAgreement_=original.agreementWrite;LEDGER_COLS['入金管理']=original.paymentCols;
    notify_=original.notify;mailStudent_=original.mail;offerMailToStudent_=original.offerMail;createCalEvent_=original.createCalendar;deleteCalEvent_=original.deleteCalendar;addMeet_=original.meet;
  }
}
