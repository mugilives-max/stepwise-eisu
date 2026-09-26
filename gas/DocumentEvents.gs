// Teacher-authenticated entry in adminOp_. Exact repeats are safe after a lost response.
function documentEventAdd_(req) {
  var student = systemStudent_(String(req.studentId || ''));
  if (!student || String(student.active) === 'false') return {error:'生徒を確認してください'};
  var date=String(req.date || ''), dateTo=String(req.dateTo || date), title=nlText_(req.title,40);
  if (!nlValidDate_(date) || !nlValidDate_(dateTo) || dateTo < date || dateTo > addDays_(date,60) || !title) return {error:'日付・期間・内容を確認してください'};
  var kind=req.test===true?'test':'event';
  var existing=eventRows_().some(function(e){return String(e.studentId)===String(student.id) && e.date===date && e.dateTo===dateTo && e.title===title && e.kind===kind;});
  if (existing) return {ok:true,existing:true};
  var result=eventAdd_({k:student.code,date:date,dateTo:dateTo,title:title,kind:kind,alsoBlock:false},true);
  return result.error ? {error:result.error} : {ok:true};
}
