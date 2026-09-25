// A receipt is saved before acceptance, so retries cannot lose who registered a lesson.
var TEACHER_BOOKING_COLS_=["slotId", "studentId", "requestId", "snapshotJson", "createdAt", "response", "responseSnapshotJson", "responseNote", "respondedBy", "updatedAt"];
function teacherBookingRow_(id){return readRows_('teacherBookings').filter(function(r){return String(r.slotId)===String(id);})[0];}
function teacherBookingSave_(r){var rows=readRows_('teacherBookings'),i=rows.findIndex(function(x){return String(x.slotId)===String(r.slotId);});sheet_('teacherBookings').getRange(i<0?rows.length+2:i+2,1,1,TEACHER_BOOKING_COLS_.length).setValues([TEACHER_BOOKING_COLS_.map(function(k){return billingText_(r[k]||'');})]);memoClear_();}
function teacherBookingInfo_(s){
 if(['booked','offered'].indexOf(s.status)<0)return null;var r=teacherBookingRow_(s.id);if(!r||String(r.studentId)!==String(s.studentId))return null;
 var snapshot=schedulingSnapshot_(s),same=r.responseSnapshotJson===JSON.stringify(snapshot),unfinished=readRows_('acceptWrites').some(function(w){return String(w.studentId)===String(s.studentId)&&String(w.requestId)==='teacher-'+r.requestId&&w.status!=='done';});
 return {previous:String(r.requestId).indexOf('edit-')===0?JSON.parse(r.snapshotJson):null,requestId:r.requestId,status:s.status==='offered'||unfinished?'registering':same&&r.response?r.response:'pending',note:same?String(r.responseNote||''):'',snapshot:snapshot,revision:String(r.updatedAt||''),respondedBy:same?String(r.respondedBy||''):''};
}
function teacherBook_(req){
 var student=findStudent_(String(req.studentId||'')),row=findSlotRow_(String(req.slotId||''));
 if(!student||!student.code||!row||String(row.slot.studentId)!==String(student.id))return schedulingError_('対象の生徒・授業を確認してください','notFound');
 var id=String(req.requestId||'');if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))return schedulingError_('処理番号を確認してください');
 var receipt=teacherBookingRow_(row.slot.id);
 if(receipt&&receipt.requestId!==id)return schedulingError_('登録状況が変わっています。画面を更新してください','conflict');
 if(!receipt){
  if(row.slot.status!=='offered'||!schedulingExpectedMatches_(req.expectedSnapshot,row.slot))return schedulingError_('案内が変更されています。画面を更新してください','conflict');
  var gate=schedulingBatchGate_([row.slot],readRows_('slots'));if(gate)return gate;
  receipt={slotId:String(row.slot.id),studentId:String(student.id),requestId:id,snapshotJson:JSON.stringify(schedulingSnapshot_(row.slot)),createdAt:billingStamp_(),updatedAt:billingId_()};teacherBookingSave_(receipt);
 }
 var result=schedulingAcceptMany_({k:student.code,slotIds:[String(row.slot.id)],requestId:'teacher-'+id,expectedSnapshots:[JSON.parse(receipt.snapshotJson)]},true);
 if(!result.ok)return {error:result.error||'確定処理を確認しています。同じ内容で再試行してください',errorCode:result.errorCode||'pending',pending:!!result.pending};
 return {ok:true,admin:adminState_(),notificationWarning:result.warning||''};
}
function teacherBookingRespond_(req){
 var student=findStudentByCode_(req.k),row=findSlotRow_(String(req.slotId||''));
 if(!student||!row||String(row.slot.studentId)!==String(student.id))return schedulingError_('対象の授業を確認してください','notFound');
 var info=teacherBookingInfo_(row.slot),r=teacherBookingRow_(row.slot.id),response=String(req.response||''),note=String(req.note||'').trim();
 if(row.slot.status!=='booked'||!info||info.requestId!==req.requestId||!schedulingExpectedMatches_(req.expectedSnapshot,row.slot))return schedulingError_('授業内容が変わっています。画面を更新してください','conflict');
 if(['confirmed','correction'].indexOf(response)<0||note.length>500||(response==='correction'&&!note))return schedulingError_('修正してほしい内容を500文字以内で入力してください');
 if(info.status===response&&info.note===note)return {ok:true,state:studentState_(req.k)};
 if(info.status!=='pending'||info.revision!==req.expectedRevision)return schedulingError_('すでに回答されています。画面を更新してください','conflict');
 r.response=response;r.responseNote=note;r.responseSnapshotJson=JSON.stringify(schedulingSnapshot_(row.slot));r.respondedBy=req.familyProxy?'parent':'student';r.updatedAt=billingId_();teacherBookingSave_(r);
 return {ok:true,state:studentState_(req.k)};
}

function teacherBookingEdited_(write,before,after){
 var old=teacherBookingRow_(write.slotId),id='edit-'+write.id;
 if(old&&old.requestId===id)return;
 teacherBookingSave_({slotId:String(write.slotId),studentId:String(write.studentId),requestId:id,snapshotJson:JSON.stringify(schedulingSnapshot_(before.slot)),createdAt:billingStamp_(),updatedAt:billingId_()});
}
