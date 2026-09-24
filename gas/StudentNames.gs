// Name parts are explicit; never guess a split of a Japanese full name.
function studentNameParts_(id) {
  if (!ss_().getSheetByName('studentNames')) return {familyName:'',givenName:''};
  var r=readRows_('studentNames').filter(function(x){return String(x.id)===String(id);})[0]||{};
  return {familyName:String(r.familyName||''),givenName:String(r.givenName||'')};
}
function saveStudentNameParts_(student, familyName, givenName) {
  var f=String(familyName||'').trim(),g=String(givenName||'').trim();
  if (!!f !== !!g || f.length>80 || g.length>80) return {error:'姓と名を両方入力してください（各80文字以内）'};
  if (f && (f+g).replace(/\s/g,'') !== String(student.name).replace(/\s/g,'')) return {error:'姓と名を合わせた氏名が登録済みの氏名と一致しません'};
  var sh=ensureSheet_(ss_(),'studentNames',['id','familyName','givenName']);
  var rows=readRows_('studentNames'),index=-1;rows.forEach(function(r,i){if(String(r.id)===String(student.id))index=i;});
  if(index<0)sh.appendRow([String(student.id),f,g]);else sh.getRange(index+2,1,1,3).setValues([[String(student.id),f,g]]);
  memoClear_();return {ok:true};
}
