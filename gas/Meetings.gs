// Scheduled meetings are separate from lessons, billing and historical meeting notes.
var MEETING_HEADERS_=["id","studentId","date","start","min","who","deliveryMode","note","status","eventId","meetUrl","createdAt"];
function meetingRows_(studentId) {
  return readRows_('meetingSchedules').filter(function(m){return m.status==='scheduled'&&(!studentId||String(m.studentId)===String(studentId));}).map(function(m){return Object.assign({},m,{min:Number(m.min),studentName:studentName_(m.studentId)});}).sort(slotSort_);
}
function meetingOverlap_(a,b) {return a.date===b.date&&schedulingMinutes_(a)<schedulingMinutes_(b)+Number(b.min)&&schedulingMinutes_(b)<schedulingMinutes_(a)+Number(a.min);}
function meetingCalendar_(m,student) {
  return schedulingCalendarFor_({studentId:m.studentId,requestId:m.id},Object.assign({},m,{subject:'ミーティング（'+m.who+'）'}),student);
}
function meetingCreate_(req) {
  var id=String(req.requestId||''),student=findStudent_(String(req.studentId||''));
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(id)||!student||String(student.active)==='false')return {error:'生徒を選び直してください'};
  var m={id:'meeting-'+id,studentId:String(student.id),date:String(req.date||''),start:String(req.start||''),min:Number(req.min),who:String(req.who||''),deliveryMode:String(req.deliveryMode||''),note:String(req.note||'').trim()};
  if(!billingSlotValid_(Object.assign({},m,{subject:'ミーティング'}))||m.min<15||m.min>180||m.min%15||['保護者','生徒','保護者・生徒'].indexOf(m.who)<0||!schedulingMode_(m.deliveryMode)||m.note.length>500)return {error:'日時・時間・相手・形式を確認してください'};
  var prior=readRows_('meetingSchedules').filter(function(x){return x.id===m.id;})[0];
  if(prior){if(prior.status!=='scheduled'||Object.keys(m).some(function(k){return String(m[k])!==String(prior[k]);}))return {error:'登録内容が変わっています。画面を開き直してください'};return {ok:true};}
  if(m.date<todayStr_())return {error:'今日以降の日付を選んでください'};
  if(m.deliveryMode==='online'&&getConfig_('calendarSync')!=='on'&&!isTestStudent_(student))return {error:'オンラインの設定にはカレンダー連携を有効にしてください'};
  var occupied=readRows_('slots').filter(schedulingOccupied_).concat(meetingRows_());
  var badPending=false;readRows_('offerEdits').filter(function(w){return w.status!=='done';}).forEach(function(w){try{occupied.push(JSON.parse(w.afterJson).slot);}catch(e){badPending=true;}});
  if(badPending||occupied.some(function(s){return meetingOverlap_(m,s);}))return {error:'同じ時間帯に授業またはミーティングがあります'};
  if(teacherOff_(m.date,true).some(function(o){return offHits_(o,m.date,m.start,m.min);}))return {error:'先生の休みに重なっています'};
  billingEnsureColumns_(ss_(),'meetingSchedules',MEETING_HEADERS_);
  var cal=meetingCalendar_(m,student);m.status='scheduled';m.eventId=cal.eventId;m.meetUrl=cal.meetUrl;m.createdAt=new Date().toISOString();
  meetingPut_(m);return {ok:true};
}
function meetingCancel_(req) {
  var m=readRows_('meetingSchedules').filter(function(x){return x.id===String(req.meetingId)&&String(x.studentId)===String(req.studentId);})[0];
  if(!m)return {error:'ミーティングが見つかりません'};
  if(m.status==='cancelled')return {ok:true};
  if(m.eventId)Calendar.Events.remove('primary',String(m.eventId).split('@')[0],{sendUpdates:'none'});
  m.status='cancelled';m.meetUrl='';meetingPut_(m);return {ok:true};
}
function meetingRetry_(req) {
  var m=readRows_('meetingSchedules').filter(function(x){return x.id===String(req.meetingId)&&String(x.studentId)===String(req.studentId)&&x.status==='scheduled';})[0];
  if(!m)return {error:'ミーティングが見つかりません'};
  var cal=meetingCalendar_(m,findStudent_(m.studentId));m.eventId=cal.eventId||m.eventId;m.meetUrl=cal.meetUrl||m.meetUrl;meetingPut_(m);return {ok:true};
}

function meetingPut_(m) {var sh=sheet_('meetingSchedules'),rows=readRows_('meetingSchedules'),at=rows.findIndex(function(x){return x.id===m.id;});sh.getRange(at<0?sh.getLastRow()+1:at+2,1,1,MEETING_HEADERS_.length).setNumberFormat('@').setValues([MEETING_HEADERS_.map(function(k){return lessonSafeCell_(m[k]===undefined?'':m[k]);})]);memoClear_();}
