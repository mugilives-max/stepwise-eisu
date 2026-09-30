/* Monthly family statements. Automatic close runs through the internal Worker scheduler. */
function familyBillingSignature_(m) {return m.children.map(function(c){var i=c.invoice;return i.id+':'+i.amount+':'+(i.paymentRevision||0);}).sort().join('|');}
function familyBillingStatus_(a,m) {
  m.signature=familyBillingSignature_(m);m.status=m.conflict?'review':m.unpaid===0?'paid':'waiting';
  var key='family-transfer:'+a.id+':'+m.ym+':'+m.signature;
  if(m.status==='waiting'&&readRows_('approvalEvents').some(function(e){return String(e.id)===key&&e.event==='transferReported';}))m.status='reported';return m;
}
function familyReportTransfer_(req) {
  var auth=familyRequire_(req);if(auth.error)return auth;
  var a=auth.account,m=familyBilling_(a,false).filter(function(m){return m.ym===req.ym;})[0];
  if(!m||m.status==='review'||m.conflict)return familyError_('請求内容を確認してください');
  if(m.status==='paid')return familyError_('この月はお支払い完了です');
  if(!req.signature||req.signature!==m.signature)return familyError_('請求内容が変わりました。ページを開き直してください');
  billingAudit_({studentId:'family:'+a.id,ym:m.ym},'transferReported','family-transfer:'+a.id+':'+m.ym+':'+m.signature,{amount:m.amount,invoiceSignature:m.signature});
  return {ok:true,billing:familyBilling_(a,false)};
}
function familyBillingClosedMonths_(a,months,children) {
  var current=todayStr_().slice(0,7),map={};months.forEach(function(m){map[m.ym]=m;});
  readRows_('slots').forEach(function(s){var ym=String(s.date||'').slice(0,7);if(ym<'2026-09'||ym>=current||s.status!=='booked'||!children.some(function(c){return String(c.studentId)===String(s.studentId);}))return;
    var m=map[ym];if(!m)m=map[ym]={ym:ym,amount:null,unpaid:null,children:[],status:'review',signature:''};
    if(!m.children.some(function(c){return String(c.studentId)===String(s.studentId);}))m.status='review';
  });children.forEach(function(c){cancelFeeItems_(c.studentId).forEach(function(f){var ym=f.date.slice(0,7);if(!f.amount||ym>=current)return;var m=map[ym];if(!m)m=map[ym]={ym:ym,amount:null,unpaid:null,children:[],status:'review',signature:''};if(!m.children.some(function(x){return String(x.studentId)===String(c.studentId);}))m.status='review';});});return Object.keys(map).sort().reverse().map(function(ym){return map[ym];});
}
// Internal Worker trigger only; never exposed through HTTP dispatch.
function familyCloseMonths_() {
  ensureSchema_();var current=todayStr_().slice(0,7),result={issued:0,pending:0};
  familyRows_('familyAccounts').filter(function(a){return a.status==='active';}).forEach(function(a){
    var children=familyChildren_(a,false),months={},slots=readRows_('slots');
    slots.forEach(function(s){var ym=String(s.date||'').slice(0,7);if(ym>='2026-09'&&ym<current&&s.status==='booked'&&children.some(function(c){return String(c.studentId)===String(s.studentId);}))months[ym]=true;});
    children.forEach(function(c){cancelFeeItems_(c.studentId).forEach(function(f){var ym=f.date.slice(0,7);if(f.amount>0&&ym<current){if(billingActiveInvoices_(c.studentId,ym).length)ym=Utilities.formatDate(new Date(Date.parse(current+'-01T00:00:00+09:00')-86400000),TZ,'yyyy-MM');months[ym]=true;}});});
    Object.keys(months).sort().forEach(function(ym){
      var candidates=[],blocked=false;
      children.forEach(function(c){var p=billingPreview_(c.studentId,ym);if(billingActiveInvoices_(c.studentId,ym).length>1){blocked=true;return;}if(p.invoice)return;if(cancelReliefPending_(c.studentId,ym).length){blocked=true;return;}
        if(!(p.fees||[]).length&&!slots.some(function(s){return String(s.studentId)===String(c.studentId)&&String(s.date).slice(0,7)===ym&&s.status==='booked';}))return;
        if(!p.canBill||p.provisional||p.carried>0){blocked=true;return;}candidates.push({id:c.studentId,preview:p});
      });if(blocked){result.pending++;return;}
      candidates.forEach(function(c){var r=billingAddInvoice_({studentId:c.id,ym:ym,requestId:'monthly_'+ym+'_'+c.id,silent:true});if(r.error)throw new Error(r.error);result.issued++;});
    });
  });return result;
}

function familyPaymentReports_(){return familyRows_('familyAccounts').filter(function(a){return a.status==='active';}).map(function(a){return {id:String(a.id),label:String(a.label),months:familyBilling_(a,false).filter(function(m){return m.status==='reported';})};}).filter(function(a){return a.months.length;});}
function familyConfirmTransfer_(req){
 var a=familyAccount_(String(req.familyId||''));if(!a)return familyError_('保護者が見つかりません');
 var m=familyBilling_(a,false).filter(function(m){return m.ym===req.ym;})[0];
 if(!m||m.status!=='reported'||m.signature!==req.signature)return familyError_('請求内容が変わりました。一覧を更新してください');
 m.children.forEach(function(c){if(c.invoice.paidDate)return;var r=billingSetPaid_({studentId:c.studentId,invoiceId:c.invoice.id,expectedPaymentRevision:c.invoice.paymentRevision,date:todayStr_(),method:'振込'});if(r.error)throw new Error(r.error);});return {ok:true};
}

