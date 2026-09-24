// Explicit parent name parts; never derive them from the group label.
var FAMILY_PROFILE_COLS_=['id','familyName','givenName'];
function familyProfile_(id){var sh=ss_().getSheetByName('familyProfiles');return sh?(readRows_('familyProfiles').filter(function(r){return String(r.id)===String(id);})[0]||{}):{};}
function familyProfileSave_(req){
 var auth=familyRequire_(req);if(auth.error)return auth;
 var id=String(req.studentId||''),kind=String(req.kind||'');
 var child=id?familyChildRequire_(req):null;if(child&&child.error)return child;
 if(kind==='email'){
  if(!child)return familyError_('生徒を選んでください');
  if(studentEmailVerifiedAddress_(child.student.id))return familyError_('メールアドレスは登録済みです。再読み込みしてください');
  return studentEmailRequest_({k:String(child.student.code),email:req.email},false);
 }
 if(kind!=='name')return familyError_('入力項目を確認してください');
 var f=String(req.familyName||'').trim(),g=String(req.givenName||'').trim();
 if(!f||!g||f.length>80||g.length>80||/[\x00-\x1f]/.test(f+g)||/^[=+@-]/.test(f)||/^[=+@-]/.test(g))return familyError_('姓と名を両方入力してください（各80文字以内）');
 var current=child?studentNameParts_(child.student.id):familyProfile_(auth.account.id);
 if((current.familyName&&current.familyName!==f)||(current.givenName&&current.givenName!==g))return familyError_('登録内容が更新されています。再読み込みしてください');
 if(child){var result=saveStudentNameParts_(child.student,f,g);if(result.error)return result;}
 else {var sh=ensureSheet_(ss_(),'familyProfiles',FAMILY_PROFILE_COLS_),rows=readRows_('familyProfiles'),index=-1;rows.forEach(function(r,i){if(String(r.id)===String(auth.account.id))index=i;});var values=[String(auth.account.id),f,g].map(billingText_);if(index<0)sh.appendRow(values);else sh.getRange(index+2,1,1,3).setValues([values]);memoClear_();}
 return {ok:true,family:familyPublic_(auth.account),children:familyChildren_(auth.account,false)};
}
