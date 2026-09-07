/* 授業形式・同時人数・一括確定。HTTP mutation は Code.gs の ScriptLock 内で実行する。 */
var SCHEDULING_WRITE_COLS_=['id','studentId','requestId','slotsJson','completedJson','status','notificationState','createdAt','updatedAt','lastError'];

function ensureSchedulingSchema_() {
  billingEnsureColumns_(ss_(),'students',['id','name','active','email','code','rate30','monthly','parentToken','parentExp','deliveryMode']);
  billingEnsureColumns_(ss_(),'slots',['id','date','start','min','status','studentId','done','eventId','meetUrl','subject','req','deliveryMode']);
  billingEnsureColumns_(ss_(),'acceptWrites',SCHEDULING_WRITE_COLS_);
  memoClear_();
}
function schedulingMode_(value) { return value==='in_person'||value==='online'?value:''; }
function schedulingError_(message,code) { return {error:message,errorCode:code||'validation'}; }
function schedulingOccupied_(s) { return s.status==='offered'||s.status==='booked'; }
function schedulingMinutes_(s) { return Number(String(s.start).slice(0,2))*60+Number(String(s.start).slice(3)); }
function schedulingIntervalValid_(s) {
  // Occupancy depends on time, not the legacy subject label. Reuse the strict
  // interval bounds without rewriting an existing lesson's missing subject.
  return billingSlotValid_({date:s.date,start:s.start,min:s.min,subject:'授業'});
}

// 数え方は「重なる件数」ではなく、候補の時間内の各瞬間の人数。終了時刻を先に処理する。
function schedulingCapacityError_(candidate,allSlots,excludeId) {
  if(!billingSlotValid_(candidate))return schedulingError_('授業の日付・時刻・分数・科目を確認してください');
  var mode=schedulingMode_(candidate.deliveryMode);
  if(!mode)return schedulingError_('授業形式が未設定です。先生が対面・オンラインを設定してください','deliveryModeRequired');
  var begin=schedulingMinutes_(candidate),end=begin+Number(candidate.min),events=[],problem=null;
  (allSlots||readRows_('slots')).forEach(function(s){
    if(problem||!schedulingOccupied_(s)||String(s.id)===String(excludeId||'')||s.date!==candidate.date)return;
    if(!schedulingIntervalValid_(s)){problem=schedulingError_('同じ日の授業データに不正な時刻があります。先生が確認してください','capacity');return;}
    var from=schedulingMinutes_(s),to=from+Number(s.min);
    if(from>=end||to<=begin)return;
    if(!schedulingMode_(s.deliveryMode)){problem=schedulingError_('重なる授業の形式が未設定です。先生が確認してください','deliveryModeRequired');return;}
    if(String(s.studentId)===String(candidate.studentId)){problem=schedulingError_('同じ生徒の授業が重なっています','capacity');return;}
    if(mode==='online'||s.deliveryMode==='online'){problem=schedulingError_('オンライン授業は他の授業と同じ時間帯に設定できません','capacity');return;}
    events.push([Math.max(begin,from),1],[Math.min(end,to),-1]);
  });
  if(problem)return problem;
  events.sort(function(a,b){return a[0]-b[0]||a[1]-b[1];});
  var others=0;
  for(var i=0;i<events.length;i++){others+=events[i][1];if(others>1)return schedulingError_('対面授業は同じ時間帯に2人までです','capacity');}
  return null;
}

