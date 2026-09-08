/* Local additions: authenticated exam PDFs, one private note, message inbox and cancellation receipts.
 * MCP/scheduled consumers are deliberately not exposed. All dispatch runs under doPost's ScriptLock.
 */
var SERVICE_COLS_={
  examReports:['id','studentId','date','kind','title','reflection','analysis','nextSteps','teacherNote','fileId','fileName','fileHash','revision','requestId','payloadHash','updatedAt'],
  contactMessages:['id','studentId','senderRole','senderId','body','category','replyTo','receivedAt','status','reply','revision','updatedAt'],
  cancellationRequests:['id','studentId','slotId','receivedAt','deadlineAt','requestType','reason','senderRole','senderId','slotJson','status','decidedAt']
};
function serviceEnsure_(name){
  var cols=SERVICE_COLS_[name];if(!cols)throw Error('Unknown service sheet');
  var sh=ss_().getSheetByName(name);
  if(sh&&sh.getLastRow()&&JSON.stringify(sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0])!==JSON.stringify(cols))throw Error(name+'の列構成を確認してください');
  return ensureSheet_(ss_(),name,cols);
}
function serviceRows_(name){return readRows_(name);}
function serviceWrite_(name,row){
  var sh=serviceEnsure_(name),cols=SERVICE_COLS_[name],rows=serviceRows_(name),i=rows.findIndex(function(x){return String(x.id)===String(row.id);});
  sh.getRange(i<0?sh.getLastRow()+1:i+2,1,1,cols.length).setNumberFormat('@').setValues([cols.map(function(k){return billingText_(String(row[k]===undefined?'':row[k]));})]);
  memoClear_();return row;
}
function serviceText_(v,max,required){var s=String(v===undefined?'':v).trim();if(s.length>max||required&&!s)throw Error('入力内容を確認してください（最大'+max+'文字）');return s;}
function serviceId_(v){var s=String(v||'');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(s))throw Error('処理IDを確認してください');return s;}
function servicePublicAuth_(req){
  var auth;if(req.ftoken){auth=familyChildRequire_(req);if(!auth.error)return {student:auth.student,role:'parent',senderId:String(auth.account.id)};return auth;}
  if(req.ptoken){auth=parentRequire_(req);if(!auth.error)return {student:auth.student,role:'parent',senderId:'legacy:'+auth.student.id};return auth;}
  var s=findStudentByCode_(req.k);return s?{student:s,role:'student',senderId:String(s.id)}:{error:'ログインまたは専用リンクを確認してください'};
}
function servicePublic_(req){
  var auth=servicePublicAuth_(req);if(auth.error)return auth;
  if(req.studentId&&String(req.studentId)!==String(auth.student.id))return {error:'対象の生徒が一致しません'};
  var sid=String(auth.student.id);
  switch(req.op){
    case 'list':return serviceList_(sid,false);
    case 'pdf':return servicePdfGet_(req,sid);
    case 'messageSend':return serviceMessageSend_(req,auth);
    case 'cancelRequest':return serviceCancelRequest_(req,auth);
    default:return {error:'この操作は利用できません'};
  }
}
function serviceAdmin_(req){
  // Second guard: never permit editor helpers or future MCP dispatch to bypass teacher auth.
  if(authMode_()!=='account'||!tokenOk_(req.token)||req.mcpKey!==undefined)return {error:'先生のログインを確認してください',badAuth:true};
  var sid=String(req.studentId||'');
  if(req.op==='serviceInbox')return {ok:true,messages:serviceRows_('contactMessages').map(function(m){return Object.assign({},m,{studentName:studentName_(m.studentId)});}).reverse()};
  if(!systemStudent_(sid))return {error:'生徒が見つかりません'};
  switch(req.op){
    case 'serviceList':return serviceList_(sid,true);
    case 'servicePdf':return servicePdfGet_(req,sid);
    case 'serviceExamSave':return serviceExamSave_(req,sid);
    case 'serviceMessageReply':return serviceMessageReply_(req,sid);
    default:return {error:'この操作は利用できません'};
  }
}
function serviceList_(sid,teacher){
  var exams=serviceRows_('examReports').filter(function(x){return String(x.studentId)===sid;}).map(function(x){
    var r={id:x.id,date:x.date,kind:x.kind,title:x.title,reflection:x.reflection,analysis:x.analysis,nextSteps:x.nextSteps,hasPdf:!!x.fileId,fileName:x.fileName,revision:Number(x.revision),updatedAt:x.updatedAt};if(teacher)r.teacherNote=x.teacherNote;return r;
  });
  var slots=readRows_('slots').filter(function(s){return String(s.studentId)===sid&&s.status==='booked'&&String(s.done)!=='true';}).map(function(s){return {id:String(s.id),date:s.date,start:s.start,subject:s.subject,req:parseReq_(s.req)};});
  return {ok:true,exams:exams.sort(function(a,b){return String(b.date).localeCompare(String(a.date));}),messages:serviceRows_('contactMessages').filter(function(x){return String(x.studentId)===sid;}).map(serviceMessageView_).reverse(),cancellations:serviceRows_('cancellationRequests').filter(function(x){return String(x.studentId)===sid;}).map(function(x){var s=JSON.parse(x.slotJson);return {id:x.id,slotId:x.slotId,date:s.date,start:s.start,receivedAt:x.receivedAt,deadlineAt:x.deadlineAt,requestType:x.requestType,reason:x.reason,status:x.status,decidedAt:x.decidedAt};}).reverse(),slots:slots};
}
function servicePdfFolder_(){
  var props=PropertiesService.getScriptProperties(),id=props.getProperty('EXAM_PDF_FOLDER_ID'),folder;
  if(id)folder=DriveApp.getFolderById(id);else{folder=DriveApp.createFolder('ステップワイズ_成績票_非公開');props.setProperty('EXAM_PDF_FOLDER_ID',folder.getId());}
  if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE||folder.getViewers().length||folder.getEditors().length)throw Error('成績票フォルダを先生だけがアクセスできる状態にしてください');
  return folder;
}
function servicePdfStore_(pdf,stable){
  if(!pdf||pdf.mime!=='application/pdf'||typeof pdf.base64!=='string'||pdf.base64.length>7000000||!pdf.base64.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(pdf.base64))throw Error('5MB以下のPDFを選んでください');
  var bytes=Utilities.base64Decode(pdf.base64);if(bytes.length>5*1024*1024||bytes.length<5||bytes.slice(0,5).map(function(b){return String.fromCharCode((b+256)%256);}).join('')!=='%PDF-')throw Error('PDFファイルを確認してください');
  var hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join(''),folder=servicePdfFolder_(),name=stable+'-'+hash+'.pdf',found=folder.getFilesByName(name),file;
  if(found.hasNext()){file=found.next();if(found.hasNext())throw Error('成績票の重複を確認してください');}else file=folder.createFile(Utilities.newBlob(bytes,'application/pdf',name));
  if(file.getSharingAccess()!==DriveApp.Access.PRIVATE||file.getViewers().length||file.getEditors().length)throw Error('成績票の共有設定を確認してください');
  return {fileId:file.getId(),fileName:serviceText_(pdf.name||'成績票.pdf',150,true),fileHash:hash};
}
function servicePdfGet_(req,sid){
  var row=serviceRows_('examReports').filter(function(x){return String(x.id)===String(req.id)&&String(x.studentId)===sid;})[0];
  if(!row||!row.fileId)return {error:'成績票が見つかりません'};
  var f=DriveApp.getFileById(row.fileId);if(f.getMimeType()!=='application/pdf'||f.getSize()>5*1024*1024)return {error:'PDFを確認してください'};
  return {ok:true,name:row.fileName,mime:'application/pdf',base64:Utilities.base64Encode(f.getBlob().getBytes())};
}
function serviceExamSave_(req,sid){
  var rid=serviceId_(req.requestId),id=req.id?serviceId_(req.id):'exam-'+schedulingHash_(sid+'|'+rid),old=serviceRows_('examReports').filter(function(x){return String(x.id)===id;})[0];
  if(old&&String(old.studentId)!==sid)return {error:'対象の生徒が一致しません'};
  var payload={date:serviceText_(req.date,10,true),kind:String(req.kind||'mock'),title:serviceText_(req.title,100,true),reflection:serviceText_(req.reflection,4000),analysis:serviceText_(req.analysis,4000),nextSteps:serviceText_(req.nextSteps,4000),teacherNote:serviceText_(req.teacherNote,4000),pdf:req.pdf||null};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)||isNaN(Date.parse(payload.date+'T00:00:00Z'))||new Date(payload.date+'T00:00:00Z').toISOString().slice(0,10)!==payload.date||['mock','school'].indexOf(payload.kind)<0)throw Error('試験の日付・種類を確認してください');
  var hash=schedulingHash_(JSON.stringify(payload));if(old&&old.requestId===rid){if(old.payloadHash!==hash)throw Error('同じ処理IDで内容を変更できません');return {ok:true,id:id,revision:Number(old.revision),replayed:true};}
  if(Number(req.expectedRevision||0)!==Number(old&&old.revision||0))return {error:'他の保存が先に行われました。最新の内容を確認してください',errorCode:'conflict'};
  var file=req.pdf?servicePdfStore_(req.pdf,id):{fileId:old&&old.fileId||'',fileName:old&&old.fileName||'',fileHash:old&&old.fileHash||''};delete payload.pdf;
  var row=Object.assign({id:id,studentId:sid},payload,file,{revision:Number(old&&old.revision||0)+1,requestId:rid,payloadHash:hash,updatedAt:new Date().toISOString()});
  serviceWrite_('examReports',row);return {ok:true,id:id,revision:row.revision};
}
function serviceMessageView_(m){return {id:m.id,body:m.body,category:m.category,replyTo:m.replyTo,receivedAt:m.receivedAt,status:m.status,reply:m.reply,revision:Number(m.revision),updatedAt:m.updatedAt,senderRole:m.senderRole};}
function serviceMessageSend_(req,auth){
  var sid=String(auth.student.id),rid=serviceId_(req.requestId),id='msg-'+schedulingHash_(sid+'|'+auth.senderId+'|'+rid),body=serviceText_(req.body,4000,true),category=String(req.category||'other'),replyTo=String(req.replyTo||''),rows=serviceRows_('contactMessages');
  if(['schedule','question','feedback','other'].indexOf(category)<0)throw Error('用件を選んでください');
  if(replyTo&&!rows.some(function(x){return x.id===replyTo&&String(x.studentId)===sid;}))throw Error('返信先を確認してください');
  var old=rows.filter(function(x){return x.id===id;})[0];if(old){if(old.body!==body||old.category!==category||old.replyTo!==replyTo)throw Error('再送内容が元の内容と異なります');return {ok:true,message:serviceMessageView_(old),replayed:true};}
  var stamp=new Date(req._receivedAt||Date.now()).toISOString(),row={id:id,studentId:sid,senderRole:auth.role,senderId:auth.senderId,body:body,category:category,replyTo:replyTo,receivedAt:stamp,status:'received',reply:'',revision:1,updatedAt:stamp};serviceWrite_('contactMessages',row);return {ok:true,message:serviceMessageView_(row)};
}
function serviceMessageReply_(req,sid){
  var row=serviceRows_('contactMessages').filter(function(x){return x.id===req.id&&String(x.studentId)===sid;})[0];if(!row)throw Error('メッセージが見つかりません');
  var status=String(req.status),reply=serviceText_(req.reply,4000);if(['received','needs_confirmation','registered','failed','closed'].indexOf(status)<0)throw Error('状態を確認してください');
  if(['needs_confirmation','registered','failed'].indexOf(status)>=0&&!reply)throw Error('確認事項または具体的な処理結果を入力してください');
  if(row.status===status&&row.reply===reply)return {ok:true,replayed:true};if(Number(req.expectedRevision)!==Number(row.revision))return {error:'最新の返信を確認してください',errorCode:'conflict'};
  row.status=status;row.reply=reply;row.revision=Number(row.revision)+1;row.updatedAt=new Date().toISOString();serviceWrite_('contactMessages',row);return {ok:true};
}
function serviceCancelRequest_(req,auth){
  var sid=String(auth.student.id),r=findSlotRow_(req.slotId),rid=serviceId_(req.requestId),id='cancel-'+schedulingHash_(sid+'|'+auth.senderId+'|'+rid),old=serviceRows_('cancellationRequests').filter(function(x){return x.id===id;})[0],reason=serviceText_(req.reason,1000,true);
  if(old&&(old.reason!==reason||String(old.slotId)!==String(req.slotId)))throw Error('再送内容が元の申請と異なります');
  if(old&&old.status!=='received')return {ok:true,cancellation:{id:old.id,receivedAt:old.receivedAt,requestType:old.requestType,status:old.status}};
  if(!r||r.slot.status!=='booked'||String(r.slot.studentId)!==sid||String(r.slot.done)==='true')return {error:'未実施の確定授業を選んでください'};
  var pending=schedulingPendingSlotMutation_(r.slot.id);if(pending)return pending;
  var current=parseReq_(r.slot.req);if(current&&current.id!==id)return {error:'この授業はすでに取消申請中です'};
  var row=old;
  if(!row){var now=req._receivedAt||Date.now(),deadline=Date.parse(r.slot.date+'T'+r.slot.start+':00+09:00')-CANCEL_DEADLINE_H*36e5;if(!isFinite(deadline))throw Error('授業日時を確認してください');
    row={id:id,studentId:sid,slotId:String(r.slot.id),receivedAt:new Date(now).toISOString(),deadlineAt:new Date(deadline).toISOString(),requestType:now<=deadline?'normal':'exception',reason:reason,senderRole:auth.role,senderId:auth.senderId,slotJson:JSON.stringify(slotCancellationSnapshot_(r.slot)),status:'received',decidedAt:''};serviceWrite_('cancellationRequests',row);
  }
  var original=JSON.parse(row.slotJson);if(original.date!==r.slot.date||original.start!==r.slot.start||Number(original.min)!==Number(r.slot.min))return {error:'授業日時が変更されました。最新の予定から再申請してください',errorCode:'conflict'};
  var obj={kind:'cancel',id:id,reason:row.reason,at:row.receivedAt,receivedAt:row.receivedAt,deadlineAt:row.deadlineAt,requestType:row.requestType};
  sheet_('slots').getRange(r.rowIndex,11).setNumberFormat('@').setValue(JSON.stringify(obj));memoClear_();
  // Teacher dashboard is the reliable notification surface; no extra email side effect on retries.
  return {ok:true,cancellation:{id:id,receivedAt:row.receivedAt,requestType:row.requestType,status:'received'}};
}
function serviceCancelDecided_(notice){
  var prior=parseReq_(JSON.parse(notice.beforeJson).req);if(!prior||!prior.id)return;
  var row=serviceRows_('cancellationRequests').filter(function(x){return x.id===prior.id;})[0];if(!row)return;
  var status=notice.operation==='cancelDeclined'?'rejected':'approved';if(row.status===status)return;row.status=status;row.decidedAt=new Date().toISOString();serviceWrite_('cancellationRequests',row);
}
