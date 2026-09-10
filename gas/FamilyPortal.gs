/* 家族アカウントとメール通知。全公開操作は Code.gs の ScriptLock 内で実行する。
 * 既存 parents は変更しない。子の権限は先生が作ったリンクを毎回確認する。 */
var FAMILY_ACCOUNT_COLS_ = ['id','label','status','email','verifiedAt','passSalt','passHash','createdAt','updatedAt','lastLogin','failCount','lockUntil','tokenHash','tokenExpiresAt','securityVersion','inviteHash','inviteExpiresAt','inviteFailCount','testOnly'];
var FAMILY_LINK_COLS_ = ['id','familyId','studentId','active','linkedAt','updatedAt'];
var FAMILY_CHALLENGE_COLS_ = ['id','familyId','kind','email','secretHash','expiresAt','usedAt','createdAt','failCount','securityVersion'];
var FAMILY_OUTBOX_COLS_ = ['id','eventKey','familyId','studentId','kind','ym','revision','email','status','createdAt','sentAt','attempts','error'];
var FAMILY_PORTAL_URL_ = 'https://www.stepwise-education.jp/yoyaku/#family';
var FAMILY_CHALLENGE_MS_ = 30 * 60 * 1000;

function ensureFamilySchema_() {
  var definitions={familyAccounts:FAMILY_ACCOUNT_COLS_,familyLinks:FAMILY_LINK_COLS_,familyChallenges:FAMILY_CHALLENGE_COLS_,familyOutbox:FAMILY_OUTBOX_COLS_};
  Object.keys(definitions).forEach(function(name){
    var sh=ss_().getSheetByName(name),cols=definitions[name];
    if(sh&&sh.getLastRow()&&(sh.getLastColumn()!==cols.length||sh.getRange(1,1,1,cols.length).getValues()[0].join('|')!==cols.join('|')))throw new Error(name+'の列構成を確認してください。自動上書きは行いません');
  });
  Object.keys(definitions).forEach(function(name){
    var cols=definitions[name],sh=ensureSheet_(ss_(),name,cols);
    if(sh.getRange(1,1,1,cols.length).getValues()[0].join('|')!==cols.join('|'))throw new Error(name+'の列構成を確認してください。自動上書きは行いません');
  });
  memoClear_();
}
function familyError_(message,auth) { var r={error:message};if(auth)r.familyAuthRequired=true;return r; }
function familyStamp_() { return new Date().toISOString(); }
function familyId_() { return Utilities.getUuid().replace(/-/g,''); }
function familyRows_(name) { return readRows_(name).map(function(r,i){r._row=i+2;return r;}); }
function familyWrite_(name,cols,r) {
  var sh=sheet_(name),row=r._row||sh.getLastRow()+1;
  sh.getRange(row,1,1,cols.length).setNumberFormat('@').setValues([cols.map(function(k){return billingText_(String(r[k]==null?'':r[k]));})]);r._row=row;
}
function familyAccount_(id) {
  var rows=familyRows_('familyAccounts').filter(function(r){return String(r.id)===String(id);});
  if(rows.length>1)throw new Error('家族アカウントが重複しています。先生へご連絡ください');return rows[0]||null;
}
function familySave_(a) { a.updatedAt=familyStamp_();familyWrite_('familyAccounts',FAMILY_ACCOUNT_COLS_,a); }
function familyEmail_(v) {
  var e=String(v||'').trim().toLowerCase();
  return e.length<=254&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(e)?e:'';
}
function familyByEmail_(email) {
  if(!email)return null;
  var rows=familyRows_('familyAccounts').filter(function(a){return String(a.email)===email;});
  if(rows.length>1)throw new Error('メール登録が重複しています。先生へご連絡ください');return rows[0]||null;
}
function familyEmailAvailable_(email,id) { var a=familyByEmail_(email);return !a||String(a.id)===String(id); }
function familyInvalidate_(a) { a.tokenHash='';a.tokenExpiresAt='';a.securityVersion=(Number(a.securityVersion)||0)+1; }
function familyInvalidateStudent_(studentId) {
  var seen={};familyRows_('familyLinks').forEach(function(l){
    if(String(l.studentId)!==String(studentId)||String(l.active)!=='true'||seen[l.familyId])return;
    seen[l.familyId]=true;var a=familyAccount_(l.familyId);if(a){familyInvalidate_(a);familySave_(a);}
  });
}
function familyChildren_(a,includeInactive) {
  var seen={},out=[];familyRows_('familyLinks').forEach(function(l){
    if(String(l.familyId)!==String(a.id)||String(l.active)!=='true')return;
    if(seen[l.studentId])throw new Error('家族と生徒の紐付けが重複しています');seen[l.studentId]=true;
    var s=findStudent_(l.studentId);
    if(s)out.push({studentId:String(s.id),name:String(s.name),active:true});
    else if(includeInactive){var old=readRows_('students').filter(function(x){return String(x.id)===String(l.studentId);})[0];if(old)out.push({studentId:String(old.id),name:String(old.name),active:false});}
  });return out;
}
function familyPublic_(a) { return {id:String(a.id),label:String(a.label),email:String(a.email)}; }
// Read-only statement of existing child invoices; does not issue or pay again.
function familyBilling_(a,includeInactive) {
  var children=familyChildren_(a,includeInactive),months={};
  children.forEach(function(child){billingInvoiceRows_(child.studentId).forEach(function(p){
    if(p['取消日時']||String(p['状態'])==='取消')return;
    var invoice=billingInvoiceView_(p),ym=invoice.ym;
    if(!billingMonthValid_(ym))return;
    var m=months[ym]||(months[ym]={ym:ym,children:[],amount:0,unpaid:0,conflict:false});
    if(m.children.some(function(c){return c.studentId===child.studentId;}))m.conflict=true;
    m.children.push({studentId:child.studentId,name:child.name,invoice:invoice});m.amount+=invoice.amount;
    if(!invoice.paidDate)m.unpaid+=invoice.amount;
  });});
  return Object.keys(months).sort().reverse().map(function(ym){var m=months[ym];if(m.conflict){m.amount=null;m.unpaid=null;}return m;});
}
function familyView_(a) {
  return {billing:familyBilling_(a,true),id:String(a.id),label:String(a.label),status:String(a.status),email:String(a.email||''),verifiedAt:String(a.verifiedAt||''),configured:!!a.passHash,
    children:familyChildren_(a,true),inviteExpiresAt:a.inviteHash&&Number(a.inviteExpiresAt)>Date.now()?Number(a.inviteExpiresAt):0,createdAt:String(a.createdAt||''),lastLogin:String(a.lastLogin||'')};
}
function familySessions_(a) {
  if(!a||!a.tokenHash)return [];
  var values=[];try{values=JSON.parse(String(a.tokenHash));}catch(e){values=[{hash:String(a.tokenHash),expiresAt:Number(a.tokenExpiresAt)}];}
  return Array.isArray(values)?values.filter(function(x){return x&&typeof x.hash==='string'&&/^[a-f0-9]{64}$/.test(x.hash)&&Number(x.expiresAt)>Date.now();}):[];
}
function familySessionMatches_(a,token) {
  return !!(a&&a.status==='active'&&a.verifiedAt&&a.passHash&&a.tokenHash&&Number(a.tokenExpiresAt)>Date.now()&&/^fa1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(String(token||''))&&familySessions_(a).some(function(x){return parentEqual_(x.hash,parentDigest_('family-session',a.id,token));}));
}
function familyRequire_(req) {
  var token=String(req.ftoken||''),parts=token.split('.'),a=parts.length===3?familyAccount_(parts[1]):null;
  return familySessionMatches_(a,token)?{account:a}:familyError_('保護者メールでログインし直してください',true);
}
function familyChildRequire_(req) {
  var auth=familyRequire_(req);if(auth.error)return auth;
  var id=String(req.studentId||'');if(!familyChildren_(auth.account,false).some(function(s){return s.studentId===id;}))return familyError_('この生徒の情報は利用できません');
  auth.student=findStudent_(id);return auth;
}
function familyIssueSession_(a) {
  var sessions=familySessions_(a);if(sessions.length>=20)return familyError_('同時ログインの上限です。利用していない端末でログアウトするか、有効期限後に再試行してください');
  var token='fa1.'+a.id+'.'+parentSecret_();a.tokenExpiresAt=Date.now()+PARENT_SESSION_MS_;sessions.push({hash:parentDigest_('family-session',a.id,token),expiresAt:a.tokenExpiresAt});a.tokenHash=JSON.stringify(sessions);a.lastLogin=familyStamp_();a.failCount=0;a.lockUntil='';familySave_(a);
  return {ok:true,ftoken:token,family:familyPublic_(a),children:familyChildren_(a,false),billing:familyBilling_(a,false)};
}
function familyPassword_(a,pass) {
  pass=String(pass||'');
  if(a&&Number(a.lockUntil)>Date.now())return false;
  if(a&&Number(a.lockUntil)){a.failCount=0;a.lockUntil='';}
  var valid=pass.length>=12&&pass.length<=128;
  var hash=valid?parentPasswordHash_(pass,a&&a.passSalt?String(a.passSalt):'family-login-unknown-account'):'';
  var same=!!(a&&a.passHash&&valid&&parentEqual_(a.passHash,hash));
  if(a){a.failCount=same?0:Number(a.failCount||0)+1;a.lockUntil=a.failCount>=PARENT_MAX_FAILURES_?Date.now()+PARENT_LOCK_MS_:'';familySave_(a);}
  return same;
}
function familyLogin_(req) {
  var a=familyByEmail_(familyEmail_(req.email));
  if(!familyPassword_(a,req.pass)||!a||a.status!=='active'||!a.verifiedAt)return familyError_('メール・パスワード・メール確認を確認してください。入力間違いが続いた場合は15分後にお試しください');
  return familyIssueSession_(a);
}
function familyLogout_(req) {
  var token=String(req.ftoken||''),parts=token.split('.'),a=parts.length===3?familyAccount_(parts[1]):null;
  if(familySessionMatches_(a,token)){var sessions=familySessions_(a).filter(function(x){return !parentEqual_(x.hash,parentDigest_('family-session',a.id,token));});a.tokenHash=sessions.length?JSON.stringify(sessions):'';a.tokenExpiresAt=sessions.reduce(function(n,x){return Math.max(n,Number(x.expiresAt));},0)||'';familySave_(a);}return {ok:true};
}
function familyInvite_(a) {
  if(a.passHash)return familyError_('登録済みの保護者はメールからパスワードを再設定してください');
  if(a.status==='disabled'||!familyChildren_(a,false).length)return familyError_('利用中の生徒を紐付けてください');
  var secret=parentSecret_(),code='fi1.'+a.id+'.'+secret;
  a.verifiedAt='';familyInvalidate_(a);a.inviteHash=parentDigest_('family-invite',a.id,secret);a.inviteExpiresAt=Date.now()+PARENT_SETUP_MS_;a.inviteFailCount=0;familySave_(a);
  return {ok:true,family:familyView_(a),inviteCode:code,expiresAt:Number(a.inviteExpiresAt)};
}
function familyRegister_(req) {
  var parts=String(req.inviteCode||'').trim().split('.'),a=parts.length===3&&parts[0]==='fi1'?familyAccount_(parts[1]):null;
  if(!a||a.status!=='pending'||a.passHash||a.verifiedAt||!a.inviteHash||Number(a.inviteExpiresAt)<=Date.now()||!familyChildren_(a,false).length)return familyError_('招待コードが無効か期限切れです。先生に再発行をお願いしてください');
  if(!/^[a-f0-9]{64}$/.test(parts[2])||!parentEqual_(a.inviteHash,parentDigest_('family-invite',a.id,parts[2]))){
    a.inviteFailCount=Number(a.inviteFailCount||0)+1;if(a.inviteFailCount>=PARENT_MAX_FAILURES_)a.inviteHash='';familySave_(a);return familyError_('招待コードを確認してください');
  }
  var email=familyEmail_(req.email);
  if(!email)return familyError_('メールアドレスを確認してください');
  if(!familyEmailAvailable_(email,a.id))return familyError_('このメールでは登録できません。既存のログインをお試しになるか先生へご相談ください');
  // 制限中は有効な確認リンクを保持。招待は完了まで保持して未確認メールの訂正に使う。
  if(!familyChallengeAvailable_(a,'verify'))return familyError_('送信間隔の制限中です。メールアドレスは変更していません。1分以上待ってお試しください（1時間に5回まで）');
  a.email=email;a.status='pending';a.verifiedAt='';a.inviteFailCount=0;familyInvalidate_(a);familySave_(a);
  var delivery=familyIssueChallengeSafe_(a,'verify',email);
  return {ok:true,verificationRequired:true,mailStatus:delivery.status};
}
function familyChallengeWrite_(c) { familyWrite_('familyChallenges',FAMILY_CHALLENGE_COLS_,c); }
function familyIssueChallengeSafe_(a,kind,email) {
  try{return familyIssueChallenge_(a,kind,email);}catch(e){return {status:'failed'};}
}
function familyChallengeAvailable_(a,kind) {
  var rows=familyRows_('familyChallenges').filter(function(c){return String(c.familyId)===String(a.id)&&String(c.kind)===kind;});
  return !rows.some(function(c){return Date.now()-Date.parse(c.createdAt)<60000;})&&rows.filter(function(c){return Date.now()-Date.parse(c.createdAt)<3600000;}).length<5;
}
function familyIssueChallenge_(a,kind,email) {
  if(!familyChallengeAvailable_(a,kind))return {status:'limited'};
  familyRows_('familyChallenges').forEach(function(c){if(String(c.familyId)===String(a.id)&&String(c.kind)===kind&&!c.usedAt){c.usedAt=familyStamp_();familyChallengeWrite_(c);}});
  var secret=parentSecret_(),c={id:familyId_(),familyId:a.id,kind:kind,email:email,expiresAt:Date.now()+FAMILY_CHALLENGE_MS_,usedAt:'',createdAt:familyStamp_(),failCount:0,securityVersion:Number(a.securityVersion)||0};
  c.secretHash=parentDigest_('family-challenge',c.id,secret);familyChallengeWrite_(c);
  var token='fc1.'+c.id+'.'+secret,query=kind==='reset'?'reset':'verify',url=FAMILY_PORTAL_URL_+'?'+query+'='+encodeURIComponent(token);
  var subject=kind==='reset'?'【ステップワイズ】パスワード再設定':'【ステップワイズ】保護者メールの確認';
  var body=(kind==='reset'?'パスワード再設定':'保護者メールの確認')+'のお申し込みを受け付けました。30分以内に次のページでお手続きください。\n\n'+url+(kind==='verify'?'\n\nメールアドレスを確認した後、保護者用パスワードを設定すると登録完了です。':'')+'\n\nお心当たりがない場合は、このメールを破棄してください。';
  var out=familyOutboxAdd_('auth:'+c.id,a,'',kind==='reset'?'passwordReset':'emailVerification',{email:email});
  return familyDeliverOutbox_(out,a,subject,body,true);
}
function familyChallenge_(token,kinds) {
  var p=String(token||'').split('.'),rows=p.length===3&&p[0]==='fc1'?familyRows_('familyChallenges').filter(function(c){return String(c.id)===p[1];}):[],c=rows.length===1?rows[0]:null;
  if(!c||c.usedAt||Number(c.expiresAt)<=Date.now()||kinds.indexOf(String(c.kind))<0)return null;
  var a=familyAccount_(c.familyId);if(!a||a.status==='disabled'||Number(a.securityVersion)!==Number(c.securityVersion))return null;
  if(!/^[a-f0-9]{64}$/.test(p[2])||!parentEqual_(c.secretHash,parentDigest_('family-challenge',c.id,p[2]))){c.failCount=Number(c.failCount||0)+1;if(c.failCount>=PARENT_MAX_FAILURES_)c.usedAt=familyStamp_();familyChallengeWrite_(c);return null;}
  return {challenge:c,account:a};
}
// Show only the address bound to a valid proof; opening the page does not verify it.
function familyVerificationInfo_(req) {
  var v=familyChallenge_(req.challenge,['verify','emailChange']);
  if(!v)return {error:'この認証リンクは期限切れか、すでに使用されています。',verificationUnavailable:true};
  var c=v.challenge,a=v.account;
  if(c.kind==='verify'&&(a.status!=='pending'||String(a.email)!==String(c.email)))return {error:'この認証リンクは現在の登録内容と一致しません。',verificationUnavailable:true};
  return {ok:true,email:String(c.email),registration:c.kind==='verify'};
}
function familyVerify_(req) {
  var v=familyChallenge_(req.challenge,['verify','emailChange']);if(!v)return {error:'この認証リンクは期限切れか、すでに使用されています。',verificationUnavailable:true};
  var c=v.challenge,a=v.account;
  if(!familyEmailAvailable_(String(c.email),a.id))return familyError_('このメールでは登録できません。先生へご相談ください');
  if(c.kind==='verify'&&(a.status!=='pending'||String(a.email)!==String(c.email)))return familyError_('確認リンクが無効です');
  if(c.kind==='verify') {
    // パスワード設定時に証明を消費する。期限内なら設定途中から再開できる。
    a.verifiedAt=a.verifiedAt||familyStamp_();familySave_(a);
    return {ok:true,verified:true,passwordRequired:true,email:String(a.email)};
  }
  // 先に一回限りの証明を消費。後続書き込みが失敗したら再発行し、古い証明を再利用しない。
  c.usedAt=familyStamp_();familyChallengeWrite_(c);a.email=String(c.email);a.verifiedAt=familyStamp_();a.status='active';a.failCount=0;a.lockUntil='';familyInvalidate_(a);familySave_(a);
  return {ok:true,verified:true};
}
function familyCompleteRegistration_(req) {
  var v=familyChallenge_(req.challenge,['verify']);
  if(!v)return familyError_('確認リンクが無効か期限切れです。確認メールを再送してください');
  var a=v.account,c=v.challenge,pass=String(req.pass||'');
  if(a.status!=='pending'||!a.verifiedAt||String(a.email)!==String(c.email))return familyError_('先にメールアドレスを確認してください');
  if(!familyEmailAvailable_(String(c.email),a.id))return familyError_('このメールでは登録できません。先生へご相談ください');
  if(pass.length<12||pass.length>128)return familyError_('パスワードは12〜128文字で設定してください');
  var salt=parentSecret_(),hash=parentPasswordHash_(pass,salt);
  c.usedAt=familyStamp_();familyChallengeWrite_(c);
  a.passSalt=salt;a.passHash=hash;a.status='active';a.failCount=0;a.lockUntil='';a.inviteHash='';a.inviteExpiresAt='';a.inviteFailCount=0;
  familyInvalidate_(a);familySave_(a);
  return {ok:true,registered:true,email:String(a.email)};
}
function familyGenericMail_() { return {ok:true,message:'登録内容が一致する場合、確認メールを送信します。届かない場合は少し待ってから再試行するか先生へご相談ください。'}; }
function familyResendVerification_(req) {
  var a=familyByEmail_(familyEmail_(req.email));
  if(a&&a.status==='pending')familyIssueChallengeSafe_(a,'verify',String(a.email));return familyGenericMail_();
}
function familyResetRequest_(req) {
  var a=familyByEmail_(familyEmail_(req.email));
  if(a&&a.passHash&&(a.status==='active'||a.status==='pending'))familyIssueChallengeSafe_(a,'reset',String(a.email));return familyGenericMail_();
}
function familyResetConfirm_(req) {
  var v=familyChallenge_(req.challenge,['reset']);if(!v)return familyError_('再設定リンクが無効か期限切れです。もう一度申し込んでください');
  var a=v.account,c=v.challenge,pass=String(req.pass||'');
  if((a.status!=='active'&&a.status!=='pending')||String(a.email)!==String(c.email))return familyError_('再設定リンクが無効です');
  if(pass.length<12||pass.length>128)return familyError_('パスワードは12〜128文字で設定してください');
  var salt=parentSecret_(),hash=parentPasswordHash_(pass,salt);c.usedAt=familyStamp_();familyChallengeWrite_(c);
  a.passSalt=salt;a.passHash=hash;a.failCount=0;a.lockUntil='';a.verifiedAt=a.verifiedAt||familyStamp_();a.status='active';familyInvalidate_(a);familySave_(a);return {ok:true,reset:true};
}
function familyEmailChange_(req) {
  var auth=familyRequire_(req);if(auth.error)return auth;var a=auth.account,email=familyEmail_(req.email);
  if(!familyPassword_(a,req.pass))return familyError_('現在のパスワードを確認してください');
  if(!email||email===String(a.email))return familyError_('新しいメールアドレスを確認してください');
  if(!familyEmailAvailable_(email,a.id))return familyError_('このメールでは登録できません。先生へご相談ください');
  if(!familyChallengeAvailable_(a,'emailChange'))return familyError_('確認メールの再発行はしばらく待ってからお試しください');
  familyInvalidate_(a);familySave_(a);var delivery=familyIssueChallengeSafe_(a,'emailChange',email);
  return {ok:true,verificationRequired:true,mailStatus:delivery.status};
}
function familyDispatch_(req) {
  try { switch(req.action){
    case 'familyRegister':return familyRegister_(req);
    case 'familyVerify':return familyVerify_(req);
    case 'familyVerificationInfo':return familyVerificationInfo_(req);
    case 'familyCompleteRegistration':return familyCompleteRegistration_(req);
    case 'familyResendVerification':return familyResendVerification_(req);
    case 'familyLogin':return familyLogin_(req);
    case 'familyLogout':return familyLogout_(req);
    case 'familyResetRequest':return familyResetRequest_(req);
    case 'familyResetConfirm':return familyResetConfirm_(req);
    case 'familyEmailChange':return familyEmailChange_(req);
    case 'familyHome':{var h=familyRequire_(req);return h.error?h:{ok:true,family:familyPublic_(h.account),children:familyChildren_(h.account,false),billing:familyBilling_(h.account,false)};}
    case 'familyData':{var d=familyChildRequire_(req);return d.error?d:parentDataForStudent_(d.student);}
    case 'familyPlanDecide':{var b=familyChildRequire_(req);return b.error?b:billingParentDecideForStudent_(b.student,req);}
    default:return familyError_('操作が見つかりません');
  }}catch(e){return familyError_('処理を完了できませんでした。入力を保持して再試行してください。登録済みの場合は確認メールを再発行できます');}
}