function schedulingSetDeliveryMode_(req) {
  var student=findStudent_(req.studentId),mode=schedulingMode_(req.deliveryMode);
  if(!student)return schedulingError_('生徒が見つかりません','notFound');
  if(!mode)return schedulingError_('対面・オンラインを選んでください');
  var rows=readRows_('students'),index=rows.findIndex(function(s){return String(s.id)===String(student.id);});
  sheet_('students').getRange(index+2,10).setValue(mode);
  return {ok:true,deliveryMode:mode,admin:adminState_()};
}
function schedulingPendingSlotMutation_(slotId,requestId) {
  var blocked=readRows_('acceptWrites').some(function(w){
    if(w.status==='done'||String(w.requestId)===String(requestId||''))return false;
    try{return JSON.parse(String(w.slotsJson)).some(function(s){return String(s.id)===String(slotId);});}catch(e){return true;}
  });
  return blocked?schedulingError_('この授業は一括確定を処理中です。生徒ページで同じ操作を再送してから変更してください','pending'):null;
}
// A mobile browser may discard its page before the response arrives. Return only
// this student's unfinished requests so the original key/selection can be
// restored after reload or on another device. Never return journal internals.
function schedulingPendingForStudent_(studentId) {
  var id=String(studentId),seen=Object.create(null);
  return readRows_('acceptWrites').filter(function(w){return String(w.studentId)===id&&w.status!=='done';}).map(function(w){
    var slots;try{slots=JSON.parse(String(w.slotsJson));}catch(e){throw new Error('一括確定の保存内容を先生が確認してください');}
    if(!Array.isArray(slots)||!slots.length||slots.length>31||slots.some(function(s){return String(s.studentId)!==id;})||seen[String(w.requestId)])throw new Error('一括確定の保存内容を先生が確認してください');
    seen[String(w.requestId)]=true;
    return {requestId:String(w.requestId),slotIds:slots.map(function(s){return String(s.id);}),slots:slots.map(function(s){
      return {id:String(s.id),date:String(s.date),start:String(s.start),min:Number(s.min),subject:String(s.subject||''),deliveryMode:String(s.deliveryMode||'')};
    })};
  });
}
function schedulingSetSlotDeliveryMode_(req) {
  var r=findSlotRow_(req.slotId),mode=schedulingMode_(req.deliveryMode);
  if(!r||!schedulingOccupied_(r.slot)||String(r.slot.studentId)!==String(req.studentId))return schedulingError_('生徒の授業が見つかりません','notFound');
  if(!mode)return schedulingError_('対面・オンラインを選んでください');
  if(req.expectedMode===undefined||String(req.expectedMode)!==String(r.slot.deliveryMode||''))return schedulingError_('授業形式が変更されています。画面を更新してください','conflict');
  var gate=billingSlotMutable_(r.slot)||schedulingPendingSlotMutation_(r.slot.id);if(gate)return gate;
  if(String(r.slot.done)==='true')return schedulingError_('実施済みの授業形式は変更できません','conflict');
  var desired=Object.assign({},r.slot,{deliveryMode:mode});
  gate=schedulingCapacityError_(desired,undefined,desired.id);if(gate)return gate;
  // 先に Calendar を目的の状態へ収束させる。失敗時は元の形式を保持し、同じ指定で再送できる。
  var student=findStudent_(r.slot.studentId);
  try {
    if(r.slot.eventId)desired.meetUrl=schedulingUpdateCalendarMode_(desired,student);
    else if(r.slot.status==='booked'&&getConfig_('calendarSync')==='on'&&!isTestStudent_(student)){
      // Legacy bookings may have no event after an old Calendar failure or while
      // sync was off. This per-slot key recovers an ambiguous create without
      // requiring a new student confirmation or creating duplicate events.
      var calendar=schedulingCalendarFor_({studentId:String(r.slot.studentId),requestId:'slot-mode-'+String(r.slot.id)},desired,student);
      desired.eventId=calendar.eventId;desired.meetUrl=calendar.meetUrl;
      // The teacher may select the original mode after a pending online change.
      // Reuse the same event and converge its title/conference to that choice.
      if(desired.eventId)desired.meetUrl=schedulingUpdateCalendarMode_(desired,student);
    } else if(mode==='in_person')desired.meetUrl='';
  } catch(e){return schedulingError_('カレンダーの形式変更を確認できませんでした。同じ内容で再試行してください','pending');}
  r.slot=desired;writeSlotRow_(r);
  return {ok:true,deliveryMode:mode,admin:adminState_()};
}

