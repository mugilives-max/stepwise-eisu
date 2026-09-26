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
      children.forEach(function(c){var p=billingPreview_(c.studentId,ym);if(billingActiveInvoices_(c.studentId,ym).length>1){blocked=true;return;}if(p.invoice)return;
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