/* 通知には内部メモ・授業内容・認証秘密を保存しない。外部メールAPIは exactly-once にできないため、
 * 呼出前に uncertain とし、応答不明の自動再送を禁止する。認証リンク本文はメモリ内だけ。 */
function familyOutboxAdd_(key,a,studentId,kind,detail) {
  detail=detail||{};var matches=familyRows_('familyOutbox').filter(function(r){return String(r.eventKey)===String(key)&&String(r.familyId)===String(a.id);});
  if(matches.length>1)throw new Error('通知記録が重複しています');
  if(matches.length){var old=matches[0];if(String(old.studentId)!==String(studentId)||String(old.kind)!==String(kind)||String(old.ym)!==String(detail.ym||'')||String(old.revision)!==String(detail.revision==null?'':detail.revision))throw new Error('同じ通知IDの内容が異なります');return old;}
  var out={id:familyId_(),eventKey:String(key),familyId:a.id,studentId:String(studentId),kind:kind,ym:detail.ym||'',revision:detail.revision==null?'':detail.revision,email:detail.email||a.email,status:'pending',createdAt:familyStamp_(),sentAt:'',attempts:0,error:''};
  familyWrite_('familyOutbox',FAMILY_OUTBOX_COLS_,out);return out;
}
function familyTestAccount_(a) {
  var children=familyChildren_(a,true);return String(a.testOnly)==='true'||children.length>0&&children.every(function(c){return isTestStudent_({name:c.name});});
}
function familyMailQuota_() { return MailApp.getRemainingDailyQuota(); }
function familyDeliverMail_(to,subject,body,a) {
  // テストfamilyへの実メールは禁止。検証はこの境界を架空サービスに差し替える。
  if(familyTestAccount_(a))return 'suppressed';
  MailApp.sendEmail({to:to,subject:subject,body:body,name:'ステップワイズ英数教室'});return 'sent';
}
function familyDeliverOutbox_(out,a,subject,body,authMail) {
  if(['pending','failed'].indexOf(String(out.status))<0)return out;
  if(!authMail&&(a.status!=='active'||!a.verifiedAt||String(a.email)!==String(out.email)||!familyChildren_(a,false).some(function(s){return s.studentId===String(out.studentId);}))) {
    out.status='cancelled';out.error='送信先または生徒との紐付けが変更されました';familyWrite_('familyOutbox',FAMILY_OUTBOX_COLS_,out);return out;
  }
  if(!familyTestAccount_(a)&&familyMailQuota_()<1){out.status='failed';out.error='メール送信上限のため未送信です';familyWrite_('familyOutbox',FAMILY_OUTBOX_COLS_,out);return out;}
  out.status='uncertain';out.attempts=Number(out.attempts||0)+1;out.error='送信結果が未確認です。二重送信を避けるため自動再送しません';familyWrite_('familyOutbox',FAMILY_OUTBOX_COLS_,out);
  try {
    var result=familyDeliverMail_(String(out.email),subject,body,a);
    out.status=result==='suppressed'?'suppressed':'sent';out.sentAt=familyStamp_();out.error=result==='suppressed'?'テスト用のため実メール送信を省略しました':'';
    familyWrite_('familyOutbox',FAMILY_OUTBOX_COLS_,out);
  } catch(e) { out.status='uncertain';out.sentAt='';out.error='送信結果が未確認です。二重送信を避けるため自動再送しません'; /* 例外本文は認証リンク等を含み得るため保存しない。 */ }
  return out;
}
function familyBusinessMail_(out) {
  var text={planProposed:'月の回数・料金の確認依頼があります。',invoiceCreated:'月謝の請求内容を記録しました。',invoiceVoided:'月謝の請求を取り消しました。'}[String(out.kind)];
  if(!text)throw new Error('通知種類が不明です');
  return {subject:'【ステップワイズ】'+(out.ym?out.ym+' ':'')+'保護者ページのお知らせ',body:text+'\n保護者ページにログインし、お子さまを選んで内容をご確認ください。\n\n'+FAMILY_PORTAL_URL_};
}
function familyNotifySafe_(kind,studentId,eventKey,detail) {
  try {
    if(['planProposed','invoiceCreated','invoiceVoided'].indexOf(kind)<0)return {ok:false};
    var matches=familyRows_('familyAccounts').filter(function(a){return a.status==='active'&&a.verifiedAt&&familyChildren_(a,false).some(function(s){return s.studentId===String(studentId);});});
    var states=[];matches.forEach(function(a){var out=familyOutboxAdd_(eventKey,a,String(studentId),kind,detail),mail=familyBusinessMail_(out);states.push(familyDeliverOutbox_(out,a,mail.subject,mail.body,false).status);});
    return {ok:true,statuses:states};
  }catch(e){return {ok:false,warning:'保護者通知の記録を確認してください'};}
}
// Group membership only: filter links before building student/group details.
function familyGroups_(studentId) {
  var links=familyRows_('familyLinks'), members=Object.create(null);
  links.forEach(function(l){if(String(l.active)!=='true')return;var key=String(l.familyId),id=String(l.studentId);var ids=members[key]||(members[key]=[]);if(ids.indexOf(id)>=0)throw new Error('家族と生徒の紐付けが重複しています');ids.push(id);});
  var eligible=Object.keys(members).filter(function(id){return studentId?members[id].indexOf(String(studentId))>=0:members[id].length>=2;});
  var students=readRows_('students').map(function(s){return {id:String(s.id),name:String(s.name),active:String(s.active)!=='false'};}),byId=Object.create(null);
  students.forEach(function(s){byId[s.id]=s;});
  var groups=familyRows_('familyAccounts').filter(function(a){return eligible.indexOf(String(a.id))>=0;}).map(function(a){return {id:String(a.id),label:String(a.label),status:String(a.status),children:members[String(a.id)].filter(function(id){return !!byId[id];}).map(function(id){var s=byId[id];return {studentId:s.id,name:s.name,active:s.active};})};});
  return {ok:true,families:groups,students:students};
}
function familyList_() {
  var families=familyRows_('familyAccounts').map(familyView_),names={};families.forEach(function(a){names[a.id]=a.label;});
  return {ok:true,families:families,students:readRows_('students').map(function(s){return {id:String(s.id),name:String(s.name),active:String(s.active)!=='false'};}),notifications:familyRows_('familyOutbox').slice(-100).reverse().map(function(r){
    return {id:String(r.id),familyId:String(r.familyId),label:names[r.familyId]||'',studentId:String(r.studentId),kind:String(r.kind),ym:String(r.ym),status:String(r.status),createdAt:String(r.createdAt),sentAt:String(r.sentAt),error:String(r.error),retryable:['pending','failed'].indexOf(String(r.status))>=0&&['planProposed','invoiceCreated','invoiceVoided'].indexOf(String(r.kind))>=0};
  })};
}
function familySetChildren_(a,ids) {
  if(!Array.isArray(ids)||ids.length>20||ids.some(function(id){return typeof id!=='string';})||new Set(ids).size!==ids.length)return familyError_('紐付ける在籍生徒を確認してください');
  if(ids.some(function(id){return familyStudentGroups_(id).some(function(l){return String(l.familyId)!==String(a.id);});}))return familyError_('別のグループに所属しています。グループの移動を使ってください');
  var links=familyRows_('familyLinks').filter(function(l){return String(l.familyId)===String(a.id);}),seen={};
  links.forEach(function(l){if(seen[l.studentId])throw new Error('家族と生徒の紐付けが重複しています');seen[l.studentId]=true;});
  // 停止中の子は既存リンクの保持だけ許可。新たに紐付けたり、解除後に戻したりはしない。
  if(ids.some(function(id){return !findStudent_(id)&&!(systemStudent_(id)&&links.some(function(l){return String(l.studentId)===id&&String(l.active)==='true';}));}))return familyError_('停止中の生徒を新たに紐付けることはできません');
  // リンク書き込みが途中で止まっても、旧セッションで追加された子を見られないよう先に失効する。
  familyInvalidate_(a);familySave_(a);
  links.forEach(function(l){var active=ids.indexOf(String(l.studentId))>=0;if(String(l.active)!==String(active)){l.active=active;l.updatedAt=familyStamp_();familyWrite_('familyLinks',FAMILY_LINK_COLS_,l);}});
  ids.forEach(function(id){if(!seen[id])familyWrite_('familyLinks',FAMILY_LINK_COLS_,{id:familyId_(),familyId:a.id,studentId:id,active:true,linkedAt:familyStamp_(),updatedAt:familyStamp_()});});
  return {ok:true,family:familyView_(a)};
}
// A student belongs to one group. Existing ambiguous links are never guessed.
function familyStudentGroups_(id) {return familyRows_('familyLinks').filter(function(l){return String(l.studentId)===String(id)&&String(l.active)==='true';});}
function familyEnsureGroup_(id) {
  var student=findStudent_(id);if(!student)return familyError_('利用中の生徒を選んでください');
  var links=familyStudentGroups_(id);if(links.length>1)return familyError_('複数のグループに所属しています。既存の紐付けを確認してください');
  if(links.length){var current=familyAccount_(links[0].familyId);return current?{ok:true,family:familyView_(current)}:familyError_('グループ情報を確認してください');}
  // Recover an interrupted draft by a student-derived identifier, never by a name.
  var label=student.name+'さんのグループ',draftId=parentDigest_('singleton-group',String(id),'').slice(0,32),a=familyAccount_(draftId);
  if(a&&(a.passHash||familyRows_('familyLinks').some(function(l){return l.familyId===a.id;})))a=null;
  if(!a){a={id:familyAccount_(draftId)?familyId_():draftId,label:label,status:'pending',createdAt:familyStamp_(),securityVersion:0,testOnly:isTestStudent_(student)};familySave_(a);}
  return familySetChildren_(a,[String(id)]);
}
function familyRetireEmptySource_(sourceId,studentId) {
  var source=familyAccount_(String(sourceId||'')),links=familyRows_('familyLinks');
  if(source&&links.some(function(l){return l.familyId===source.id&&String(l.studentId)===studentId;})&&!links.some(function(l){return l.familyId===source.id&&String(l.active)==='true';})){
    familyInvalidate_(source);source.status='disabled';source.inviteHash='';source.inviteExpiresAt='';familySave_(source);
  }
}
function familyMoveStudent_(req) {
  var id=String(req.studentId||''),target=familyAccount_(String(req.familyId||'')),links=familyStudentGroups_(id);
  if(!findStudent_(id)||!target||target.status==='disabled')return familyError_('移動先と生徒を確認してください');
  if(links.length>1)return familyError_('既存の重複グループを確認してください');
  if(links.length&&String(links[0].familyId)===String(target.id)){if(String(req.sourceFamilyId)!==String(target.id))familyRetireEmptySource_(req.sourceFamilyId,id);return {ok:true,family:familyView_(target),replayed:true};}
  if(links.length&&String(links[0].familyId)!==String(req.sourceFamilyId||''))return familyError_('所属が変わりました。一覧を更新して確認してください');
  var ids=familyRows_('familyLinks').filter(function(l){return l.familyId===target.id&&String(l.active)==='true';}).map(function(l){return String(l.studentId);});
  if(ids.length>=20)return familyError_('グループは20人以内にしてください');
  var source=links.length?familyAccount_(links[0].familyId):null;
  // Revoke both groups first; detach before attaching so failure never broadens access.
  familyInvalidate_(target);familySave_(target);
  if(source){familyInvalidate_(source);familySave_(source);var link=links[0];link.active=false;link.updatedAt=familyStamp_();familyWrite_('familyLinks',FAMILY_LINK_COLS_,link);}
  var result=familySetChildren_(target,ids.concat([id]));if(result.error)return result;
  familyRetireEmptySource_(source?source.id:req.sourceFamilyId,id);
  return result;
}
function familyAdmin_(req) {
  if(authMode_()!=='account'||!tokenOk_(req.token))return {error:'先生アカウントでログインし直してください',badAuth:true};
  if(req.op==='familyList')return req.view==='groups'?familyGroups_(String(req.studentId||'')):familyList_();
  if(req.op==='familyEnsureGroup'){var ensured=familyEnsureGroup_(String(req.studentId||''));if(ensured.error)return ensured;return familyInvite_(familyAccount_(ensured.family.id));}
  if(req.op==='familyMoveStudent')return familyMoveStudent_(req);
  if(req.op==='familyCreate'){
    var label=String(req.label||'').trim();if(!label||label.length>80)return familyError_('家族の表示名は1〜80文字で入力してください');
    if(!Array.isArray(req.studentIds)||!req.studentIds.length||req.studentIds.length>20||req.studentIds.some(function(id){return typeof id!=='string'||!findStudent_(id);})||new Set(req.studentIds).size!==req.studentIds.length)return familyError_('紐付ける在籍生徒を確認してください');
    if(req.studentIds.some(function(id){return familyStudentGroups_(id).length;}))return familyError_('所属済みです。グループの移動を使ってください');
    var created={id:familyId_(),label:label,status:'pending',createdAt:familyStamp_(),securityVersion:0,testOnly:req.studentIds.every(function(id){return isTestStudent_(findStudent_(id));})};familySave_(created);
    var linked=familySetChildren_(created,req.studentIds);if(linked.error)return linked;return familyInvite_(created);
  }
  if(req.op==='familyRetryNotifications'){
    if(!Array.isArray(req.ids)||req.ids.length>10||req.ids.some(function(id){return typeof id!=='string';}))return familyError_('再送する通知を10件以内で選択してください');
    var outboxes=familyRows_('familyOutbox');
    for(var i=0;i<req.ids.length;i++){
      var out=outboxes.filter(function(r){return String(r.id)===req.ids[i];})[0];
      if(!out||['pending','failed'].indexOf(String(out.status))<0||['planProposed','invoiceCreated','invoiceVoided'].indexOf(String(out.kind))<0)return familyError_('未送信と確認できた業務通知だけ再送できます。認証メールは保護者から再発行してください');
    }
    req.ids.forEach(function(id){var out=outboxes.filter(function(r){return String(r.id)===id;})[0],a=familyAccount_(out.familyId);if(a){var mail=familyBusinessMail_(out);familyDeliverOutbox_(out,a,mail.subject,mail.body,false);}});return familyList_();
  }
  var a=familyAccount_(String(req.familyId||''));if(!a)return familyError_('家族が見つかりません');
  if(req.op==='familySetChildren')return familySetChildren_(a,req.studentIds);
  if(req.op==='familyInvite')return familyInvite_(a);
  if(req.op==='familySetActive'){
    if(typeof req.active!=='boolean')return familyError_('利用状態を確認してください');
    familyInvalidate_(a);a.status=req.active?(a.verifiedAt&&a.passHash?'active':'pending'):'disabled';a.inviteHash='';a.inviteExpiresAt='';familySave_(a);return {ok:true,family:familyView_(a)};
  }
  return familyError_('操作が見つかりません');
}
