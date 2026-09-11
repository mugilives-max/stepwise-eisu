/* 生徒の連絡用メール。専用リンクによる生徒認証を維持し、メールログインは追加しない。
 * 公開操作・先生の操作とも Code.gs の ScriptLock 内から呼ぶ。既存のメールを自動確認しない。 */
var STUDENT_EMAIL_COLS_=['studentId','email','verifiedAt','pendingEmail','challengeId','challengeHash','challengeExpiresAt','challengeFailCount','challengeLinkHash','challengeUsedAt','requestedAt','lastMailStatus','revision','updatedAt'];
var STUDENT_EMAIL_OUTBOX_COLS_=['id','studentId','eventKey','kind','email','contactRevision','snapshotJson','status','createdAt','sentAt','attempts','error'];
var STUDENT_EMAIL_PREF_COLS_=['studentId','offered','changed','cancelled','cancelDeclined','updatedAt'];
var STUDENT_EMAIL_KINDS_=['offered','changed','cancelled','cancelDeclined'];
var STUDENT_EMAIL_VERIFY_MS_=30*60*1000;
var STUDENT_EMAIL_VERIFY_URL_='https://www.stepwise-education.jp/yoyaku/#student-email?verify=';

function ensureStudentEmailSchema_(){
  var schemas={studentEmails:STUDENT_EMAIL_COLS_,studentEmailOutbox:STUDENT_EMAIL_OUTBOX_COLS_,studentEmailPrefs:STUDENT_EMAIL_PREF_COLS_};
  Object.keys(schemas).forEach(function(name){var sh=ss_().getSheetByName(name),cols=schemas[name];if(sh&&sh.getLastRow()&&(sh.getLastColumn()!==cols.length||sh.getRange(1,1,1,cols.length).getValues()[0].join('|')!==cols.join('|')))throw new Error('生徒メールの列構成を確認してください。自動上書きは行いません');});
  Object.keys(schemas).forEach(function(name){ensureSheet_(ss_(),name,schemas[name]);});memoClear_();
}
function studentEmailStamp_(){return new Date().toISOString();}
function studentEmailId_(){return Utilities.getUuid().replace(/-/g,'');}
function studentEmailError_(message,code){return {error:message,errorCode:code||'validation'};}
function studentEmailAddress_(value){return familyEmail_(value);}
function studentEmailRows_(name){return readRows_(name).map(function(r,i){r._row=i+2;return r;});}
function studentEmailWrite_(name,cols,r){var sh=sheet_(name);r._row=r._row||sh.getLastRow()+1;sh.getRange(r._row,1,1,cols.length).setNumberFormat('@').setValues([cols.map(function(k){return billingText_(String(r[k]==null?'':r[k]));})]);}
function studentEmailRecord_(studentId){
  var rows=studentEmailRows_('studentEmails').filter(function(r){return String(r.studentId)===String(studentId);});
  if(rows.length>1)throw new Error('生徒メールの登録が重複しています。先生へご連絡ください');return rows[0]||null;
}
function studentEmailSave_(r){r.updatedAt=studentEmailStamp_();studentEmailWrite_('studentEmails',STUDENT_EMAIL_COLS_,r);}
function studentEmailClearChallenge_(r){r.pendingEmail='';r.challengeId='';r.challengeHash='';r.challengeExpiresAt='';r.challengeFailCount=0;r.challengeLinkHash='';r.challengeUsedAt='';}
function studentEmailVerifiedAddress_(studentOrId){
  var id=typeof studentOrId==='object'&&studentOrId?studentOrId.id:studentOrId,s=findStudent_(id),r=s?studentEmailRecord_(s.id):null;
  return s&&r&&r.verifiedAt&&r.email&&studentEmailAddress_(s.email)===String(r.email)?String(r.email):'';
}
function studentEmailStatus_(studentId){
  var s=systemStudent_(studentId),r=s?studentEmailRecord_(studentId):null,verified=s?studentEmailVerifiedAddress_(studentId):'';
  return {email:s?studentEmailAddress_(s.email):'',verified:!!verified,verifiedAt:verified?String(r.verifiedAt):'',pendingEmail:r?String(r.pendingEmail||''):'',verificationExpiresAt:r&&r.challengeHash&&Number(r.challengeExpiresAt)>Date.now()?Number(r.challengeExpiresAt):0,mailStatus:r?String(r.lastMailStatus||''):'',prefs:studentEmailPrefs_(studentId)};
}
/* 通知項目のオン・オフ。行がなければ全項目オン。受信確認メールには適用しない。本人の専用リンクからだけ変更できる。 */
function studentEmailPrefRow_(studentId){var rows=studentEmailRows_('studentEmailPrefs').filter(function(r){return String(r.studentId)===String(studentId);});return rows[0]||null;}
function studentEmailPrefs_(studentId){var r=studentEmailPrefRow_(studentId),p={};STUDENT_EMAIL_KINDS_.forEach(function(k){p[k]=!r||String(r[k])!=='0';});return p;}
function studentEmailPrefsSave_(req){
  var auth=studentEmailRequire_(req);if(auth.error)return auth;var s=auth.student,input=req.prefs;
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(function(k){return STUDENT_EMAIL_KINDS_.indexOf(k)<0||typeof input[k]!=='boolean';}))return studentEmailError_('通知設定の内容を確認してください');
  if(!ss_().getSheetByName('studentEmailPrefs')){ensureSheet_(ss_(),'studentEmailPrefs',STUDENT_EMAIL_PREF_COLS_);memoClear_();}
  var r=studentEmailPrefRow_(s.id)||{studentId:String(s.id)},current=studentEmailPrefs_(s.id);
  STUDENT_EMAIL_KINDS_.forEach(function(k){r[k]=(k in input?input[k]:current[k])?'1':'0';});r.updatedAt=studentEmailStamp_();
  studentEmailWrite_('studentEmailPrefs',STUDENT_EMAIL_PREF_COLS_,r);
  return {ok:true,emailStatus:studentEmailStatus_(s.id)};
}
function studentEmailRequire_(req){var s=findStudentByCode_(String(req.k||''));return s?{student:s}:{error:'生徒専用リンクから開き直してください',badCode:true};}
function studentEmailSetMirror_(studentId,email){
  var rows=readRows_('students'),found=[];rows.forEach(function(s,i){if(String(s.id)===String(studentId))found.push(i+2);});
  if(found.length!==1)throw new Error('生徒の登録を確認してください');sheet_('students').getRange(found[0],4).setNumberFormat('@').setValue(billingText_(email));
}
// newCode/停止は未使用リンクだけ失効。先生によるメール変更は受信確認も失効させる。
function studentEmailInvalidate_(studentId,clearVerified){
  var r=studentEmailRecord_(studentId);if(!r)return;
  studentEmailClearChallenge_(r);r.revision=(Number(r.revision)||0)+1;r.lastMailStatus='';
  if(clearVerified){r.email='';r.verifiedAt='';}studentEmailSave_(r);
}
function studentEmailRequestAllowed_(studentId,email,r){
  if(r&&r.requestedAt&&Date.now()-Date.parse(String(r.requestedAt))<60000)return studentEmailError_('確認メールの再申請は1分以上待ってからお試しください','rateLimited');
  var rows=studentEmailRows_('studentEmailOutbox').filter(function(o){return o.kind==='verify'&&(String(o.studentId)===String(studentId)||String(o.email)===email);});
  var tooMany=[function(o){return String(o.studentId)===String(studentId);},function(o){return String(o.email)===email;}].some(function(match){var own=rows.filter(match);return own.filter(function(o){return Date.now()-Date.parse(String(o.createdAt))<3600000;}).length>=5||own.filter(function(o){return Date.now()-Date.parse(String(o.createdAt))<86400000;}).length>=10;});
  return tooMany?studentEmailError_('確認メールの申請回数が上限に達しました。時間をおいてお試しください','rateLimited'):null;
}
function studentEmailRequest_(req,resend){
  var auth=studentEmailRequire_(req);if(auth.error)return auth;var s=auth.student,r=studentEmailRecord_(s.id)||{studentId:String(s.id),revision:0};
  var email=studentEmailAddress_(resend?(r.pendingEmail||s.email):req.email);
  if(!email)return studentEmailError_('連絡先のメールアドレスを確認してください');
  if(email===studentEmailVerifiedAddress_(s)&&!r.pendingEmail)return studentEmailError_('このメールアドレスは確認済みです');
  var gate=studentEmailRequestAllowed_(s.id,email,r);if(gate)return gate;
  var secret=parentSecret_(),id=studentEmailId_();r.pendingEmail=email;r.challengeId=id;r.challengeHash=parentDigest_('student-email-proof',id,secret);r.challengeExpiresAt=Date.now()+STUDENT_EMAIL_VERIFY_MS_;r.challengeFailCount=0;r.challengeUsedAt='';r.challengeLinkHash=parentDigest_('student-email-link',s.id,String(s.code));r.requestedAt=studentEmailStamp_();r.lastMailStatus='pending';studentEmailSave_(r);
  var status='failed';
  try{
    var out=studentEmailOutboxAdd_(s,'verify:'+id,'verify',{email:email,contactRevision:Number(r.revision)||0,slots:[]});
    var body='生徒ページの連絡先メール登録を受け付けました。30分以内に次のページで受信確認をしてください。\n\n'+STUDENT_EMAIL_VERIFY_URL_+encodeURIComponent('se1.'+id+'.'+secret)+'\n\nお心当たりがない場合は、このメールを破棄してください。メールの登録だけで、生徒ページへログインできるようにはなりません。';
    status=studentEmailDeliverOutbox_(out,s,'【ステップワイズ】生徒メールの受信確認',body,true).status;
  }catch(e){/* 確認済みになるまで業務送信しない。例外に含まれる秘密を保存しない。 */}
  r=studentEmailRecord_(s.id);r.lastMailStatus=status;studentEmailSave_(r);
  return {ok:true,verificationRequired:true,mailStatus:status,emailStatus:studentEmailStatus_(s.id)};
}
function studentEmailVerify_(req){
  var p=String(req.challenge||'').split('.'),rows=p.length===3&&p[0]==='se1'?studentEmailRows_('studentEmails').filter(function(r){return String(r.challengeId)===p[1];}):[],r=rows.length===1?rows[0]:null;
  var invalid=function(){return studentEmailError_('確認リンクが無効か期限切れです。元の生徒ページから確認メールを再申請してください','invalidChallenge');};
  if(!r||!r.challengeHash||r.challengeUsedAt||Number(r.challengeExpiresAt)<=Date.now())return invalid();
  var s=findStudent_(r.studentId);if(!s||!s.code||!parentEqual_(r.challengeLinkHash,parentDigest_('student-email-link',s.id,String(s.code))))return invalid();
  if(!/^[a-f0-9]{64}$/.test(p[2])||!parentEqual_(r.challengeHash,parentDigest_('student-email-proof',r.challengeId,p[2]))){r.challengeFailCount=Number(r.challengeFailCount||0)+1;if(r.challengeFailCount>=5){r.challengeHash='';r.challengeUsedAt=studentEmailStamp_();}studentEmailSave_(r);return invalid();}
  var email=studentEmailAddress_(r.pendingEmail);if(!email)return invalid();
  // 先に証明を消費。途中失敗は再発行で回復し、未確認の宛先へ業務送信しない。
  r.challengeHash='';r.challengeUsedAt=studentEmailStamp_();r.challengeExpiresAt=0;studentEmailSave_(r);
  studentEmailSetMirror_(s.id,email);
  r.email=email;r.verifiedAt=studentEmailStamp_();r.revision=(Number(r.revision)||0)+1;studentEmailClearChallenge_(r);studentEmailSave_(r);
  return {ok:true,verified:true,message:'メールアドレスを確認しました。元の生徒専用ページへ戻ってご利用ください。'};
}
function studentEmailRemove_(req){
  var auth=studentEmailRequire_(req);if(auth.error)return auth;var s=auth.student,r=studentEmailRecord_(s.id)||{studentId:String(s.id)};
  studentEmailClearChallenge_(r);r.email='';r.verifiedAt='';r.lastMailStatus='';r.revision=(Number(r.revision)||0)+1;studentEmailSave_(r);studentEmailSetMirror_(s.id,'');
  return {ok:true,emailStatus:studentEmailStatus_(s.id)};
}
function studentEmailDispatch_(req){
  try{switch(req.action){
    case 'studentEmailRequest':return studentEmailRequest_(req,false);
    case 'studentEmailResend':return studentEmailRequest_(req,true);
    case 'studentEmailRemove':return studentEmailRemove_(req);
    case 'studentEmailPrefs':return studentEmailPrefsSave_(req);
    case 'studentEmailVerify':return studentEmailVerify_(req);
    default:return studentEmailError_('操作が見つかりません');
  }}catch(e){return studentEmailError_('処理を完了できませんでした。元の生徒ページで登録状況を確認し、必要なら確認メールを再申請してください','serverError');}
}

