/** Temporary editor-only check for StudentEmail.gs. Creates one NEW test book.
 * Never runs setup/doPost/ensureSchema or reads existing books, Script Properties
 * or shared cache. No real email/Calendar call. Delete before publishing. */
function stepwiseNativeStudentEmailCheck(){
  var app=null,stage='create_book',checks={},mailbox=[],quota=100,failMail=false;
  var original={memo:MEMO_,ss:ss_,ledger:ledger_,test:studentEmailTest_,quota:studentEmailQuota_,deliver:studentEmailDeliverMail_,notify:notify_,mail:mailStudent_};
  function check(value,name){checks[name]=!!value;if(!value){var e=new Error(name);e.studentEmailNativeCheck=name;throw e;}}
  function refresh(){memoClear_();}
  function call(action,args){refresh();var req={action:action,k:'native-student-email-link'};Object.keys(args||{}).forEach(function(k){req[k]=args[k];});return studentEmailDispatch_(req);}
  function proof(){return decodeURIComponent(mailbox.filter(function(m){return m.body.indexOf('#student-email?verify=')>=0;}).slice(-1)[0].body.match(/\?verify=([^\s]+)/)[1]);}
  function notice(key){refresh();return studentEmailNotifyOffered_(findStudent_('native-student-email'),key,[{id:'native-student-email-slot',date:'2026-09-15',start:'15:00',min:30,subject:'数学',deliveryMode:'in_person'}]);}
  function box(key){refresh();return studentEmailRows_('studentEmailOutbox').filter(function(o){return o.eventKey===key;})[0];}
  function forbidden(){throw new Error('unexpected_external_side_effect');}
  try{
    app=SpreadsheetApp.create('【テスト】生徒メール検証 '+Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd-HHmmss'));
    MEMO_={ss:app,ledger:app,rows:{},lrows:{}};ss_=function(){return app;};ledger_=function(){return app;};notify_=forbidden;mailStudent_=forbidden;
    ensureSheet_(app,'students',['id','name','active','email','code','rate30','monthly','parentToken','parentExp','deliveryMode']);
    app.getSheetByName('students').getRange(2,1,2,10).setNumberFormat('@').setValues([
      ['native-student-email','【テスト】メール確認',true,'legacy@example.invalid','native-student-email-link',1500,0,'','','in_person'],
      ['native-student-email-other','【テスト】別の生徒',true,'','native-student-email-other-link',1500,0,'','','in_person']]);
    ensureSheet_(app,'parents',PARENT_AUTH_COLUMNS_);ensureSheet_(app,'config',['key','value']);ensureSheet_(app,'log',['time','message']);
    var teacherToken='native-student-email-teacher-only',config={passHash:'native-hash',passSalt:'native-salt',adminToken:teacherToken,adminTokenExp:String(Date.now()+3600000)};
    Object.keys(config).forEach(function(k){setConfig_(k,config[k]);});
    var oldParents=JSON.stringify(app.getSheetByName('parents').getDataRange().getValues()),oldConfig=JSON.stringify(app.getSheetByName('config').getDataRange().getValues()),oldOther=JSON.stringify(app.getSheetByName('students').getRange(3,1,1,10).getValues());
    studentEmailTest_=function(){return false;};studentEmailQuota_=function(){return quota;};
    studentEmailDeliverMail_=function(student,to,subject,body){check(isTestStudent_(student)&&String(student.id)==='native-student-email'&&/^=?native-student(?:-changed)?@example\.invalid$/.test(to),'fake_recipient_guard');mailbox.push({subject:subject,body:body});if(failMail)throw new Error('synthetic_unknown_send_outcome');return 'sent';};
    stage='schema_and_legacy';ensureStudentEmailSchema_();refresh();
    check(app.getSheetByName('studentEmails').getLastColumn()===STUDENT_EMAIL_COLS_.length&&app.getSheetByName('studentEmailOutbox').getLastColumn()===STUDENT_EMAIL_OUTBOX_COLS_.length,'exact_schema');
    check(studentEmailVerifiedAddress_('native-student-email')==='','legacy_unverified');check(systemStudent_('native-student-email').email==='legacy@example.invalid','legacy_value_preserved');
    check(notice('native-before-verification').status==='skipped'&&mailbox.length===0,'no_legacy_business_mail');
    stage='confirmation';
    check(!!call('studentEmailRequest',{email:'native-student@example.invalid',k:'wrong'}).badCode,'student_link_required');
    var request=call('studentEmailRequest',{email:'=native-student@example.invalid'});check(request.ok&&!request.emailStatus.verified&&request.mailStatus==='sent','verification_required');
    var first=proof();check(/^se1\./.test(first)&&mailbox[0].body.indexOf('native-student-email-link')<0,'separate_proof_no_student_link');
    check(!!call('studentEmailResend').error,'resend_cooldown');
    check(call('studentEmailVerify',{challenge:first,k:''}).ok,'confirmation_without_student_link');
    check(!!call('studentEmailVerify',{challenge:first,k:''}).error,'confirmation_one_use');
    refresh();check(studentEmailVerifiedAddress_('native-student-email')==='=native-student@example.invalid','verified_address_available');
    check(app.getSheetByName('students').getRange(2,4).getValue()==='=native-student@example.invalid'&&!app.getSheetByName('students').getRange(2,4).getFormula(),'email_formula_escaped');
    var persisted=JSON.stringify(['students','studentEmails','studentEmailOutbox','log'].map(function(n){return app.getSheetByName(n).getDataRange().getValues();}));
    check(persisted.indexOf(first)<0,'proof_not_persisted');
    stage='notifications';var before=mailbox.length;check(notice('native-idempotent').ok,'notification_saved');notice('native-idempotent');check(mailbox.length===before+1,'no_duplicate_delivery');
    check(mailbox[mailbox.length-1].body.indexOf('native-student-email-link')<0,'business_mail_no_private_link');
    quota=0;check(notice('native-quota').status==='failed','quota_not_sent');quota=100;
    refresh();var retry=studentEmailAdmin_({op:'studentEmailRetryNotification',token:teacherToken,studentId:'native-student-email',notificationId:box('native-quota').id});check(retry.ok&&box('native-quota').status==='sent','safe_retry');
    failMail=true;check(notice('native-uncertain').status==='uncertain','unknown_send_result');failMail=false;before=mailbox.length;notice('native-uncertain');check(mailbox.length===before,'unknown_never_resends');
    refresh();check(!!studentEmailAdmin_({op:'studentEmailRetryNotification',token:teacherToken,studentId:'native-student-email',notificationId:box('native-uncertain').id}).error,'unknown_manual_retry_denied');
    check(!/challengeHash|challengeLinkHash|snapshotJson/.test(JSON.stringify(retry)),'teacher_projection_no_secrets');
    stage='change_remove_and_revocation';
    var r=studentEmailRecord_('native-student-email');r.requestedAt=new Date(Date.now()-61000).toISOString();studentEmailSave_(r); // fixture clock only
    check(call('studentEmailRequest',{email:'native-student-changed@example.invalid'}).ok,'email_change_request');var changed=proof();refresh();
    check(studentEmailVerifiedAddress_('native-student-email')==='=native-student@example.invalid','old_address_until_confirmation');
    check(call('studentEmailVerify',{challenge:changed,k:''}).ok,'changed_address_verified');refresh();check(studentEmailVerifiedAddress_('native-student-email')==='native-student-changed@example.invalid','changed_address_active');
    check(call('studentEmailRemove').ok,'email_removed');refresh();check(!studentEmailVerifiedAddress_('native-student-email')&&!systemStudent_('native-student-email').email,'no_address_after_removal');
    check(!!call('studentEmailVerify',{challenge:changed,k:''}).error,'old_proof_cannot_restore');
    r=studentEmailRecord_('native-student-email');r.requestedAt=new Date(Date.now()-61000).toISOString();studentEmailSave_(r);
    check(call('studentEmailRequest',{email:'native-student@example.invalid'}).ok,'pending_after_removal');var pending=proof();refresh();studentEmailInvalidate_('native-student-email',false);
    check(!!call('studentEmailVerify',{challenge:pending,k:''}).error,'invalidation_denies_old_proof');
    studentEmailTest_=original.test;studentEmailDeliverMail_=original.deliver;before=mailbox.length;r=studentEmailRecord_('native-student-email');r.requestedAt=new Date(Date.now()-61000).toISOString();studentEmailSave_(r);
    check(call('studentEmailRequest',{email:'native-student@example.invalid'}).mailStatus==='suppressed'&&mailbox.length===before,'real_test_guard_suppresses');
    stage='preserved_state';
    check(JSON.stringify(app.getSheetByName('parents').getDataRange().getValues())===oldParents,'legacy_parent_auth_preserved');check(JSON.stringify(app.getSheetByName('config').getDataRange().getValues())===oldConfig,'teacher_config_preserved');check(JSON.stringify(app.getSheetByName('students').getRange(3,1,1,10).getValues())===oldOther,'other_student_preserved');
    var result={ok:true,checks:checks,book:{id:app.getId(),url:app.getUrl()}};Logger.log(JSON.stringify(result));return result;
  }catch(e){var failed={ok:false,stage:stage,failedCheck:e.studentEmailNativeCheck||'unexpected_error',checks:checks,book:app?{id:app.getId(),url:app.getUrl()}:null};Logger.log(JSON.stringify(failed));return failed;}
  finally{ss_=original.ss;ledger_=original.ledger;MEMO_=original.memo;studentEmailTest_=original.test;studentEmailQuota_=original.quota;studentEmailDeliverMail_=original.deliver;notify_=original.notify;mailStudent_=original.mail;mailbox=[];}
}
