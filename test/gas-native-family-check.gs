/** Editor-only family verification. Creates two entirely new synthetic books.
 * Never calls setup/doPost/ensureSchema or reads Script Properties/shared cache.
 * All mail is an in-memory fake at the mail boundary; no real recipient is used.
 * Remove this helper before publishing. Output has checks/timings/book URLs only. */
function stepwiseNativeFamilyCheck() {
  var app=null,book=null,stage='create_books',started=Date.now(),checks={},timings=[],mailbox=[],quota=100,failMail=false,forbiddenCalls=0;
  var original={memo:MEMO_,ss:ss_,ledger:ledger_,lite:LITE_,lessonBook:LESSON_SCHEMA_BOOK_,paymentCols:LEDGER_COLS['入金管理'],
    deliver:familyDeliverMail_,quota:familyMailQuota_,test:familyTestAccount_,notify:notify_,mail:mailStudent_,calendar:createCalEvent_};
  var token='native-family-teacher-fixture-only',email='native-family@example.invalid',pass=parentSecret_(),familyId='',ftoken='';
  function check(condition,name){checks[name]=!!condition;if(!condition){var e=new Error(name);e.nativeFamilyCode=name;throw e;}}
  function forbidden(){forbiddenCalls++;throw new Error('forbidden_side_effect');}
  function refresh(){memoClear_();}
  function admin(op,args){refresh();var req={action:'admin',op:op,token:token};Object.keys(args||{}).forEach(function(k){req[k]=args[k];});return admin_(req);}
  function pub(action,args){refresh();var req={action:action};Object.keys(args||{}).forEach(function(k){req[k]=args[k];});var t=Date.now(),r=familyDispatch_(req);timings.push({operation:action,elapsedMS:Date.now()-t});return r;}
  function challenge(query){var matches=mailbox.filter(function(m){return m.body.indexOf('?'+query+'=')>=0;});var mail=matches[matches.length-1];return decodeURIComponent(mail.body.match(new RegExp('\\?'+query+'=([^\\s]+)'))[1]);}
  function notification(key){refresh();return familyNotifySafe_('invoiceCreated','native-family-a',key,{ym:'2026-09',revision:2});}
  function out(key){refresh();return familyRows_('familyOutbox').filter(function(r){return r.eventKey===key;})[0];}
  function sources(){return {app:app?{id:app.getId(),url:app.getUrl()}:null,ledger:book?{id:book.getId(),url:book.getUrl()}:null};}
  try {
    var stamp=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMMdd-HHmmss');
    app=SpreadsheetApp.create('【テスト】家族・メール検証 予約 '+stamp);book=SpreadsheetApp.create('【テスト】家族・メール検証 台帳 '+stamp);
    MEMO_={ss:app,ledger:book,rows:{},lrows:{}};ss_=function(){return app;};ledger_=function(){return book;};LITE_=true;LESSON_SCHEMA_BOOK_=null;
    notify_=forbidden;mailStudent_=forbidden;createCalEvent_=forbidden;
    familyMailQuota_=function(){return quota;};
    familyTestAccount_=function(){return false;}; // Exercise quota/sent/uncertain; recipient still only memory.
    familyDeliverMail_=function(to,subject,body,a){
      check(/^native-family(?:-changed)?@example\.invalid$/.test(to)&&original.test(a),'fake_mail_recipient_guard');
      mailbox.push({to:to,subject:subject,body:body});if(failMail)throw new Error('synthetic_send_outcome_unknown');return 'sent';
    };
    check(ss_().getId()===app.getId()&&ledger_().getId()===book.getId(),'new_books_only');
    stage='schema';
    var schemas={config:['key','value'],students:['id','name','active','email','code','rate30','monthly','parentToken','parentExp'],
      slots:['id','date','start','min','status','studentId','done','eventId','meetUrl','subject','req'],plans:['id','studentId','ym','subject','count','status','proposedAt','approvedAt','approvedVia','memo'],parents:PARENT_AUTH_COLUMNS_.slice(),log:['time','message']};
    Object.keys(schemas).forEach(function(name){ensureSheet_(app,name,schemas[name]);});
    app.getSheetByName('students').getRange(2,1,3,9).setNumberFormat('@').setValues([
      ['native-family-a','【テスト】家族A',true,'','native-family-link-a',1500,0,'',''],
      ['native-family-b','【テスト】家族B',true,'','native-family-link-b',1500,0,'',''],
      ['native-family-inactive','【テスト】家族停止中',false,'','native-family-link-inactive',1500,0,'','']]);
    var config={passHash:'native-fixture-hash',passSalt:'native-fixture-salt',adminToken:token,adminTokenExp:String(Date.now()+3600000),calendarSync:'off',emailNotify:'off',teacherEmail:''};
    Object.keys(config).forEach(function(k){setConfig_(k,config[k]);});
    ensureLessonSchema_();ensureBillingSchema_();ensureFamilySchema_();refresh();
    var oldParents=JSON.stringify(app.getSheetByName('parents').getDataRange().getValues());
    var oldStudents=JSON.stringify(app.getSheetByName('students').getDataRange().getValues());
    var oldConfig=JSON.stringify(app.getSheetByName('config').getDataRange().getValues());
    check(app.getSheetByName('familyAccounts').getLastColumn()===FAMILY_ACCOUNT_COLS_.length,'family_schema_width');
    stage='invite_register_verify';
    check(!!familyAdmin_({op:'familyList',token:'wrong'}).badAuth,'teacher_token_required');
    check(!!admin('familyCreate',{label:'【テスト】不正家族',studentIds:['native-family-inactive']}).error,'inactive_link_rejected');
    var created=admin('familyCreate',{label:'=【テスト】兄弟家族',studentIds:['native-family-a','native-family-b']});
    check(created.ok&&created.family.children.length===2,'explicit_sibling_links');familyId=created.family.id;
    var signup=pub('familyRegister',{inviteCode:created.inviteCode,email:email,pass:pass});
    check(signup.ok&&signup.mailStatus==='sent'&&!signup.ftoken,'register_requires_verification');
    check(mailbox.length===1,'one_verification_message');
    check(!!pub('familyLogin',{email:email,pass:'too short'}).error,'unverified_login_rejected');
    check(!!pub('familyData',{studentId:'native-family-a'}).familyAuthRequired,'unauthenticated_child_rejected');
    var firstChallenge=challenge('verify');
    check(pub('familyVerify',{challenge:firstChallenge}).ok,'email_verified');
    check(!!pub('familyVerify',{challenge:firstChallenge}).error,'verification_one_use');
    var login=pub('familyLogin',{email:email.toUpperCase(),pass:pass});
    check(login.ok&&login.children.length===2,'email_login_siblings');ftoken=login.ftoken;
    stage='child_scope_and_notification';
    check(pub('familyData',{ftoken:ftoken,studentId:'native-family-a'}).data.name==='【テスト】家族A','first_child_data');
    check(pub('familyData',{ftoken:ftoken,studentId:'native-family-b'}).data.name==='【テスト】家族B','second_child_data');
    check(!!pub('familyData',{ftoken:ftoken,studentId:'native-family-inactive'}).error,'unlinked_child_rejected');
    var before=mailbox.length;check(notification('native-event-one').ok,'notification_enqueue');
    notification('native-event-one');check(mailbox.length===before+1&&out('native-event-one').status==='sent','notification_event_idempotent');
    quota=0;notification('native-event-quota');check(out('native-event-quota').status==='failed'&&mailbox.length===before+1,'quota_not_sent');
    quota=100;check(admin('familyRetryNotifications',{ids:[out('native-event-quota').id]}).ok&&out('native-event-quota').status==='sent','failed_delivery_retry');
    failMail=true;notification('native-event-uncertain');failMail=false;var sent=mailbox.length;
    notification('native-event-uncertain');check(out('native-event-uncertain').status==='uncertain'&&mailbox.length===sent,'uncertain_not_auto_retried');
    check(!!admin('familyRetryNotifications',{ids:[out('native-event-uncertain').id]}).error,'uncertain_not_manually_retried');
    var teacher=admin('familyList');check(!/passHash|passSalt|tokenHash|secretHash|inviteHash|fc1\.|fa1\./.test(JSON.stringify(teacher)),'teacher_output_no_secrets');
    stage='reset_email_change_revocation';
    var unknown=pub('familyResetRequest',{email:'unknown@example.invalid'}),known=pub('familyResetRequest',{email:email});
    check(JSON.stringify(unknown)===JSON.stringify(known),'reset_response_generic');
    var reset=challenge('reset'),newPass=parentSecret_();
    check(pub('familyResetConfirm',{challenge:reset,pass:newPass}).ok,'password_reset');
    check(!!pub('familyResetConfirm',{challenge:reset,pass:newPass}).error,'reset_one_use');
    check(!!pub('familyHome',{ftoken:ftoken}).familyAuthRequired,'reset_revokes_session');
    login=pub('familyLogin',{email:email,pass:newPass});check(login.ok,'new_password_login');ftoken=login.ftoken;
    var change=pub('familyEmailChange',{ftoken:ftoken,email:'native-family-changed@example.invalid',pass:newPass});
    check(change.ok&&change.mailStatus==='sent','email_change_current_password');
    check(!!pub('familyHome',{ftoken:ftoken}).familyAuthRequired,'email_change_revokes_session');
    refresh();check(familyAccount_(familyId).email===email,'email_unchanged_until_verified');
    check(pub('familyVerify',{challenge:challenge('verify')}).ok,'new_email_verified');
    login=pub('familyLogin',{email:'native-family-changed@example.invalid',pass:newPass});check(login.ok,'new_email_login');ftoken=login.ftoken;
    check(admin('familySetChildren',{familyId:familyId,studentIds:['native-family-a']}).ok,'unlink_child');
    check(!!pub('familyHome',{ftoken:ftoken}).familyAuthRequired,'unlink_revokes_session');
    login=pub('familyLogin',{email:'native-family-changed@example.invalid',pass:newPass});check(login.ok&&login.children.length===1,'only_remaining_child');ftoken=login.ftoken;
    check(!!pub('familyData',{ftoken:ftoken,studentId:'native-family-b'}).error,'removed_child_denied');
    check(admin('familySetActive',{familyId:familyId,active:false}).ok,'disable_family');
    check(!!pub('familyHome',{ftoken:ftoken}).familyAuthRequired,'disabled_session_denied');
    stage='final_invariants';refresh();
    var persisted=JSON.stringify(['familyAccounts','familyLinks','familyChallenges','familyOutbox','log'].map(function(n){return app.getSheetByName(n).getDataRange().getValues();}));
    check(persisted.indexOf(pass)<0&&persisted.indexOf(newPass)<0&&persisted.indexOf(created.inviteCode)<0&&persisted.indexOf(firstChallenge)<0&&persisted.indexOf(ftoken)<0,'no_plain_credentials_persisted');
    check(Object.keys(schemas).concat(['familyAccounts','familyLinks','familyChallenges','familyOutbox']).every(function(n){return !app.getSheetByName(n).getDataRange().getFormulas().some(function(r){return r.some(Boolean);});}),'no_sheet_formulas');
    check(JSON.stringify(app.getSheetByName('parents').getDataRange().getValues())===oldParents,'legacy_parents_unchanged');
    check(JSON.stringify(app.getSheetByName('students').getDataRange().getValues())===oldStudents,'students_unchanged');
    check(JSON.stringify(app.getSheetByName('config').getDataRange().getValues())===oldConfig,'teacher_config_unchanged');
    check(forbiddenCalls===0,'no_real_mail_or_calendar');
    var result={ok:true,checks:checks,timings:timings,elapsedMS:Date.now()-started,books:sources()};Logger.log(JSON.stringify(result));return result;
  } catch(e) {
    var failed={ok:false,stage:stage,failedCheck:e.nativeFamilyCode||'unexpected_error',checks:checks,timings:timings,elapsedMS:Date.now()-started,books:sources()};Logger.log(JSON.stringify(failed));return failed;
  } finally {
    ss_=original.ss;ledger_=original.ledger;MEMO_=original.memo;LITE_=original.lite;LESSON_SCHEMA_BOOK_=original.lessonBook;LEDGER_COLS['入金管理']=original.paymentCols;
    familyDeliverMail_=original.deliver;familyMailQuota_=original.quota;familyTestAccount_=original.test;notify_=original.notify;mailStudent_=original.mail;createCalEvent_=original.calendar;
    mailbox=[];pass='';ftoken='';
  }
}
