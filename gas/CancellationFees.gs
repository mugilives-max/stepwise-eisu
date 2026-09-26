/* Cancellation charges are separate from performed lessons. Amounts are frozen before cancellation. */
var CANCEL_FEE_COLS_=['id','studentId','slotId','status','decisionJson','createdAt'];
function cancelDeadline_(slot){return Date.parse(slot.date+'T23:00:00+09:00')-86400000;}
function cancelFeeRows_(){return readRows_('cancellationFees');}
function cancelFeeWrite_(row){
 var sh=billingEnsureColumns_(ss_(),'cancellationFees',CANCEL_FEE_COLS_),rows=cancelFeeRows_(),i=rows.findIndex(function(x){return x.id===row.id;});
 sh.getRange(i<0?sh.getLastRow()+1:i+2,1,1,CANCEL_FEE_COLS_.length).setNumberFormat('@').setValues([CANCEL_FEE_COLS_.map(function(k){return row[k]||'';})]);memoClear_();
}
function cancelQuote_(req){
 var r=findSlotRow_(req.slotId),s=r&&r.slot;
 if(!s||String(s.studentId)!==String(req.studentId)||s.status!=='booked'||String(s.done)==='true')return billingError_('未実施の確定授業を選んでください');
 var q=parseReq_(s.req),source=String(req.source||(q?'request':'teacher')),received=q&&(q.receivedAt||q.at),now=Date.now(),start=Date.parse(s.date+'T'+s.start+':00+09:00');
 if(['request','external','noshow','teacher'].indexOf(source)<0)return billingError_('連絡方法を選んでください');
 if(source==='request'&&!received)return billingError_('取消申請が見つかりません。外部連絡の日時を入力してください');
 if(source==='external')received=String(req.receivedAt||'');
 if(source==='noshow'){if(now<start)return billingError_('授業開始前は無断欠席として登録できません');received=new Date(start).toISOString();}
 if(source==='teacher')received=new Date(start).toISOString();
 if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(received))received=received.replace(' ','T')+':00+09:00';
 var at=Date.parse(received);if(!isFinite(at)||source!=='teacher'&&at>now)return billingError_('実際に連絡を受けた日時を入力してください');
 var type=source==='teacher'?'teacher':at<=cancelDeadline_(s)?'free':at<start?'late':'noshow',amount=type==='late'?1000:0,rate=0;
 if(type==='noshow'){
  var lines=planLinesFor_(String(s.studentId)),line=(planAssign_(lines,planStudentSlots_(String(s.studentId)))[String(s.id)]||{}).line;
  if(!line)return billingError_('授業料相当額の算定には、この授業に対応する承認済みの授業計画が必要です');
  rate=Number(line.rate30);amount=Math.round(Number(s.min)/30*rate);
 }
 var quote={policy:'previous-day-23-v1',slot:slotCancellationSnapshot_(s),source:source,receivedAt:source==='teacher'?'':new Date(at).toISOString(),deadlineAt:new Date(cancelDeadline_(s)).toISOString(),type:type,amount:amount,rate30:rate,lineId:typeof line!=='undefined'&&line?line.id:'',lineRevision:typeof line!=='undefined'&&line?line.revision:0};
 return {ok:true,history:cancelFeeHistory_(String(s.studentId)),quote:quote,signature:schedulingHash_(JSON.stringify(quote))};
}
function cancelFeePrepare_(req,w){
 var old=cancelFeeRows_().filter(function(x){return x.id===w.id;})[0];
 if(old){var d=JSON.parse(old.decisionJson);if(JSON.stringify(d.quote.slot)!==w.beforeJson)return billingError_('授業が変更されています。取消内容を確認してください','conflict');if(!cancelFeeRetryMatches_(req,d))return billingError_('同じ取消内容で再送してください','conflict');return {ok:true};}
 var result=cancelQuote_(req);if(result.error)return result;
 var q=result.quote,choice=req.feeChoice||(q.amount===0?'charge':''),note=String(req.note||'').trim();
 if(req.cancelSignature&&req.cancelSignature!==result.signature)return billingError_('授業または料金が変わりました。内容を再確認してください','conflict');
 if(['charge','waive','adjust'].indexOf(choice)<0||q.amount>0&&!req.cancelSignature)return billingError_('キャンセル料を確認して請求・免除を選んでください','feeDecisionRequired');
 var amount=choice==='waive'?0:choice==='adjust'?Number(req.feeAmount):q.amount;
 if(choice==='adjust'&&(req.feeAmount===undefined||req.feeAmount===null||String(req.feeAmount).trim()===''||!isFinite(amount)||Math.floor(amount)!==amount||amount<0||amount>q.amount))return billingError_('請求額は0円から規定額までの整数で入力してください');
 if((choice==='waive'||choice==='adjust'||q.source==='external'||q.source==='noshow'||q.source==='teacher')&&!note)return billingError_('免除理由・連絡方法などを入力してください');
 if(note.length>1000)return billingError_('理由は1000文字以内で入力してください');
 var d={signature:result.signature,choice:choice,note:note,quote:q,amount:amount,requestReason:String(parseReq_(q.slot.req)&&parseReq_(q.slot.req).reason||'')};
 cancelFeeWrite_({id:w.id,studentId:w.studentId,slotId:w.slotId,status:'pending',decisionJson:JSON.stringify(d),createdAt:new Date().toISOString()});return {ok:true};
}
function cancelFeeConfirm_(w){var row=cancelFeeRows_().filter(function(x){return x.id===w.id;})[0];if(row&&row.status==='pending'){row.status='confirmed';cancelFeeWrite_(row);}}
function cancelFeeItems_(sid){return cancelFeeRows_().filter(function(x){return String(x.studentId)===String(sid)&&x.status==='confirmed';}).map(function(x){var d=JSON.parse(x.decisionJson),s=d.quote.slot;return {id:'cancel-fee:'+x.id,type:'cancellation',date:s.date,start:s.start,subject:s.subject,min:0,amount:d.amount,reason:d.note,waived:d.amount===0,receivedAt:d.quote.receivedAt};});}
function cancelFeeOpen_(sid,ym){var inv=billingInvoicedIds_(sid);return cancelFeeItems_(sid).filter(function(x){return x.amount>0&&x.date.slice(0,7)<=ym&&!inv.ids[x.id];});}