function schedulingAdminOffer_(req) {
  var student=findStudent_(req.studentId);
  if(!student)return schedulingError_('案内する生徒をえらんでください');
  var mode=schedulingMode_(req.deliveryMode===undefined?student.deliveryMode:req.deliveryMode),repeat=req.repeat==null?1:Number(req.repeat);
  if(!mode)return schedulingError_('生徒の授業形式を設定するか、この案内の形式を選んでください','deliveryModeRequired');
  if(!Number.isInteger(repeat)||repeat<1||repeat>12||!billingSlotValid_(req))return schedulingError_('正しい日付・時刻・授業分数・科目を入力してください');
  var existing=readRows_('slots'),candidates=[],conflicts=[],blocks=blockedRows_(),offs=teacherOff_(req.date,true),warnings=[];
  for(var w=0;w<repeat;w++){
    var s={id:uid_(),date:addDays_(req.date,w*7),start:req.start,min:Number(req.min),status:'offered',studentId:student.id,done:'',eventId:'',meetUrl:'',subject:String(req.subject).trim(),req:'',deliveryMode:mode};
    var gate=billingMonthUnlocked_(student.id,s.date.slice(0,7))||schedulingCapacityError_(s,existing.concat(candidates));
    if(gate)conflicts.push({date:s.date,start:s.start,error:gate.error,errorCode:gate.errorCode});
    if(!req.force){
      if(blocks.some(function(b){return String(b.studentId)===String(student.id)&&offHits_(b,s.date,s.start,s.min);}))warnings.push(fmtDateJa_(s.date)+' は生徒が授業できない日時です');
      if(offs.some(function(o){return offHits_(o,s.date,s.start,s.min);}))warnings.push(fmtDateJa_(s.date)+' は先生の休みに登録されています');
    }
    candidates.push(s);
  }
  if(conflicts.length)return {error:'重なる授業・月間計画を確認してください。案内は追加していません',errorCode:conflicts[0].errorCode,conflicts:conflicts};
  if(warnings.length)return {error:warnings.join('。'),needForce:true};
  var sh=sheet_('slots'),values=candidates.map(function(s){return [s.id,s.date,s.start,s.min,s.status,s.studentId,s.done,s.eventId,s.meetUrl,s.subject,s.req,s.deliveryMode];});
  // 12回分も1回の Sheets 書き込み。途中までの追加・行ごとの再読み込みを避ける。
  sh.getRange(sh.getLastRow()+1,1,values.length,12).setValues(values);
  addLog_('先生が'+student.name+'さんに'+candidates.length+'件案内('+fmtDateJa_(req.date)+' '+req.start+'・'+(mode==='online'?'オンライン':'対面')+')');
  offerMailToStudent_(student,candidates.map(function(s){return fmtDateJa_(s.date);}),req.start,Number(req.min),String(req.subject).trim());
  return {ok:true,added:candidates.length,admin:adminState_()};
}

function schedulingHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
}
function schedulingEventId_(write,slot) { return 'st'+schedulingHash_(String(write.studentId)+'|'+write.requestId+'|'+slot.id); }
function schedulingCalendarBody_(slot,student,eventId) {
  var body={id:eventId,summary:CAL_TITLE_PREFIX+student.name+'さん '+(slot.subject||'授業')+' ('+(slot.deliveryMode==='online'?'オンライン':'対面')+')',
    start:{dateTime:dateTimeOf_(slot.date,slot.start).toISOString(),timeZone:TZ},
    end:{dateTime:new Date(dateTimeOf_(slot.date,slot.start).getTime()+Number(slot.min)*60000).toISOString(),timeZone:TZ},
    reminders:{useDefault:false,overrides:[{method:'popup',minutes:60}]},
    extendedProperties:{private:{stepwiseSlot:String(slot.id),stepwiseStudent:String(student.id)}}};
  var email=normEmail_(student.email);if(email)body.attendees=[{email:email}];
  if(slot.deliveryMode==='online')body.conferenceData={createRequest:{requestId:eventId,conferenceSolutionKey:{type:'hangoutsMeet'}}};
  return body;
}
function schedulingCalendarMeet_(event) {
  if(event.hangoutLink)return String(event.hangoutLink);
  var points=event.conferenceData&&event.conferenceData.entryPoints||[];
  for(var i=0;i<points.length;i++)if(points[i].entryPointType==='video')return String(points[i].uri||'');
  return '';
}
function schedulingConferenceStatus_(event) {
  var request=event.conferenceData&&event.conferenceData.createRequest;
  return String(request&&request.status&&request.status.statusCode||'');
}
function schedulingConferenceRequest_(id,event) {
  return {createRequest:{requestId:'st'+schedulingHash_(id+'|online|'+String(event.etag||event.updated||'')),conferenceSolutionKey:{type:'hangoutsMeet'}}};
}
function schedulingRequireMeet_(event) {
  var meet=schedulingCalendarMeet_(event),status=schedulingConferenceStatus_(event);
  if(!meet||status==='pending'||status==='failure')throw new Error('オンライン授業のMeetを確認できませんでした。同じ操作で再試行してください');
  return meet;
}
function schedulingCalendarMissing_(err) { return /\b404\b|not found/i.test(String(err)); }
function schedulingCalendarConflict_(err) { return /\b409\b|already exists|identifier.*exists/i.test(String(err)); }
function schedulingCalendarFor_(write,slot,student) {
  if(isTestStudent_(student)||getConfig_('calendarSync')!=='on')return {eventId:'',meetUrl:''};
  var id=schedulingEventId_(write,slot),event,existing=false;
  try{event=Calendar.Events.get('primary',id);existing=true;}catch(e){if(!schedulingCalendarMissing_(e))throw e;}
  if(!event){
    try{event=Calendar.Events.insert(schedulingCalendarBody_(slot,student,id),'primary',{conferenceDataVersion:1,sendUpdates:'all'});}
    catch(e){if(!schedulingCalendarConflict_(e))throw e;event=Calendar.Events.get('primary',id);existing=true;}
  }
  var identity=event.extendedProperties&&event.extendedProperties.private||{};
  if(event.status==='cancelled'||String(identity.stepwiseSlot)!==String(slot.id)||String(identity.stepwiseStudent)!==String(student.id))throw new Error('Calendar event identity mismatch');
  if(slot.deliveryMode==='online'&&existing&&(!event.conferenceData||schedulingConferenceStatus_(event)==='failure')){
    // Failed requests cannot be reused. The event etag yields a fresh request ID;
    // an ambiguous patch is recovered by reading that same event on the next try.
    event=Calendar.Events.patch({conferenceData:schedulingConferenceRequest_(id,event)},'primary',id,{conferenceDataVersion:1,sendUpdates:'all'});
  }
  return {eventId:String(event.iCalUID||event.id+'@google.com'),meetUrl:slot.deliveryMode==='online'?schedulingRequireMeet_(event):''};
}
function schedulingUpdateCalendarMode_(slot,student) {
  if(!slot.eventId||isTestStudent_(student))return slot.deliveryMode==='online'?String(slot.meetUrl||''):'';
  var id=String(slot.eventId).split('@')[0],current=Calendar.Events.get('primary',id),body={},summary=CAL_TITLE_PREFIX+student.name+'さん '+(slot.subject||'授業')+' ('+(slot.deliveryMode==='online'?'オンライン':'対面')+')';
  if(String(current.summary)!==summary)body.summary=summary;
  if(slot.deliveryMode==='online'){
    // Existing or pending conference survives retries. A later in-person -> online
    // change uses the new event etag, allowing a fresh conference after removal.
    if(!current.conferenceData||schedulingConferenceStatus_(current)==='failure')body.conferenceData=schedulingConferenceRequest_(id,current);
  }
  else if(current.conferenceData||current.hangoutLink)body.conferenceData=null;
  var event=Object.keys(body).length?Calendar.Events.patch(body,'primary',id,{conferenceDataVersion:1,sendUpdates:'all'}):current;
  return slot.deliveryMode==='online'?schedulingRequireMeet_(event):'';
}

