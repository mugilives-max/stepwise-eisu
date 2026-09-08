/* 月間承認と請求。Code.gsと同じApps Scriptプロジェクトへ配置する。 */
var BILLING_AGREEMENT_COLS_ = ['id','studentId','ym','revision','status','planJson','rate30','monthly','proposedAt','approvedAt','approvedVia','consentDate','memo','updatedAt'];
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
function billingAgreement_(studentId,ym) {
  var match = null;
  readRows_('monthAgreements').forEach(function(r,i) {
    if (String(r.studentId) === String(studentId) && String(r.ym) === String(ym)) {
      if (match) throw new Error('月間承認が重複しています。台帳を確認してください');
      match = r; match._row=i+2;
    }
  });
  return match;
}
function billingWriteAgreement_(a) {
  a.updatedAt=billingStamp_();
  var sh=sheet_('monthAgreements'), row=a._row || sh.getLastRow()+1;
  var vals=BILLING_AGREEMENT_COLS_.map(function(k){var v=a[k] == null ? '' : a[k];return typeof v==='string'?billingText_(v):v;});
  sh.getRange(row,1,1,vals.length).setNumberFormat('@').setValues([vals]);
  a._row=row;
}
function billingAudit_(a,event,id,extra) {
  var existing=readRows_('approvalEvents').filter(function(r){return String(r.id)===String(id);})[0];
  var snapshot={plan:billingPlanJson_(a),rate30:Number(a.rate30)||0,monthly:Number(a.monthly)||0};
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
function billingPlanList_(studentId,ym,rows) {
  var map=Object.create(null), duplicate=false;
  (rows||planRows_()).forEach(function(r){
    if(String(r.studentId)!==String(studentId) || String(r.ym)!==ym)return;
    if(Object.prototype.hasOwnProperty.call(map,r.subject))duplicate=true;
    if(Number(r.count)>0)map[r.subject]=Number(r.count);
  });
  if(duplicate)throw new Error('同じ科目の計画が重複しています');
  return Object.keys(map).sort().map(function(k){return {subject:k,count:map[k]};});
}
function billingAgreementCurrent_(a) {
  return !!a && a.status==='approved' && JSON.stringify(billingPlanJson_(a))===JSON.stringify(billingPlanList_(a.studentId,String(a.ym)));
}
function billingMonthInfo_(studentId,ym,rows) {
  var info=planMonthInfoLegacy_(studentId,ym,rows),a=billingAgreement_(studentId,ym);
  info.revision=a?Number(a.revision)||0:0;
  info.termsKnown=!!a && a.rate30!=='' && a.monthly!=='';
  info.rate30=info.termsKnown?Number(a.rate30):null;info.monthly=info.termsKnown?Number(a.monthly):null;
  info.consentDate=a?String(a.consentDate||''):'';
  if(a){
    var current=JSON.stringify(billingPlanJson_(a))===JSON.stringify(billingPlanList_(studentId,ym,rows));
    info.status=current?String(a.status):'draft';
    info.proposedAt=String(a.proposedAt||'');info.approvedAt=String(a.approvedAt||'');
    info.approvedVia=String(a.approvedVia||'');info.memo=String(a.memo||'');
  } else if(info.status==='approved' || info.status==='proposed') {
    info.status='draft';info.memo='月の料金と回数を確認して、あらためて提案してください';
  }
  return info;
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
function billingPlanSet_(req) {
  var id=String(req.studentId||''),ym=String(req.ym||''),subject=String(req.subject||'').trim();
  if(!systemStudent_(id))return billingError_('生徒が見つかりません','notFound');
  if(ym!=='default' && !billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  if(!subject || subject.length>20 || /^[=+@-]/.test(subject))return billingError_('科目を20文字以内で選んでください');
  var count=Number(req.count);if(!Number.isInteger(count)||count<0||count>31)return billingError_('回数は0〜31の整数です');
  var a=ym==='default'?null:billingAgreement_(id,ym), check=ym==='default'?null:(billingMonthUnlocked_(id,ym)||billingRevisionCheck_(req,a,false));
  if(check)return check;
  var rows=readRows_('plans'),found=-1;
  for(var i=0;i<rows.length;i++)if(String(rows[i].studentId)===id && planYm_(rows[i].ym)===ym && String(rows[i].subject)===subject){if(found>=0)return billingError_('科目の計画が重複しています');found=i;}
  if(found>=0 && Number(rows[found].count)===count || found<0 && count===0){
    // Only an unproposed draft made by planSet can finish an interrupted write.
    // planPropose stamps proposedAt before its own intermediate draft is saved.
    if(a && a.status==='draft' && !a.proposedAt){
      var snapshot=JSON.stringify(billingPlanList_(id,ym));
      var eventId=a.id+':'+a.revision+':changed';
      var auditExists=readRows_('approvalEvents').some(function(e){return String(e.id)===eventId;});
      var statusPending=rows.some(function(p){return String(p.studentId)===id && planYm_(p.ym)===ym && (p.status!=='draft'||p.approvedAt||p.approvedVia||p.memo);});
      if(String(a.planJson)!==snapshot || statusPending || !auditExists){
        check=billingRevisionCheck_(req,a,true);if(check)return check;
        var snapshotPending=String(a.planJson)!==snapshot;a.planJson=snapshot;
        // Validate an existing receipt before touching a conflicting snapshot.
        if(auditExists)billingAudit_(a,'planChanged',eventId);
        if(statusPending)planSetStatus_(id,ym,'draft','','',false);
        if(snapshotPending)billingWriteAgreement_(a);
        if(!auditExists)billingAudit_(a,'planChanged',eventId);
      }
    }
    return {ok:true};
  }
  // 先に承認を無効化する。計画の保存途中で失敗しても古い承認を使えない。
  if(ym!=='default'){
    a=a||{id:billingId_(),studentId:id,ym:ym,revision:0,rate30:'',monthly:''};
    a.revision=Number(a.revision)+1;a.status='draft';a.proposedAt='';a.approvedAt='';a.approvedVia='';a.consentDate='';a.memo='';
    billingWriteAgreement_(a);
  }
  var sh=sheet_('plans');
  if(found>=0){if(count===0)sh.deleteRow(found+2);else sh.getRange(found+2,5).setValue(count);}
  else sh.getRange(sh.getLastRow()+1,1,1,10).setNumberFormat('@').setValues([[uid_(),id,ym,subject,count,'draft','','','','']]);
  if(ym!=='default'){
    planSetStatus_(id,ym,'draft','','',false);
    a.planJson=JSON.stringify(billingPlanList_(id,ym));billingWriteAgreement_(a);
    billingAudit_(a,'planChanged',a.id+':'+a.revision+':changed');
  }
  return {ok:true};
}
function billingMoney_(value) { return billingRevisionValid_(value) && Number(value)<=10000000; }
function billingPlanPropose_(req) {
  var id=String(req.studentId||''),ym=String(req.ym||''),st=findStudent_(id);
  if(!st)return billingError_('在籍生徒を選んでください','notFound');
  if(!billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  var a=billingAgreement_(id,ym),check=billingMonthUnlocked_(id,ym)||billingRevisionCheck_(req,a,false);if(check)return check;
  var rate=req.rate30,monthly=req.monthly;
  if(rate==null || monthly==null){
    if(ym<todayStr_().slice(0,7))return billingError_('過去月は、その月に合意する単価と月謝を明示してください','termsRequired');
    if(rate==null)rate=Number(st.rate30)||0;if(monthly==null)monthly=Number(st.monthly)||0;
  }
  if(!billingMoney_(rate)||!billingMoney_(monthly))return billingError_('単価・月謝は0〜10,000,000円の整数です');
  var p=billingPlanList_(id,ym);
  if(!p.length){
    p=billingPlanList_(id,'default');if(!p.length)return billingError_('先に科目と回数を登録してください');
  }
  a=a||{id:billingId_(),studentId:id,ym:ym,revision:0};
  a.revision=Number(a.revision)+1;a.status='draft';a.planJson=JSON.stringify(p);a.rate30=Number(rate);a.monthly=Number(monthly);
  a.approvedAt='';a.approvedVia='';a.consentDate='';a.memo='';a.proposedAt=billingStamp_();billingWriteAgreement_(a);
  var res=planSetStatus_(id,ym,'proposed','','',true);if(res.error)return res;
  a.status='proposed';billingWriteAgreement_(a);billingAudit_(a,'proposed',a.id+':'+a.revision+':proposed');
  var notice=billingNotifyResult_('planProposed',id,a.id+':'+a.revision+':proposed',{ym:ym,revision:a.revision});
  return Object.assign({ok:true,revision:a.revision},notice);
}
function billingApprove_(req,id,parent) {
  var ym=String(req.ym||'');if(!billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  var a=billingAgreement_(id,ym),check=billingRevisionCheck_(req,a,true);if(check)return check;
  if(!a || a.rate30==='' || a.monthly==='')return billingError_('月の回数と料金の提案がありません','approvalRequired');
  if(JSON.stringify(billingPlanJson_(a))!==JSON.stringify(billingPlanList_(id,ym)))return billingError_('計画が変わっています。先生に再提案を依頼してください','conflict');
  var approve=parent?(req.approve===true || String(req.approve)==='true'):true;
  if((approve && a.status==='approved') || (!approve && a.status==='declined'))return {ok:true,replayed:true};
  check=billingMonthUnlocked_(id,ym);if(check)return check;
  if(a.status!=='proposed')return billingError_('現在の提案を読み直してください','conflict');
  var date=parent?todayStr_():String(req.consentDate||'');
  if(!billingDateValid_(date)||date>todayStr_())return billingError_('実際に承諾を得た日を、今日以前の日付で入力してください');
  var via=parent?'保護者ページ':String(req.via||'').trim(),memo=String(req.memo||'').trim();
  if(!via||via.length>40||memo.length>500)return billingError_('承諾方法と500文字以内のメモを入力してください');
  var retrospective=ym<todayStr_().slice(0,7)||readRows_('slots').some(function(s){return String(s.studentId)===String(id)&&s.date.slice(0,7)===ym&&s.date<date&&(s.status==='booked'||s.status==='offered');});
  if(!parent && retrospective && !memo)return billingError_('授業後・過去月の承諾は、経緯をメモに残してください');
  a.status=approve?'approved':'declined';a.approvedAt=approve?billingStamp_():'';a.approvedVia=approve?via:'';a.consentDate=date;a.memo=memo;
  // 承諾日時と実際の記録日時を別に残す。監査保存失敗時は承認を有効にしない。
  billingAudit_(a,a.status,a.id+':'+a.revision+':'+a.status);
  planSetStatus_(id,ym,a.status,a.approvedVia,memo,false);billingWriteAgreement_(a);
  return {ok:true};
}
function billingApproveTeacher_(req) {
  var id=String(req.studentId||'');if(!systemStudent_(id))return billingError_('生徒が見つかりません','notFound');
  return billingApprove_(req,id,false);
}
function billingParentDecide_(req) {
  var auth=parentRequire_(req);if(auth.error)return auth;
  return billingParentDecideForStudent_(auth.student,req);
}
function billingParentDecideForStudent_(student,req) {
  var res=billingApprove_(req,String(student.id),true);if(res.error)return res;
  if(!res.replayed && !isTestStudent_(student))notify_('【月間計画の回答】'+student.name+'さん '+req.ym,'保護者ページから月間計画への回答がありました。管理画面でご確認ください。');
  return {ok:true,data:parentDataForStudent_(student).data};
}
function billingSlotAllowed_(slot) {
  if(!billingSlotValid_(slot))return billingError_('授業の日付・時刻・分数・科目を確認してください');
  var id=String(slot.studentId||''),ym=String(slot.date||'').slice(0,7);
  var check=billingMonthUnlocked_(id,ym);if(check)return check;
  if(!findStudent_(id))return billingError_('在籍生徒の授業だけを確定・実施できます','notFound');
  var a=billingAgreement_(id,ym);
  if(!billingAgreementCurrent_(a))return billingError_('この月の回数と料金について、保護者の承認が必要です','approvalRequired');
  var plan=billingPlanJson_(a),subject=String(slot.subject||''),limit=0;
  plan.forEach(function(p){if(p.subject===subject)limit=Number(p.count);});
  var booked=readRows_('slots').filter(function(s){return String(s.studentId)===id&&s.status==='booked'&&s.date.slice(0,7)===ym&&String(s.subject||'')===subject&&String(s.id)!==String(slot.id);}).length;
  if(!limit||booked+1>limit)return billingError_('この科目の承認回数を超えます。月の回数を変更し、再承認を得てください','planLimit');
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
function billingFee_(studentId,minutes,ym) {
  ym=ym||todayStr_().slice(0,7);
  var invoices=billingActiveInvoices_(studentId,ym),p=invoices[0];
  if(p)return {amount:Number(p['請求額'])||0,mode:String(p['料金方式']||'recorded'),rate30:Number(p['確定単価(30分)'])||0,monthly:Number(p['確定月謝'])||0,locked:true};
  var a=billingAgreement_(studentId,ym),st=systemStudent_(studentId)||{};
  var known=!!a&&a.rate30!==''&&a.monthly!=='';
  var monthly=Number(known?a.monthly:st.monthly)||0,rate=Number(known?a.rate30:st.rate30)||0;
  return {amount:monthly>0?monthly:Math.round(Number(minutes||0)/30*rate),mode:monthly>0?'monthly':'time',rate30:rate,monthly:monthly,locked:false,provisional:!known};
}
function billingPreview_(studentId,ym) {
  var id=String(studentId||'');
  if(!systemStudent_(id))return billingError_('生徒が見つかりません','notFound');
  if(!billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  var a=billingAgreement_(id,ym),info=billingMonthInfo_(id,ym),invoices=billingActiveInvoices_(id,ym);
  var slots=readRows_('slots').filter(function(s){return String(s.studentId)===id&&s.status==='booked'&&s.date.slice(0,7)===ym;});
  var done=slots.filter(function(s){return s.done===true||String(s.done)==='true';}).sort(slotSort_);
  var minutes=done.reduce(function(n,s){return n+(Number(s.min)||0);},0),fee=billingFee_(id,minutes,ym),reason='';
  if(invoices.length)reason=invoices.length>1?'この月の請求が重複しています。台帳を確認してください':'この月は請求を記録済みです';
  else if(!billingAgreementCurrent_(a))reason='この月の回数と料金の承認が必要です';
  else {
    var plan=billingPlanJson_(a),counts=Object.create(null);slots.forEach(function(s){counts[String(s.subject||'')]=(counts[String(s.subject||'')]||0)+1;});
    Object.keys(counts).forEach(function(sub){var p=plan.filter(function(x){return x.subject===sub;})[0];if(!p||counts[sub]>p.count)reason='承認されていない科目・回数の授業があります';});
    if(!reason && slots.some(function(s){return !billingSlotValid_(s);}))reason='授業の日付・時刻・分数・科目に不正な記録があります';
    if(!reason && slots.some(function(s){return !(s.done===true||String(s.done)==='true');}))reason='未実施の確定授業が残っています。実施・取消の確認後に請求してください';
    if(!reason && done.some(function(s){return hoursUntil_(s.date,s.start)>0;}))reason='開始前の授業が実施済みになっています';
    if(!reason && !(fee.amount>0))reason='請求対象の授業料がありません';
  }
  return {ym:ym,amount:fee.amount,mode:fee.mode,rate30:fee.rate30,monthly:fee.monthly,minutes:minutes,count:done.length,planStatus:info.status,revision:info.revision,canBill:!reason,reason:reason,provisional:!!fee.provisional,
    invoice:invoices.length?billingInvoiceView_(invoices[0]):null,
    lessons:done.map(function(s){return {id:String(s.id),date:s.date,start:s.start,min:Number(s.min),subject:String(s.subject||'')};})};
}
function billingMonths_(id) {
  var seen={},current=todayStr_().slice(0,7);seen[current]=true;seen[nextYm_(current)]=true;
  readRows_('slots').forEach(function(s){if(String(s.studentId)===String(id)&&billingMonthValid_(s.date.slice(0,7)))seen[s.date.slice(0,7)]=true;});
  planRows_().forEach(function(p){if(String(p.studentId)===String(id)&&billingMonthValid_(p.ym))seen[p.ym]=true;});
  readRows_('monthAgreements').forEach(function(a){if(String(a.studentId)===String(id)&&billingMonthValid_(String(a.ym)))seen[String(a.ym)]=true;});
  billingInvoiceRows_(id).forEach(function(p){if(billingMonthValid_(String(p['年月'])))seen[String(p['年月'])]=true;});
  return Object.keys(seen).sort().reverse().map(function(ym){return billingPreview_(id,ym);});
}
function billingAddInvoice_(req) {
  var id=String(req.studentId||''),ym=String(req.ym||''),requestId=String(req.requestId||'');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))return billingError_('請求画面を更新して再実行してください','requestIdRequired');
  var previous=ledgerRows_('入金管理').filter(function(p){return String(p['処理ID'])===requestId;});
  if(previous.length){
    var old=previous[0];
    if(String(old['生徒ID'])!==id||String(old['年月'])!==ym||(req.amount!=null&&Number(req.amount)!==Number(old['請求額'])))return billingError_('同じ処理IDで内容を変更できません','conflict');
    var originalAgreement=billingAgreement_(id,ym);
    if(originalAgreement && Number(originalAgreement.revision)===Number(old['承認版']))billingAudit_(originalAgreement,'invoiced',String(old['請求ID'])+':issued',{invoiceId:String(old['請求ID']),amount:Number(old['請求額']),minutes:Number(old['実施分数'])});
    var oldNotice=!old['取消日時']&&old['状態']!=='取消'?billingNotifyResult_('invoiceCreated',id,String(old['請求ID'])+':issued',{ym:ym,revision:old['承認版']}):{};
    return Object.assign({ok:true,invoice:billingInvoiceView_(old),replayed:true},oldNotice);
  }
  var preview=billingPreview_(id,ym);if(preview.error)return preview;
  if(!preview.canBill)return billingError_(preview.reason,preview.invoice?'invoiceExists':'approvalRequired');
  if(req.amount!=null && Number(req.amount)!==preview.amount)return billingError_('請求額が最新の実績・承認内容と一致しません','conflict');
  if(req.paidDate || req.unpaid || req.billDate && req.billDate!==todayStr_())return billingError_('請求日・金額はサーバーで確定します。入金は請求後に記録してください');
  var a=billingAgreement_(id,ym),invoiceId=billingId_(),st=systemStudent_(id);
  LEDGER_COLS['入金管理']=BILLING_PAYMENT_COLS_.slice();
  var o={'年月':ym,'生徒ID':id,'氏名':st.name,'請求額':preview.amount,'請求日':todayStr_(),'状態':'未入金','備考':billingText_(String(req.note||'').slice(0,200)),
    '請求ID':invoiceId,'承認版':a.revision,'料金方式':preview.mode,'確定単価(30分)':preview.rate30,'確定月謝':preview.monthly,'実施分数':preview.minutes,'実施回数':preview.count,'実績JSON':JSON.stringify(preview.lessons),'処理ID':requestId};
  // 請求の根拠・処理IDを1行に保存。後続ログが失敗しても再送はこの行を見つける。
  ledgerAppend_('入金管理',o);
  billingAudit_(a,'invoiced',invoiceId+':issued',{invoiceId:invoiceId,amount:preview.amount,minutes:preview.minutes});
  var notice=billingNotifyResult_('invoiceCreated',id,invoiceId+':issued',{ym:ym,revision:a.revision});
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
  var a=billingAgreement_(req.studentId,String(p['年月']))||{studentId:req.studentId,ym:p['年月'],revision:p['承認版'],memo:reason};
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
  var a=billingAgreement_(req.studentId,String(p['年月']))||{studentId:req.studentId,ym:p['年月'],revision:p['承認版']};
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
    CacheService.getScriptCache().remove('schemaOk19');memoClear_();ensureSchema_();
    var summary={reservation:ss_().getSheets().map(function(s){return {name:s.getName(),rows:s.getLastRow(),columns:s.getLastColumn()};}),ledger:ledger_().getSheets().map(function(s){return {name:s.getName(),rows:s.getLastRow(),columns:s.getLastColumn()};})};
    Logger.log(JSON.stringify(summary));return summary;
  } finally {lock.releaseLock();}
}
