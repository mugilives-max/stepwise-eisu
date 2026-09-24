// Missing records retain existing student permissions.
var STUDENT_PERMISSION_KEYS_=['booking','reschedule','request','availability','events','email'];
var STUDENT_PERMISSION_COLS_=['studentId','booking','reschedule','request','availability','events','email','revision'];
function studentPermissionRow_(id){return ss_().getSheetByName('studentPermissions')?(readRows_('studentPermissions').filter(function(r){return String(r.studentId)===String(id);})[0]||{}):{};}
function studentPermissions_(id){var r=studentPermissionRow_(id),p={};STUDENT_PERMISSION_KEYS_.forEach(function(k){p[k]=String(r[k])!=='0';});return p;}
function studentPermissionDenied_(id,key){return studentPermissions_(id)[key]===false?{error:'この操作は保護者のみ行えます。保護者にご相談ください。',errorCode:'studentPermissionDenied',permission:key}:null;}
function familyPermissionsSave_(req){var a=familyChildRequire_(req);if(a.error)return a;var key=String(req.permission||'');if(STUDENT_PERMISSION_KEYS_.indexOf(key)<0||typeof req.allowed!=='boolean'||!Number.isInteger(req.expectedRevision))return familyError_('権限の設定内容を確認してください');var old=studentPermissionRow_(a.student.id),rev=Number(old.revision)||0;if(req.expectedRevision!==rev)return {error:'権限が更新されています。ページを再読み込みしてください',errorCode:'conflict'};var p=studentPermissions_(a.student.id);p[key]=req.allowed;var sh=ensureSheet_(ss_(),'studentPermissions',STUDENT_PERMISSION_COLS_),rows=readRows_('studentPermissions'),i=rows.findIndex(function(r){return String(r.studentId)===String(a.student.id);}),values=[String(a.student.id)].concat(STUDENT_PERMISSION_KEYS_.map(function(k){return p[k]?'1':'0';})).concat([String(rev+1)]);sh.getRange(i<0?sh.getLastRow()+1:i+2,1,1,values.length).setValues([values]);memoClear_();return {ok:true,studentId:String(a.student.id),permissions:p,permissionsRevision:rev+1};}
function studentPermissionGate_(req){if(!req.k)return null;var act=String(req.action||''),s=findStudentByCode_(String(req.k||''));if(!s)return null;var key='';
 if(act==='accept'||act==='acceptMany')key='booking';
 else if(act==='decline'||act==='cancelReq')key='reschedule';
 else if(act==='wish'||act==='wishMany')key=req.kind==='want'?'request':'availability';
 else if(act==='unwish'){var w=readRows_('wishes').filter(function(r){return String(r.id)===String(req.wishId)&&String(r.studentId)===String(s.id);})[0];key=w&&w.kind==='want'?'request':'availability';}
 else if(['block','unblock','blockSet'].indexOf(act)>=0)key='availability';
 else if(['eventAdd','eventAddMany','eventDel'].indexOf(act)>=0){key='events';if(req.alsoBlock){var denied=studentPermissionDenied_(s.id,'availability');if(denied)return denied;}}
 else if(['studentEmailRequest','studentEmailResend','studentEmailRemove'].indexOf(act)>=0)key='email';
 return key?studentPermissionDenied_(s.id,key):null;
}