/* 生徒へのメールはこの送信記録に集約。確認リンク本文を保存せず、業務本文にも専用リンクを含めない。 */
function studentEmailSnapshot_(s){
  return {id:String(s&&s.id||''),date:normDate_(s&&s.date),start:normTime_(s&&s.start),min:Number(s&&s.min),subject:String(s&&s.subject||''),deliveryMode:String(s&&s.deliveryMode||'')};
}
function studentEmailSnapshotValid_(s,legacy){
  var value=legacy?{date:s.date,start:s.start,min:s.min,subject:s.subject||'授業'}:s;
  return !!s.id&&s.id.length<=100&&billingSlotValid_(value)&&(['in_person','online'].indexOf(s.deliveryMode)>=0||legacy&&s.deliveryMode==='');
}
function studentEmailSnapshotsValid_(kind,slots){
  return Array.isArray(slots)&&slots.length>0&&slots.length<=31&&(kind!=='changed'||slots.length===2)&&slots.every(function(s,i){return studentEmailSnapshotValid_(s,kind==='changed'&&i===0||kind==='cancelled'||kind==='cancelDeclined');});
}
function studentEmailOutboxAdd_(student,eventKey,kind,detail){
  var key=String(eventKey||'');if(!key||key.length>240)throw new Error('通知IDを確認してください');
  var snapshot=JSON.stringify(detail.slots||[]),matches=studentEmailRows_('studentEmailOutbox').filter(function(o){return String(o.studentId)===String(student.id)&&String(o.eventKey)===key;});
  if(matches.length>1)throw new Error('生徒の通知記録が重複しています');
  if(matches.length){var old=matches[0];if(String(old.kind)!==kind||String(old.snapshotJson)!==snapshot)throw new Error('同じ通知IDの内容が異なります');return old;}
  var out={id:studentEmailId_(),studentId:String(student.id),eventKey:key,kind:kind,email:detail.email||'',contactRevision:detail.contactRevision==null?'':detail.contactRevision,snapshotJson:snapshot,status:'pending',createdAt:studentEmailStamp_(),sentAt:'',attempts:0,error:''};
  studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return out;
}
function studentEmailTest_(student){return isTestStudent_(student);}
function studentEmailQuota_(){return MailApp.getRemainingDailyQuota();}
function studentEmailDeliverMail_(student,to,subject,body){
  if(studentEmailTest_(student))return 'suppressed';
  MailApp.sendEmail({to:to,subject:subject,body:body,name:'ステップワイズ英数教室'});return 'sent';
}
function studentEmailDeliverOutbox_(out,student,subject,body,verification){
  if(['pending','failed'].indexOf(String(out.status))<0)return out;
  var current=findStudent_(student.id),r=current?studentEmailRecord_(student.id):null;
  if(!verification&&(!current||!r||!out.email||String(out.email)!==studentEmailVerifiedAddress_(student.id)||Number(out.contactRevision)!==Number(r.revision))){out.status='cancelled';out.error='宛先または生徒の利用状態が変更されたため送信しません';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return out;}
  if(!current){out.status='cancelled';out.error='生徒が利用停止中のため送信しません';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return out;}
  if(!studentEmailTest_(current)&&studentEmailQuota_()<1){out.status='failed';out.error='メール送信上限のため未送信です';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return out;}
  out.status='uncertain';out.attempts=Number(out.attempts||0)+1;out.error='送信結果が不明です。二重送信を避けるため再送しません';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);
  try{
    var status=studentEmailDeliverMail_(current,String(out.email),subject,body);out.status=status==='suppressed'?'suppressed':'sent';out.sentAt=studentEmailStamp_();out.error=out.status==='suppressed'?'テストのため実送信を省略しました':'';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);
  }catch(e){out.status='uncertain';out.sentAt='';out.error='送信結果が不明です。二重送信を避けるため再送しません';}return out;
}
function studentEmailBusinessBody_(out){
  var slots=JSON.parse(String(out.snapshotJson)),kind=String(out.kind),titles={offered:'授業の案内が届いています',changed:'授業の予定を変更しました',cancelled:'授業を取り消しました',cancelDeclined:'授業は予定どおり行います'};
  if(!titles[kind]||!studentEmailSnapshotsValid_(kind,slots))throw new Error('通知の授業情報を確認してください');
  var lines=slots.map(function(s,i){return (kind==='changed'?(i===0?'変更前：':'変更後：'):'・')+s.date+' '+s.start+'〜'+endTime_(s.start,s.min)+' '+(s.subject||'科目未登録')+'（'+(s.deliveryMode==='online'?'オンライン':s.deliveryMode==='in_person'?'対面':'形式未登録')+'）';});
  return {subject:'【ステップワイズ】'+titles[kind],body:titles[kind]+'。\n\n'+lines.join('\n')+'\n\n先生から案内済みの生徒専用ページを開いてご確認ください。このメールには専用リンクを記載していません。'};
}
function studentEmailNotify_(student,eventKey,kind,slots){
  var snapshots=null,out=null,current=null;
  try{
    current=student&&findStudent_(student.id);if(!current)return {ok:true,status:'skipped',recorded:true};
    snapshots=(slots||[]).map(studentEmailSnapshot_);if(['offered','changed','cancelled','cancelDeclined'].indexOf(kind)<0||!studentEmailSnapshotsValid_(kind,snapshots))throw new Error('通知対象を確認してください');
    var r=studentEmailRecord_(current.id),email=studentEmailVerifiedAddress_(current);out=studentEmailOutboxAdd_(current,eventKey,kind,{email:email,contactRevision:r?Number(r.revision)||0:0,slots:snapshots});
    if(out.status==='pending'&&!studentEmailPrefs_(current.id)[kind]){out.status='skipped';out.error='本人の通知設定でオフのため送信しません';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return {ok:true,status:'skipped',recorded:true};}
    if(!email&&out.status==='pending'){out.status='skipped';out.error='受信確認済みのメールがないため送信しません';studentEmailWrite_('studentEmailOutbox',STUDENT_EMAIL_OUTBOX_COLS_,out);return {ok:true,status:'skipped',recorded:true};}
    var content=studentEmailBusinessBody_(out),sent=studentEmailDeliverOutbox_(out,current,content.subject,content.body,false),result={ok:true,status:sent.status,recorded:true};
    if(['pending','failed','uncertain'].indexOf(String(sent.status))>=0)result.warning='保存は完了しましたが、生徒へのメール通知を確認してください';return result;
  }catch(e){
    var recorded=false;
    try{var matches=studentEmailRows_('studentEmailOutbox').filter(function(o){return current&&String(o.studentId)===String(current.id)&&String(o.eventKey)===String(eventKey);});recorded=matches.length===1&&String(matches[0].kind)===kind&&snapshots!==null&&String(matches[0].snapshotJson)===JSON.stringify(snapshots);}catch(ignore){}
    return {ok:false,status:'failed',recorded:recorded,warning:'保存は完了しましたが、生徒へのメール通知を確認してください'};
  }
}
function studentEmailNotifyOffered_(student,eventKey,slots){return studentEmailNotify_(student,eventKey,'offered',slots);}
function studentEmailNotifyOfferChanged_(student,eventKey,before,after){return studentEmailNotify_(student,eventKey,'changed',[before,after]);}
function studentEmailNotifyCancelled_(student,eventKey,slot){return studentEmailNotify_(student,eventKey,'cancelled',[slot]);}
function studentEmailNotifyCancelDeclined_(student,eventKey,slot){return studentEmailNotify_(student,eventKey,'cancelDeclined',[slot]);}
function studentEmailNotifications_(studentId){
  return studentEmailRows_('studentEmailOutbox').filter(function(o){return String(o.studentId)===String(studentId);}).slice(-20).reverse().map(function(o){return {id:String(o.id),kind:String(o.kind),status:String(o.status),createdAt:String(o.createdAt),sentAt:String(o.sentAt),error:String(o.error),retryable:o.kind!=='verify'&&['pending','failed'].indexOf(String(o.status))>=0};});
}
function studentEmailAdmin_(req){
  if(authMode_()!=='account'||!tokenOk_(req.token))return {error:'先生アカウントでログインし直してください',badAuth:true};
  var s=systemStudent_(String(req.studentId||''));if(!s)return studentEmailError_('生徒が見つかりません');
  if(req.op==='studentEmailRetryNotification'){
    var rows=studentEmailRows_('studentEmailOutbox').filter(function(o){return String(o.id)===String(req.notificationId||'')&&String(o.studentId)===String(s.id);}),out=rows.length===1?rows[0]:null;
    if(!out||out.kind==='verify'||['pending','failed'].indexOf(String(out.status))<0)return studentEmailError_('未送信と確認できた授業通知だけ再試行できます。確認メールは生徒ページから再申請してください');
    try{var content=studentEmailBusinessBody_(out);studentEmailDeliverOutbox_(out,s,content.subject,content.body,false);}catch(e){return studentEmailError_('通知状況を確認できませんでした。しばらく待って再読み込みしてください');}
  }else if(req.op!=='studentEmailNotifications')return studentEmailError_('操作が見つかりません');
  return {ok:true,emailStatus:studentEmailStatus_(s.id),notifications:studentEmailNotifications_(s.id)};
}