function schedulingWrite_(w) {
  w.updatedAt=billingStamp_();
  var sh=sheet_('acceptWrites'),row=w._row||sh.getLastRow()+1;
  sh.getRange(row,1,1,SCHEDULING_WRITE_COLS_.length).setNumberFormat('@').setValues([SCHEDULING_WRITE_COLS_.map(function(k){return billingText_(w[k]==null?'':w[k]);})]);
  w._row=row;
}
function schedulingSnapshot_(s) { return {id:String(s.id),studentId:String(s.studentId),date:s.date,start:s.start,min:Number(s.min),subject:String(s.subject||''),deliveryMode:String(s.deliveryMode||'')}; }
function schedulingBatchGate_(slots,allSlots) {
  var aggregate=Object.create(null);
  for(var i=0;i<slots.length;i++){
    var s=slots[i],gate=billingSlotAllowed_(s)||schedulingCapacityError_(s,allSlots,s.id);if(gate)return {slotId:s.id,error:gate.error,errorCode:gate.errorCode};
    if(s.status==='booked')continue;
    var key=String(s.studentId)+'|'+s.date.slice(0,7)+'|'+String(s.subject);
    if(!aggregate[key]){
      var a=billingAgreement_(s.studentId,s.date.slice(0,7)),limit=0;
      billingPlanJson_(a).forEach(function(p){if(p.subject===s.subject)limit=Number(p.count);});
      aggregate[key]={limit:limit,count:allSlots.filter(function(b){return b.status==='booked'&&String(b.studentId)===String(s.studentId)&&b.date.slice(0,7)===s.date.slice(0,7)&&b.subject===s.subject;}).length};
    }
    aggregate[key].count++;
    if(aggregate[key].count>aggregate[key].limit)return {slotId:s.id,error:'選択した授業をすべて確定すると承認回数を超えます',errorCode:'planLimit'};
  }
  return null;
}
function schedulingAcceptNotice_(student,slots) {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),'[ステップワイズ予約] 【確定】'+student.name+'さん '+slots.length+'件',
    student.name+'さんが案内を承認し、'+slots.length+'件の授業が確定しました。\n'+slots.map(function(s){return fmtDateJa_(s.date)+' '+s.start+'〜'+endTime_(s.start,s.min)+' '+s.subject+' ('+(s.deliveryMode==='online'?'オンライン':'対面')+')';}).join('\n'));
}
function schedulingResult_(write,code,slots,completed,error) {
  var doneIds=completed.map(function(c){return c.slotId;}),result={ok:write.status==='done',pending:write.status!=='done',completed:completed.length,
    results:slots.map(function(s){return {slotId:s.id,status:doneIds.indexOf(s.id)>=0?'booked':'pending'};}),state:studentState_(code),notification:write.notificationState||'pending'};
  if(error){result.error=error;result.errorCode='pending';}
  if(write.status==='done'&&(write.notificationState==='attempting'||write.notificationState==='uncertain')){
    result.notification='uncertain';result.warning='予約は確定しました。通知は届いているか確認してください。重複を防ぐため自動再送はしません';
  }
  return result;
}