// 管理画面「請求」: 月ごとに全生徒の請求の状態を1行ずつ返す。読み取りだけで、発行・入金は既存の操作を使う。
// 金額と請求可否は billingPreview_ の結果をそのまま使い、状態の名前に言い換えるだけ(計算は増やさない)。
// state: reported(保護者から振込の連絡あり) / ready(請求できる) / needDone(実施未登録) / relief(減免の審査待ち)
//        needApproval(承認待ち) / review(要確認) / unpaid(未入金) / open(月の途中) / paid(入金済み)
var BILLING_OVERVIEW_ORDER_ = ['reported','ready','needDone','relief','needApproval','review','unpaid','open','paid'];
function billingOverview_(ym) {
  ym=String(ym||'');
  if(!billingMonthValid_(ym))return billingError_('月の形式は YYYY-MM です');
  var today=todayStr_(),current=today.slice(0,7),slots=readRows_('slots'),famOf={},reported={};
  var accounts={};familyRows_('familyAccounts').forEach(function(a){if(a.status==='active')accounts[String(a.id)]=a;});
  familyRows_('familyLinks').forEach(function(l){var a=accounts[String(l.familyId)];if(a&&String(l.active)==='true')famOf[String(l.studentId)]={id:String(a.id),label:String(a.label||'')};});
  familyPaymentReports_().forEach(function(f){f.months.forEach(function(m){if(m.ym===ym)reported[f.id]=String(m.signature||'');});});
  var rows=[],totals={billed:0,paid:0,unpaid:0,open:0,pending:0};
  readRows_('students').forEach(function(s){
    var id=String(s.id),active=!(String(s.active)==='false'||s.active===false);
    var mine=slots.filter(function(x){return String(x.studentId)===id&&x.status==='booked'&&String(x.date||'').slice(0,7)===ym;});
    var invoices=billingActiveInvoices_(id,ym);
    if(!active&&!mine.length&&!invoices.length)return;
    var p=billingPreview_(id,ym);if(p.error)return;
    var lessons=p.lessons||[],pending=p.pending||[],fees=p.fees||[];
    if(!mine.length&&!invoices.length&&!lessons.length&&!pending.length&&!fees.length)return;
    var undone=mine.filter(function(x){return !(x.done===true||String(x.done)==='true');}),fam=famOf[id]||null,inv=p.invoice,state,note='';
    if(invoices.length>1){state='review';note='この月の請求が重複しています。台帳を確認してください';}
    else if(inv){
      var isPaid=!!inv.paidDate||inv.status==='入金済';
      state=isPaid?'paid':(fam&&reported[fam.id]?'reported':'unpaid');
      note=isPaid?(inv.paidDate?inv.paidDate.slice(5).replace('-','/')+' '+(inv.method||'入金'):'入金済み'):(state==='reported'?'保護者から振込の連絡がありました':(inv.billDate?inv.billDate.slice(5).replace('-','/')+' に請求':'請求済み'));
    }
    else if(ym>=current){
      var late=undone.filter(function(x){return String(x.date)<today;}).length;
      state='open';note='実施 '+(mine.length-undone.length)+'回'+(undone.length-late?'・これから '+(undone.length-late)+'回':'')+(late?'・実施未登録 '+late+'件':'');
    }
    else if(undone.length){state='needDone';note=undone.length+'件の授業が実施未登録です';}
    else if(cancelReliefPending_(id,ym).length){state='relief';note='キャンセル料の減額・免除の申請があります';}
    else if(pending.length){state='needApproval';note=pending.length+'件が授業計画の承認待ちです';}
    else if(p.canBill){state='ready';note=p.carried?'前の月からの繰越 '+p.carried+'件を含みます':'';}
    else{state='review';note=String(p.reason||'');}
    var bySubject={},order=[];lessons.forEach(function(l){var k=String(l.subject||'授業');if(!(k in bySubject)){bySubject[k]=0;order.push(k);}bySubject[k]++;});
    var summary=order.map(function(k){return k+' '+bySubject[k]+'回';});if(fees.length)summary.push('キャンセル料 '+fees.length+'件');
    var amount=Number(p.amount)||0,pendingAmount=inv?0:(Number(p.pendingAmount)||0);
    if(inv&&invoices.length===1){totals.billed+=amount;if(state==='paid')totals.paid+=amount;else totals.unpaid+=amount;}
    else if(!inv){totals.open+=amount;totals.pending+=pendingAmount;}
    rows.push({studentId:id,name:String(s.name||''),active:active,familyId:fam?fam.id:'',familyLabel:fam?fam.label:'',state:state,note:note,summary:summary.join('・'),amount:amount,pendingAmount:pendingAmount,
      invoice:inv?{id:inv.id,amount:inv.amount,billDate:inv.billDate,paidDate:inv.paidDate,method:inv.method,paymentRevision:inv.paymentRevision}:null,
      signature:state==='reported'?reported[fam.id]:''});
  });
  rows.sort(function(a,b){var d=BILLING_OVERVIEW_ORDER_.indexOf(a.state)-BILLING_OVERVIEW_ORDER_.indexOf(b.state);return d||(a.name<b.name?-1:a.name>b.name?1:0);});
  return {ok:true,overview:{ym:ym,current:current,closed:ym<current,totals:totals,rows:rows}};
}
