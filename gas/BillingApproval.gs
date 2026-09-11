/* 請求と入金。授業計画(案内)の行は PlanLines.gs。monthAgreements は旧: 月間承認(行への移行元として残す)。Code.gsと同じApps Scriptプロジェクトへ配置する。 */
var BILLING_AGREEMENT_COLS_ = ['id','studentId','ym','revision','status','planJson','rate30','monthly','proposedAt','approvedAt','approvedVia','consentDate','memo','updatedAt','lessonMin','approvedPlanJson'];
var BILLING_EVENT_COLS_ = ['id','studentId','ym','revision','event','recordedAt','consentDate','via','memo','snapshotJson'];
var BILLING_PAYMENT_COLS_ = ['年月','生徒ID','氏名','請求額','請求日','入金日','入金方法','状態','備考','請求ID','承認版','料金方式','確定単価(30分)','確定月謝','実施分数','実施回数','実績JSON','取消日時','取消理由','処理ID','入金版'];

function billingError_(message, code) { return {error:message,errorCode:code || 'validation'}; }
function billingMonthValid_(v) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')); }
function billingDateValid_(v) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(String(v || ''))) return false;
  var d = new Date(v + 'T00:00:00+09:00');
  return !isNaN(d.getTime()) && Utilities.formatDate(d,TZ,'yyyy-MM-dd') === v;
}
function billingText_(v) { var s = String(v == null ? '' : v); return /^[=+@'\-]/.test(s) ? "'" + s : s; }
function billingStamp_() { return new Date().toISOString(); }
function billingId_() { return uid_() + uid_(); }

function billingEnsureColumns_(ss,name,cols) {
  var sh = ensureSheet_(ss,name,cols);
  var old = sh.getRange(1,1,1,cols.length).getValues()[0];
  for (var i=0;i<cols.length;i++) {
    if (old[i] !== '' && old[i] != null && String(old[i]) !== cols[i]) throw new Error(name+'の列構成が想定と異なります。上書きせず確認してください');
  }
  if (old.join('|') !== cols.join('|')) sh.getRange(1,1,1,cols.length).setValues([cols]);
  return sh;
}
function ensureBillingSchema_() {
  billingEnsureColumns_(ss_(),'monthAgreements',BILLING_AGREEMENT_COLS_);
  billingEnsureColumns_(ss_(),'approvalEvents',BILLING_EVENT_COLS_);
  var sh = billingEnsureColumns_(ledger_(),'入金管理',BILLING_PAYMENT_COLS_);
  LEDGER_COLS['入金管理'] = BILLING_PAYMENT_COLS_.slice();
  // 既存請求の金額や日付は保持し、行移動に影響されないIDだけを補完する。
  var values = sh.getDataRange().getValues();
  for (var i=1;i<values.length;i++) {
    if (values[i][1] !== '' && values[i][1] != null && !values[i][9]) sh.getRange(i+1,10).setNumberFormat('@').setValue(billingId_());
  }
  memoClear_();
}
function billingAudit_(a,event,id,extra) {
  var existing=readRows_('approvalEvents').filter(function(r){return String(r.id)===String(id);})[0];
  var snapshot={plan:billingPlanJson_(a),rate30:Number(a.rate30)||0,monthly:Number(a.monthly)||0};
  if(a.lessonMin)snapshot.lessonMin=Number(a.lessonMin);
  if(a.approvedPlanJson)snapshot.approvedPlan=JSON.parse(a.approvedPlanJson);
  if(extra)snapshot.detail=extra;
  if(existing){
    if(String(existing.studentId)!==String(a.studentId) || String(existing.ym)!==String(a.ym) || Number(existing.revision)!==(Number(a.revision)||0) || String(existing.event)!==event || String(existing.consentDate||'')!==String(a.consentDate||'') || String(existing.via||'')!==String(a.approvedVia||'') || String(existing.memo||'')!==String(a.memo||'') || String(existing.snapshotJson)!==JSON.stringify(snapshot)) {
      var conflict=new Error('途中の処理と内容が異なります。元の承諾内容・理由で再試行してください');conflict.billingCode='conflict';throw conflict;
    }
    return;
  }
  var vals=[id,a.studentId,a.ym,Number(a.revision)||0,event,billingStamp_(),a.consentDate||'',billingText_(a.approvedVia||''),billingText_(a.memo||''),JSON.stringify(snapshot)];
  var sh=sheet_('approvalEvents');sh.getRange(sh.getLastRow()+1,1,1,vals.length).setNumberFormat('@').setValues([vals]);
}
function billingPlanJson_(a) {
  if(!a || !a.planJson)return [];
  try { var p=JSON.parse(String(a.planJson));return Array.isArray(p)?p:[]; } catch(e){throw new Error('月間承認の保存内容を確認してください');}
}
function billingInvoiceRows_(studentId,ym) {
  return ledgerRows_('入金管理').filter(function(p){return String(p['生徒ID'])===String(studentId) && (!ym || String(p['年月'])===String(ym));});
}
function billingActiveInvoices_(studentId,ym) {
  return billingInvoiceRows_(studentId,ym).filter(function(p){return p['状態']!=='取消' && !p['取消日時'];});
}
function billingMonthUnlocked_(studentId,ym) {
  return billingActiveInvoices_(studentId,ym).length?billingError_('この月は請求を記録済みです。未入金の請求を取り消してから変更してください','invoiceLocked'):null;
}
function billingRevisionCheck_(req,a,required) {
  if(req.expectedRevision==null && !required)return null;
  if(!billingRevisionValid_(req.expectedRevision) || Number(req.expectedRevision)!==(a?Number(a.revision):0))return billingError_('回数または料金が更新されています。最新の内容を読み直してください','conflict');
  return null;
}
function billingRevisionValid_(v) { return (typeof v==='number'||typeof v==='string'&&/^\d+$/.test(v)) && Number.isSafeInteger(Number(v)) && Number(v)>=0; }
function billingMoney_(value) { return billingRevisionValid_(value) && Number(value)<=10000000; }
function billingSlotAllowed_(slot) {
  if(!billingSlotValid_(slot))return billingError_('授業の日付・時刻・分数・科目を確認してください');
  var id=String(slot.studentId||''),ym=String(slot.date||'').slice(0,7);
  var check=billingMonthUnlocked_(id,ym);if(check)return check;
  if(!findStudent_(id))return billingError_('在籍生徒の授業だけを確定・実施できます','notFound');
  var l=planLineMatch_(planLinesFor_(id),slot);
  if(!l)return billingError_('この授業(科目・種類・日付)の回数と料金について、保護者の承認が必要です','approvalRequired');
  var booked=planLineBooked_(l,undefined,slot.id).length,limit=planLineLimit_(l);
  if(!limit||booked+1>limit)return billingError_('この案内の承認回数(' + limit + '回)を超えます。回数を変更し、再承認を得てください','planLimit');
  return null;
}
function billingSlotMutable_(slot) { return slot.studentId?billingMonthUnlocked_(slot.studentId,String(slot.date).slice(0,7)):null; }
function billingSlotValid_(s) {
  var min=Number(s.min),subject=String(s.subject||'').trim(),start=String(s.start||'');
  return billingDateValid_(String(s.date||'')) && /^([01]\d|2[0-3]):[0-5]\d$/.test(start) && Number.isInteger(min) && min>0 && min<=480 && Number(start.slice(0,2))*60+Number(start.slice(3))+min<=1440 && !!subject && subject.length<=20 && !/^[=+@-]/.test(subject);
}
function billingSavedLessons_(p) {
  try { var data=JSON.parse(String(p['実績JSON']||'[]'));return Array.isArray(data)?data:[]; } catch(e){return [];}
}
function billingInvoiceView_(p) {
  return {id:String(p['請求ID']||''),ym:String(p['年月']),amount:Number(p['請求額'])||0,status:String(p['状態']||''),billDate:String(p['請求日']||''),paidDate:String(p['入金日']||''),method:String(p['入金方法']||''),revision:Number(p['承認版'])||0,paymentRevision:Number(p['入金版'])||0,voidedAt:String(p['取消日時']||''),voidReason:String(p['取消理由']||''),lessons:billingSavedLessons_(p)};
}
// 実施済み授業ごとに、該当する承認済みの案内の単価で計算する。案内のない授業は生徒の基本単価で仮計算(provisional)
function billingMonthCalc_(id,ym) {
  var st=systemStudent_(id)||{},base=Number(st.rate30)||0,lines=planLinesFor_(id);
  var slots=readRows_('slots').filter(function(s){return String(s.studentId)===id&&s.status==='booked'&&String(s.date||'').slice(0,7)===ym;});
  var done=slots.filter(function(s){return s.done===true||String(s.done)==='true';}).sort(slotSort_);
  var amount=0,provisional=false,rates={};
  var lessons=done.map(function(s){
    var l=planLineMatch_(lines,s),rate=l?l.rate30:base;if(!l)provisional=true;rates[rate]=true;
    var amt=Math.round((Number(s.min)||0)/30*rate);amount+=amt;
    return {id:String(s.id),date:s.date,start:s.start,min:Number(s.min),subject:String(s.subject||''),kind:kindNorm_(s.kind),amount:amt,rate30:rate,lineId:l?l.id:'',lineRevision:l?l.revision:0,lineCount:l?planLineLimit_(l):0};
  });
  var keys=Object.keys(rates);
  return {amount:amount,provisional:provisional,rate30:keys.length===1?Number(keys[0]):(keys.length?0:base),lessons:lessons,slots:slots,done:done,lines:lines};
}
function billingFee_(studentId,minutes,ym) {
  ym=ym||todayStr_().slice(0,7);
  var invoices=billingActiveInvoices_(studentId,ym),p=invoices[0];
  if(p)return {amount:Number(p['請求額'])||0,mode:String(p['料金方式']||'recorded'),rate30:Number(p['確定単価(30分)'])||0,monthly:Number(p['確定月謝'])||0,locked:true};
  var calc=billingMonthCalc_(String(studentId||''),ym);
  return {amount:calc.amount,mode:'time',rate30:calc.rate30,monthly:0,locked:false,provisional:calc.provisional,legacyTerms:false};
}
function billingPreview_(studentId,ym) {
  var id=String(studentId||'');
  if(!systemStudent_(id))return billingError_('生徒が見つかりません','notFound');
  if(!billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  var info=billingMonthInfo_(id,ym),invoices=billingActiveInvoices_(id,ym),calc=billingMonthCalc_(id,ym);
  var slots=calc.slots,done=calc.done,minutes=done.reduce(function(n,s){return n+(Number(s.min)||0);},0),fee=billingFee_(id,minutes,ym),reason='';
  if(invoices.length)reason=invoices.length>1?'この月の請求が重複しています。台帳を確認してください':'この月は請求を記録済みです';
  else {
    if(slots.some(function(s){return !planLineMatch_(calc.lines,s);}))reason='承認されていない科目・回数の授業があります';
    if(!reason){
      var over=calc.lines.filter(function(l){return l.status==='approved'&&planLineOverlapsMonth_(l,ym);}).some(function(l){return planLineBooked_(l).length>planLineLimit_(l);});
      if(over)reason='承認されていない科目・回数の授業があります';
    }
    if(!reason && slots.some(function(s){return !billingSlotValid_(s);}))reason='授業の日付・時刻・分数・科目に不正な記録があります';
    if(!reason && slots.some(function(s){return !(s.done===true||String(s.done)==='true');}))reason='未実施の確定授業が残っています。実施・取消の確認後に請求してください';
    if(!reason && done.some(function(s){return hoursUntil_(s.date,s.start)>0;}))reason='開始前の授業が実施済みになっています';
    if(!reason && !(fee.amount>0))reason='請求対象の授業料がありません';
  }
  return {ym:ym,amount:fee.amount,mode:fee.mode,rate30:fee.rate30,monthly:fee.monthly,minutes:minutes,count:done.length,planStatus:info.status,revision:0,canBill:!reason,reason:reason,provisional:!!fee.provisional,
    invoice:invoices.length?billingInvoiceView_(invoices[0]):null,
    lessons:fee.locked?billingSavedLessons_(invoices[0]):calc.lessons,lines:info.lines};
}
function billingMonths_(id) {
  var seen={},current=todayStr_().slice(0,7);seen[current]=true;seen[nextYm_(current)]=true;
  readRows_('slots').forEach(function(s){if(String(s.studentId)===String(id)&&billingMonthValid_(s.date.slice(0,7)))seen[s.date.slice(0,7)]=true;});
  planLinesFor_(String(id)).forEach(function(l){planLineMonths_(l).forEach(function(ym){seen[ym]=true;});});
  billingInvoiceRows_(id).forEach(function(p){if(billingMonthValid_(String(p['年月'])))seen[String(p['年月'])]=true;});
  return Object.keys(seen).sort().reverse().map(function(ym){return billingPreview_(id,ym);});
}
// 請求・入金の監査行(approvalEvents)に使う擬似的な合意: 請求IDを id にする
// 請求の根拠(行ID・版・単価)を授業スナップショットから作る。発行時も再送時も同じ文字列になるので、監査の照合が一致する
function billingInvoiceLineRefs_(lessons) {
  var seen={},out=[];(lessons||[]).forEach(function(l){var key=String(l.lineId||'')+':'+String(l.lineRevision||0)+':'+String(l.rate30||0);if(!l.lineId||seen[key])return;seen[key]=true;out.push({id:String(l.lineId),revision:Number(l.lineRevision)||0,count:Number(l.lineCount)||0,rate30:Number(l.rate30)||0});});
  return JSON.stringify(out);
}
function billingInvoiceAudit_(id,ym,invoiceId,revision,extra) {
  return Object.assign({id:String(invoiceId||'invoice'),studentId:String(id),ym:String(ym),revision:Number(revision)||0,planJson:'',rate30:0,monthly:0},extra||{});
}
function billingAddInvoice_(req) {
  var id=String(req.studentId||''),ym=String(req.ym||''),requestId=String(req.requestId||'');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))return billingError_('請求画面を更新して再実行してください','requestIdRequired');
  var previous=ledgerRows_('入金管理').filter(function(p){return String(p['処理ID'])===requestId;});
  if(previous.length){
    var old=previous[0];
    if(String(old['生徒ID'])!==id||String(old['年月'])!==ym||(req.amount!=null&&Number(req.amount)!==Number(old['請求額'])))return billingError_('同じ処理IDで内容を変更できません','conflict');
    billingAudit_(billingInvoiceAudit_(id,ym,old['請求ID'],old['承認版'],{planJson:billingInvoiceLineRefs_(billingSavedLessons_(old)),rate30:Number(old['確定単価(30分)'])||0}),'invoiced',String(old['請求ID'])+':issued',{invoiceId:String(old['請求ID']),amount:Number(old['請求額']),minutes:Number(old['実施分数'])});
    var oldNotice=!old['取消日時']&&old['状態']!=='取消'?billingNotifyResult_('invoiceCreated',id,String(old['請求ID'])+':issued',{ym:ym,revision:old['承認版']}):{};
    return Object.assign({ok:true,invoice:billingInvoiceView_(old),replayed:true},oldNotice);
  }
  var preview=billingPreview_(id,ym);if(preview.error)return preview;
  if(!preview.canBill)return billingError_(preview.reason,preview.invoice?'invoiceExists':'approvalRequired');
  if(req.amount!=null && Number(req.amount)!==preview.amount)return billingError_('請求額が最新の実績・承認内容と一致しません','conflict');
  if(req.paidDate || req.unpaid || req.billDate && req.billDate!==todayStr_())return billingError_('請求日・金額はサーバーで確定します。入金は請求後に記録してください');
  var invoiceId=billingId_(),st=systemStudent_(id),a=billingInvoiceAudit_(id,ym,invoiceId,0,{planJson:billingInvoiceLineRefs_(preview.lessons),rate30:preview.rate30});
  LEDGER_COLS['入金管理']=BILLING_PAYMENT_COLS_.slice();
  var o={'年月':ym,'生徒ID':id,'氏名':st.name,'請求額':preview.amount,'請求日':todayStr_(),'状態':'未入金','備考':billingText_(String(req.note||'').slice(0,200)),
    '請求ID':invoiceId,'承認版':0,'料金方式':preview.mode,'確定単価(30分)':preview.rate30,'確定月謝':preview.monthly,'実施分数':preview.minutes,'実施回数':preview.count,'実績JSON':JSON.stringify(preview.lessons),'処理ID':requestId};
  // 請求の根拠・処理IDを1行に保存。後続ログが失敗しても再送はこの行を見つける。
  ledgerAppend_('入金管理',o);
  billingAudit_(a,'invoiced',invoiceId+':issued',{invoiceId:invoiceId,amount:preview.amount,minutes:preview.minutes});
  var notice=billingNotifyResult_('invoiceCreated',id,invoiceId+':issued',{ym:ym,revision:0});
  return Object.assign({ok:true,invoice:billingInvoiceView_(o)},notice);
}
function billingFindInvoice_(req) {
  if(!req.invoiceId)return null;
  var matches=billingInvoiceRows_(req.studentId).filter(function(p){return String(p['請求ID'])===String(req.invoiceId);});
  if(matches.length>1)throw new Error('請求IDが重複しています');return matches[0]||null;
}
function billingWriteInvoiceRow_(row,values) {
  ledgerSheet_('入金管理').getRange(row,1,1,values.length).setValues([values.map(function(v){return typeof v==='string'?billingText_(v):v;})]);
}
function billingVoidInvoice_(req) {
  var p=billingFindInvoice_(req),reason=String(req.reason||'').trim();
  if(!p)return billingError_('請求が見つかりません。最新の画面を読み直してください','notFound');
  if(p['取消日時']||p['状態']==='取消'){
    return Object.assign({ok:true,replayed:true},billingNotifyResult_('invoiceVoided',req.studentId,String(p['請求ID'])+':void',{ym:p['年月'],revision:p['承認版']}));
  }
  if(p['状態']==='入金済'||p['入金日'])return billingError_('入金済みの請求は取り消せません。入金の誤登録なら理由付きで訂正してください');
  if(!reason||reason.length>500)return billingError_('取消理由を500文字以内で入力してください');
  var a=billingInvoiceAudit_(req.studentId,p['年月'],p['請求ID'],p['承認版'],{memo:reason});
  billingAudit_(a,'invoiceVoided',String(p['請求ID'])+':void',{reason:reason,invoiceId:req.invoiceId});
  var sh=ledgerSheet_('入金管理'),vals=sh.getRange(p._row,1,1,BILLING_PAYMENT_COLS_.length).getValues()[0];
  vals[7]='取消';vals[17]=billingStamp_();vals[18]=reason;billingWriteInvoiceRow_(p._row,vals);
  return Object.assign({ok:true},billingNotifyResult_('invoiceVoided',req.studentId,String(p['請求ID'])+':void',{ym:p['年月'],revision:p['承認版']}));
}
function billingSetPaid_(req) {
  var p=billingFindInvoice_(req);if(!p)return billingError_('請求が見つかりません。最新の画面を読み直してください','notFound');
  if(p['取消日時']||p['状態']==='取消')return billingError_('取り消した請求には入金を記録できません');
  var unpaid=req.unpaid===true,reason=String(req.reason||'').trim();
  var revision=Number(p['入金版'])||0;
  if(!billingRevisionValid_(req.expectedPaymentRevision))return billingError_('最新の請求画面を読み直してください','conflict');
  var paid=unpaid?'':String(req.date||req.paidDate||todayStr_()),method=unpaid?'':String(req.method||'').trim();
  if(unpaid && (!reason||reason.length>500))return billingError_('入金記録を戻す理由を入力してください');
  if(!unpaid && (!billingDateValid_(paid)||paid>todayStr_()||method.length>40))return billingError_('正しい入金日と方法を入力してください');
  if(String(p['入金日']||'')===paid && String(p['入金方法']||'')===method)return {ok:true,replayed:true};
  if(Number(req.expectedPaymentRevision)!==revision)return billingError_('入金状態が変更されています。最新の請求画面を読み直してください','conflict');
  if(!unpaid && (p['入金日'] || p['状態']==='入金済'))return billingError_('この請求は既に入金を記録済みです。訂正する場合は理由を付けて入金記録を戻してください','conflict');
  var a=billingInvoiceAudit_(req.studentId,p['年月'],p['請求ID'],p['承認版']);
  billingAudit_(a,unpaid?'paymentCorrected':'paid',String(req.invoiceId)+':payment:'+(revision+1),{invoiceId:req.invoiceId,previousDate:p['入金日']||'',date:paid,method:method,reason:reason,paymentRevision:revision+1});
  var vals=ledgerSheet_('入金管理').getRange(p._row,1,1,BILLING_PAYMENT_COLS_.length).getValues()[0];
  vals[5]=paid;vals[6]=method;vals[7]=unpaid?'未入金':'入金済';vals[20]=revision+1;
  billingWriteInvoiceRow_(p._row,vals);return {ok:true};
}
function billingNotifyResult_(kind,id,key,detail) {
  if(typeof familyNotifySafe_!=='function')return {};
  var r=familyNotifySafe_(kind,id,key,detail);
  return !r.ok||(r.statuses||[]).some(function(s){return ['failed','pending','uncertain'].indexOf(s)>=0;})?{notificationWarning:'保存は完了しましたが、保護者へのメール通知を確認してください'}:{};
}
function billingMutationResult_(req,res) {
  if(res.error)return res;
  var out=kanriStudentOp_({studentId:req.studentId,view:req.view,section:req.section});
  if(res.invoice)out.invoice=res.invoice;if(res.replayed)out.replayed=true;if(res.notificationWarning)out.notificationWarning=res.notificationWarning;return out;
}

// 新版公開前にエディタから一度実行。既存デプロイはバージョン固定のまま準備する。
function prepareStepwise20260908() {
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    CacheService.getScriptCache().remove('schemaOk21');memoClear_();ensureSchema_();
    var summary={reservation:ss_().getSheets().map(function(s){return {name:s.getName(),rows:s.getLastRow(),columns:s.getLastColumn()};}),ledger:ledger_().getSheets().map(function(s){return {name:s.getName(),rows:s.getLastRow(),columns:s.getLastColumn()};})};
    Logger.log(JSON.stringify(summary));return summary;
  } finally {lock.releaseLock();}
}