function cancelFeeRetryMatches_(req,d){return (d.choice!=='adjust'||req.feeAmount!==undefined&&req.feeAmount!==null&&String(req.feeAmount).trim()!==''&&Number(req.feeAmount)===d.amount)&&(!req.cancelSignature||req.cancelSignature===d.signature)&&(!req.feeChoice||req.feeChoice===d.choice)&&String(req.note||'').trim()===d.note&&(!req.source||req.source===d.quote.source)&&(!req.receivedAt||Date.parse(req.receivedAt)===Date.parse(d.quote.receivedAt))&&(!d.quote.amount||!!req.cancelSignature);}

function cancelFeeHistory_(sid){
 var month=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM'),items=cancelFeeRows_().filter(function(r){return String(r.studentId)===sid&&r.status==='confirmed';}).map(function(r){var d=JSON.parse(r.decisionJson),s=d.quote.slot,request=parseReq_(s.req);return {date:s.date,start:s.start,subject:s.subject,amount:d.amount,reason:d.note||'',requestReason:d.requestReason||(request&&request.reason)||'',source:d.quote.source};}).sort(function(a,b){return (b.date+b.start).localeCompare(a.date+a.start);});
 return {month:month,count:items.filter(function(x){return x.date.slice(0,7)===month&&x.source!=='teacher';}).length,items:items};
}

// Read-only history: never reinsert cancellations into billable/recordable slots.
function cancelAttendance_(sid){return cancelFeeRows_().filter(function(r){return r.status==='confirmed'&&(!sid||String(r.studentId)===String(sid));}).map(function(r){var d=JSON.parse(r.decisionJson),s=d.quote.slot;return {id:r.id,studentId:String(r.studentId),studentName:studentName_(r.studentId),date:s.date,start:s.start,min:Number(s.min),subject:s.subject,label:d.quote.source==='teacher'?'休講':'欠席',amount:d.amount,reason:d.note||d.requestReason||'',source:d.quote.source};});}

function cancelCalendar_(sid){return cancelFeeRows_().filter(function(r){return r.status==='confirmed'&&String(r.studentId)===String(sid);}).map(function(r){var d=JSON.parse(r.decisionJson),x=d.quote.slot;return {id:r.id,date:x.date,start:x.start,min:Number(x.min),subject:x.subject,st:'cancelled',amount:d.amount,standardAmount:d.quote.amount,receivedAt:d.quote.source==='noshow'?'':d.quote.receivedAt,source:d.quote.source,confirmed:!!d.acknowledgedAt};});}
function cancelAcknowledge_(req){var me=findStudentByCode_(req.k);if(!me)return {error:'専用リンクから開き直してください',badCode:true};var r=cancelFeeRows_().filter(function(x){return x.id===String(req.cancellationId)&&String(x.studentId)===String(me.id)&&x.status==='confirmed';})[0];if(!r)return {error:'キャンセル記録が見つかりません'};var d=JSON.parse(r.decisionJson),reason=String(req.reason||'').trim();if(reason.length>1000)return {error:'事情は1000文字以内で入力してください'};if(d.acknowledgedAt&&reason!==String(d.acknowledgementReason||''))return {error:'すでに確認済みです。追加の事情は先生への連絡からお知らせください'};if(!d.acknowledgedAt){if(reason){var slot=d.quote.slot;serviceMessageSend_({requestId:'cancel-'+schedulingHash_(r.id),category:'schedule',body:'キャンセルについての事情：'+slot.date+' '+slot.start+' '+slot.subject+'\n'+reason},{student:me,role:req.familyProxy?'parent':'student',senderId:'cancel-'+me.id});}d.acknowledgementReason=reason;d.acknowledgedAt=new Date().toISOString();d.acknowledgedBy=req.familyProxy?'parent':'student';r.decisionJson=JSON.stringify(d);cancelFeeWrite_(r);}return {ok:true,state:studentState_(req.k)};}