function schedulingAccept_(slotId,code) {
  return schedulingAcceptMany_({k:code,slotIds:[slotId],requestId:'single-'+String(slotId||'')});
}
function schedulingAcceptMany_(req) {
  var student=findStudentByCode_(req.k);
  if(!student)return {error:'専用リンクからひらき直してください',badCode:true};
  var ids=req.slotIds,requestId=String(req.requestId||'');
  if(!Array.isArray(ids)||ids.length<1||ids.length>31||!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)||ids.some(function(id){return typeof id!=='string'||!id||id.length>100;})||new Set(ids).size!==ids.length)return schedulingError_('1〜31件の案内を選び直してください');
  ids=ids.slice().sort();
  var matches=readRows_('acceptWrites').filter(function(w){return String(w.studentId)===String(student.id)&&String(w.requestId)===requestId;});
  if(matches.length>1)return schedulingError_('確定処理の記録が重複しています。先生が台帳を確認してください','conflict');
  var write=matches[0],snapshots,completed=[],all=readRows_('slots');
  if(write){
    write._row=readRows_('acceptWrites').findIndex(function(w){return String(w.id)===String(write.id);})+2;
    try{snapshots=JSON.parse(String(write.slotsJson));completed=JSON.parse(String(write.completedJson));}catch(e){return schedulingError_('確定処理の保存内容を確認してください','conflict');}
    if(JSON.stringify(snapshots.map(function(s){return s.id;}).sort())!==JSON.stringify(ids))return schedulingError_('同じ処理番号で選択内容を変更できません。元の選択内容で再送してください','conflict');
    if(write.status==='done')return schedulingResult_(write,req.k,snapshots,completed);
  } else {
    var selected=[],invalid=null;
    ids.forEach(function(id){
      var r=findSlotRow_(id);
      if(!r||String(r.slot.studentId)!==String(student.id)||r.slot.status!=='offered')invalid={slotId:id,error:'承認できない案内が含まれています。画面を更新してください',errorCode:'conflict'};
      else {var busy=schedulingPendingSlotMutation_(id);if(busy)invalid={slotId:id,error:busy.error,errorCode:busy.errorCode};selected.push(r.slot);}
    });
    invalid=invalid||schedulingBatchGate_(selected,all);
    if(invalid)return {error:invalid.error,errorCode:invalid.errorCode,completed:0,pending:false,results:ids.map(function(id){return {slotId:id,status:id===String(invalid.slotId)?'error':'pending',error:id===String(invalid.slotId)?invalid.error:undefined};})};
    snapshots=selected.map(schedulingSnapshot_);
    write={id:billingId_(),studentId:String(student.id),requestId:requestId,slotsJson:JSON.stringify(snapshots),completedJson:'[]',status:'pending',notificationState:'pending',createdAt:billingStamp_(),lastError:''};
    // If the journal write succeeds but its response is lost, the same requestId finds it.
    try{schedulingWrite_(write);}catch(e){return schedulingResult_(write,req.k,snapshots,[], '確定処理の保存を確認できませんでした。同じ選択で再送してください');}
  }
  try {
    var current=[];
    for(var si=0;si<snapshots.length;si++){
      var row=findSlotRow_(snapshots[si].id);
      if(!row||['offered','booked'].indexOf(row.slot.status)<0||JSON.stringify(schedulingSnapshot_(row.slot))!==JSON.stringify(snapshots[si]))throw new Error('途中の案内が変更されています。先生が確認してください');
      current.push(row.slot);
    }
    // Already-booked rows are durable outcomes, including a lost journal receipt.
    // Their receipt/notice recovery must remain possible if an invoice was issued
    // afterward. Only still-offered rows need a fresh approval/capacity decision.
    var gate=schedulingBatchGate_(current.filter(function(s){return s.status==='offered';}),readRows_('slots'));if(gate)throw new Error(gate.error);
    for(var i=0;i<snapshots.length;i++){
      var snapshot=snapshots[i];
      if(completed.some(function(c){return c.slotId===snapshot.id;}))continue;
      var r=findSlotRow_(snapshot.id);
      if(r.slot.status==='offered'){
        var calendar=schedulingCalendarFor_(write,r.slot,student);
        r.slot.status='booked';r.slot.eventId=calendar.eventId;r.slot.meetUrl=calendar.meetUrl;
        writeSlotRow_(r);
      }
      completed.push({slotId:snapshot.id});write.completedJson=JSON.stringify(completed);schedulingWrite_(write);
    }
    if(write.notificationState==='pending'){
      if(isTestStudent_(student)||getConfig_('emailNotify')!=='on')write.notificationState='skipped';
      else {
        // Mail has no idempotency key. Claim once before sending; uncertain sends are
        // surfaced for human review instead of silently sending the same message twice.
        write.notificationState='attempting';schedulingWrite_(write);
        try{schedulingAcceptNotice_(student,snapshots);write.notificationState='sent';}
        catch(e){write.notificationState='uncertain';}
      }
    }
    if(write.notificationState==='attempting')write.notificationState='uncertain';
    write.status='done';write.lastError='';schedulingWrite_(write);
    return schedulingResult_(write,req.k,snapshots,completed);
  } catch(err) {
    write.status='pending';
    write.lastError='一括確定の途中です。同じ選択で再送してください';
    // An unavailable Sheet must not conceal already committed bookings. The next
    // request reads the durable journal/slots and recovers even if this save fails.
    try{schedulingWrite_(write);}catch(ignored){}
    return schedulingResult_(write,req.k,snapshots,completed,write.lastError);
  }
}
