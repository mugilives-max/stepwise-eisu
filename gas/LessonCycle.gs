/** Teacher-only lesson records. Code.gs dispatches these operations while holding
 * ScriptLock. Never add these objects to studentState, parentData or MCP output.
 * No operation here changes slots, plans, billing, Calendar or notifications. */
var LESSON_HEADERS_ = {
  lessonRecords: ['id','studentId','slotId','lessonDate','lessonStart','lessonMin','subject','content','progress','nextFocus','homeworkJson','revision','status','createdBy','updatedBy','createdAt','updatedAt','voidReason','lastRequestId','lastRequestHash'],
  lessonPrivateNotes: ['recordId','teacherNote'],
  lessonReportDrafts: ['recordId','body','sourceRevision','revision','updatedAt'],
  lessonWrites: ['requestId','operation','payloadHash','payloadJson','status','resultJson','createdAt','updatedAt'],
  tasks: ['id','studentId','type','title','due','createdAt','createdBy','doneAt','sourceRecordId','sourceItemId','sourceRevision','withdrawnAt']
};
var LESSON_SCHEMA_BOOK_ = null; // Per-execution only; never CacheService.

// Preflight every header before changing any sheet. Existing task rows and their
// first eight columns stay in place. A partially appended header is resumable.
function ensureLessonSchema_() {
  var ss = ss_();
  if (LESSON_SCHEMA_BOOK_ === ss) return;
  Object.keys(LESSON_HEADERS_).forEach(function (name) {
    var sh = ss.getSheetByName(name), expected = LESSON_HEADERS_[name];
    if (!sh || !sh.getLastRow()) return;
    var actual = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    if (actual.length > expected.length || (name === 'tasks' && actual.length < 8) || actual.some(function (x,i) { return String(x) !== expected[i]; })) {
      lessonFail_('validation', '授業記録のシート構成が一致しません。移行を停止しました');
    }
  });
  Object.keys(LESSON_HEADERS_).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name), headers = LESSON_HEADERS_[name];
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    if (!sh.getLastRow() || sh.getLastColumn() !== headers.length) sh.getRange(1,1,1,headers.length).setValues([headers]);
    delete MEMO_.rows[name];
  });
  LESSON_SCHEMA_BOOK_ = ss;
}

function lessonFail_(code, message, extra) {
  var err = new Error(message); err.lessonCode = code; err.lessonExtra = extra || {}; throw err;
}
function lessonError_(err) {
  var out = { error: err.lessonCode ? err.message : '処理を完了できませんでした。入力を保持して再試行してください', errorCode: err.lessonCode || 'pending' };
  Object.keys(err.lessonExtra || {}).forEach(function (k) { out[k] = err.lessonExtra[k]; });
  return out;
}
function lessonRows_(name) {
  return readRows_(name).map(function (r,i) { r._row = i + 2; return r; });
}
function lessonFind_(name, key, id) {
  var found = lessonRows_(name).filter(function (r) { return String(r[key]) === String(id); });
  if (found.length > 1) lessonFail_('conflict', '重複した記録があるため処理を停止しました');
  return found[0] || null;
}
function lessonText_(x, max, required) {
  if (x === undefined && !required) return '';
  if (typeof x !== 'string' || x.length > max || (required && !x.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)) lessonFail_('validation', '入力内容の型・必須項目・文字数を確認してください');
  return x.replace(/\r\n?/g, '\n');
}
function lessonId_(x) {
  if (typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/.test(x)) lessonFail_('validation', '識別IDが正しくありません');
  return x;
}
function lessonInteger_(x, min) {
  if (typeof x !== 'number' || !isFinite(x) || Math.floor(x) !== x || x < min || x > 1000000000) lessonFail_('validation', '版数が正しくありません');
  return x;
}
function lessonOnly_(x, fields) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(function (k) { return fields.indexOf(k) < 0; })) lessonFail_('validation', '未対応の入力項目があります');
}
function lessonDate_(x) {
  x = lessonText_(x,10,false);
  if (!x) return '';
  var parsed=new Date(x + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || x < '1900-01-01' || x > '2199-12-31' || !isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== x) lessonFail_('validation','日付が正しくありません');
  return x;
}
function lessonHomework_(items) {
  if (!Array.isArray(items) || items.length > 10) lessonFail_('validation', '宿題は10件以内で入力してください');
  var ids = Object.create(null);
  return items.map(function (x) {
    lessonOnly_(x,['itemId','title','due','type']);
    var id = lessonId_(x.itemId);
    if (ids[id]) lessonFail_('validation','宿題の項目IDが重複しています'); ids[id] = true;
    var type = x.type === undefined ? '宿題' : x.type;
    if (['宿題','持ち物','メモ'].indexOf(type) < 0) lessonFail_('validation','宿題の種類が正しくありません');
    return { itemId:id, title:lessonText_(x.title,80,true), due:lessonDate_(x.due), type:type };
  });
}
function lessonPayload_(req) {
  var base = ['action','op','token','from','view','studentId','requestId'];
  var allowed = {
    lessonRecordSave:['slotId','expectedRevision','record'],
    lessonHomeworkApply:['recordId','expectedRevision'],
    lessonHomeworkWithdraw:['recordId','itemId','expectedRevision'],
    lessonReportDraftSave:['recordId','expectedDraftRevision','sourceRevision','body'],
    lessonRecordVoid:['recordId','expectedRevision','reason']
  };
  if (!allowed[req.op]) lessonFail_('validation','未対応の操作です');
  lessonOnly_(req,base.concat(allowed[req.op]));
  var p = { operation:req.op, studentId:lessonId_(req.studentId) };
  if (req.op === 'lessonRecordSave') {
    p.slotId = lessonId_(req.slotId); p.expectedRevision = lessonInteger_(req.expectedRevision,0);
    lessonOnly_(req.record,['content','progress','nextFocus','teacherNote','homework']);
    p.record = { content:lessonText_(req.record.content,2000,true), progress:lessonText_(req.record.progress,1000,false), nextFocus:lessonText_(req.record.nextFocus,1000,false), teacherNote:lessonText_(req.record.teacherNote,2000,false), homework:lessonHomework_(req.record.homework === undefined ? [] : req.record.homework) };
  } else {
    p.recordId = lessonId_(req.recordId);
    if (req.op === 'lessonReportDraftSave') {
      p.expectedDraftRevision = lessonInteger_(req.expectedDraftRevision,0); p.sourceRevision = lessonInteger_(req.sourceRevision,1); p.body = lessonText_(req.body,4000,false);
    } else {
      if (req.op !== 'lessonHomeworkWithdraw' || req.expectedRevision !== undefined) p.expectedRevision = lessonInteger_(req.expectedRevision,1);
      if (req.op === 'lessonHomeworkWithdraw') p.itemId = lessonId_(req.itemId);
      if (req.op === 'lessonRecordVoid') p.reason = lessonText_(req.reason,500,true);
    }
  }
  return p;
}
function lessonActive_(s) { return s && !(s.active === false || String(s.active) === 'false'); }
function lessonStudent_(id) {
  var s = systemStudent_(id); if (!s) lessonFail_('notFound','生徒が見つかりません'); return s;
}
function lessonOwnedRecord_(id, studentId) {
  var r = lessonFind_('lessonRecords','id',id);
  if (!r || String(r.studentId) !== studentId) lessonFail_('notFound','授業記録が見つかりません');
  return r;
}
function lessonSlotChanged_(r) {
  var slot = findSlotRow_(r.slotId);
  return !slot || String(slot.slot.studentId) !== String(r.studentId) || slot.slot.status !== 'booked' || slot.slot.date !== String(r.lessonDate) || slot.slot.start !== String(r.lessonStart) || Number(slot.slot.min) !== Number(r.lessonMin) || String(slot.slot.subject || '') !== String(r.subject || '');
}
function lessonCurrentSlot_(studentId,slotId,record) {
  var s = findSlotRow_(slotId);
  if (!s || String(s.slot.studentId) !== studentId || s.slot.status !== 'booked') lessonFail_('notFound','元の予約が取消・変更されています。記録の保存は停止しました');
  if (record && lessonSlotChanged_(record)) lessonFail_('conflict','元の予約の日時・科目が変更されています。記録の保存は停止しました');
  if (!lessonDate_(s.slot.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.slot.start) || Number(s.slot.min) <= 0 || Math.floor(Number(s.slot.min)) !== Number(s.slot.min)) lessonFail_('validation','予約の日時を確認してください');
  return s.slot;
}
function lessonRevision_(r,expected) { if (Number(r ? r.revision : 0) !== expected) lessonFail_('conflict','他の画面で更新されています。入力を残して最新を確認してください'); }
function lessonPending_(studentId,slotId,recordId) {
  return lessonRows_('lessonWrites').filter(function (w) {
    if (w.status !== 'pending') return false;
    var p; try { p = JSON.parse(w.payloadJson); } catch (e) { lessonFail_('pending','未完了処理の記録を確認してください'); }
    return p.studentId === studentId && (p.recordId === recordId || p.slotId === slotId);
  });
}
function lessonSafeCell_(x) {
  // setValues treats leading '=' as a formula even in a text-formatted cell.
  // A Sheets literal marker also preserves a user's initial apostrophe.
  return typeof x === 'string' && /^[=+@'\-]/.test(x) ? "'" + x : x;
}
function lessonPut_(name,key,id,obj) {
  var old = lessonFind_(name,key,id), sh = sheet_(name), headers = LESSON_HEADERS_[name];
  var row = headers.map(function (h) { return lessonSafeCell_(obj[h] === undefined ? '' : obj[h]); });
  sh.getRange(old ? old._row : sh.getLastRow()+1,1,1,headers.length).setNumberFormat('@').setValues([row]);
}
function lessonCopy_(x) {
  var out = {}; Object.keys(x).forEach(function (k) { if (k !== '_row' && k !== 'date' && k !== 'start') out[k] = x[k]; }); return out;
}
function lessonHomeworkItems_(r) {
  var items; try { items = JSON.parse(r.homeworkJson || '[]'); } catch (e) { lessonFail_('validation','保存済みの宿題データを確認してください'); }
  return lessonHomework_(items);
}
function lessonRawTasks_(recordId) { return lessonRows_('tasks').filter(function (t) { return String(t.sourceRecordId || '') === recordId; }); }
function lessonTask_(recordId,itemId,studentId) {
  var all = lessonRawTasks_(recordId).filter(function (t) { return String(t.sourceItemId) === itemId; });
  if (all.length > 1) lessonFail_('conflict','宿題の対応IDが重複しています');
  if (all[0] && String(all[0].studentId) !== studentId) lessonFail_('notFound','宿題の対象が一致しません');
  return all[0] || null;
}
function lessonTaskSame_(task,item) { return String(task.title) === item.title && (normDate_(task.due) || '') === item.due && String(task.type) === item.type; }

function lessonPlan_(p,requestId,hash) {
  var student = lessonStudent_(p.studentId), now = new Date().toISOString(), r, slot;
  if (p.operation === 'lessonRecordSave') {
    var records = lessonRows_('lessonRecords').filter(function (x) { return String(x.studentId) === p.studentId && String(x.slotId) === p.slotId && x.status === 'active'; });
    if (records.length > 1) lessonFail_('conflict','有効な授業記録が重複しています');
    r = records[0] || null;
    if (!r && !lessonActive_(student)) lessonFail_('validation','停止中の生徒へ新規記録は作成できません');
    slot = lessonCurrentSlot_(p.studentId,p.slotId,r); lessonRevision_(r,p.expectedRevision);
  } else {
    r = lessonOwnedRecord_(p.recordId,p.studentId); p.slotId = String(r.slotId);
    if (p.expectedRevision !== undefined) lessonRevision_(r,p.expectedRevision);
    if (r.status !== 'active' && p.operation !== 'lessonHomeworkWithdraw') lessonFail_('conflict','無効化された記録は更新できません');
    if (p.operation === 'lessonHomeworkApply') {
      if (!lessonActive_(student)) lessonFail_('validation','停止中の生徒へ宿題は反映できません');
      lessonCurrentSlot_(p.studentId,p.slotId,r);
    }
    if (p.operation === 'lessonReportDraftSave') {
      lessonCurrentSlot_(p.studentId,p.slotId,r); lessonRevision_(r,p.sourceRevision);
      lessonRevision_(lessonFind_('lessonReportDrafts','recordId',r.id),p.expectedDraftRevision);
    }
  }
  var pending = lessonPending_(p.studentId,p.slotId,r ? String(r.id) : '');
  if (pending.length) lessonFail_('pending','前の保存を再開してください',{requestId:String(pending[0].requestId),retryRequired:true});
  var plan = { operation:p.operation, studentId:p.studentId, slotId:p.slotId, recordId:r ? String(r.id) : 'lr-' + uid_(), requestId:requestId, hash:hash, now:now, actor:'teacher:primary', input:p };
  if (p.operation === 'lessonRecordSave') {
    var saved = r ? lessonCopy_(r) : { id:plan.recordId, studentId:p.studentId, slotId:p.slotId, lessonDate:slot.date, lessonStart:slot.start, lessonMin:Number(slot.min), subject:String(slot.subject || ''), createdBy:plan.actor, createdAt:now, status:'active', voidReason:'' };
    saved.content=p.record.content; saved.progress=p.record.progress; saved.nextFocus=p.record.nextFocus; saved.homeworkJson=JSON.stringify(p.record.homework);
    saved.revision=p.expectedRevision+1; saved.updatedBy=plan.actor; saved.updatedAt=now; saved.lastRequestId=requestId; saved.lastRequestHash=hash;
    plan.record=saved; plan.note={recordId:plan.recordId,teacherNote:p.record.teacherNote};
  } else if (p.operation === 'lessonHomeworkApply') {
    plan.items = lessonHomeworkItems_(r).map(function (item) {
      var t = lessonTask_(String(r.id),item.itemId,p.studentId);
      return { item:item, taskId:t ? String(t.id) : 'lt-' + uid_() };
    }); plan.sourceRevision=Number(r.revision);
  } else if (p.operation === 'lessonHomeworkWithdraw') {
    var task = lessonTask_(String(r.id),p.itemId,p.studentId);
    if (!task) lessonFail_('notFound','反映済みの宿題が見つかりません');
    plan.itemId=p.itemId; plan.taskId=String(task.id);
  } else if (p.operation === 'lessonRecordVoid') {
    plan.record=lessonCopy_(r); plan.record.status='void'; plan.record.voidReason=p.reason; plan.record.revision=Number(r.revision)+1; plan.record.updatedAt=now; plan.record.updatedBy=plan.actor; plan.record.lastRequestId=requestId; plan.record.lastRequestHash=hash;
  } else if (p.operation === 'lessonReportDraftSave') {
    plan.draft={recordId:String(r.id),body:p.body,sourceRevision:p.sourceRevision,revision:p.expectedDraftRevision+1,updatedAt:now};
  }
  return plan;
}

// Deterministic row IDs and read-before-write make every step resumable. Reading
// the latest task here preserves completion made between an interrupted apply
// and its retry; never replay a captured doneAt over a student's newer value.
function lessonExecute_(plan) {
  var result = { ok:true,operation:plan.operation,recordId:plan.recordId,updatedAt:plan.now,retryRequired:false };
  if (plan.operation === 'lessonRecordSave') {
    // This write was validated before its journal was created. If the booking
    // changed during an interruption, finish the original student's historical
    // snapshot. Fresh writes still require the current booking to match.
    var existing=lessonFind_('lessonRecords','id',plan.recordId);
    if (existing && (String(existing.studentId) !== plan.studentId || String(existing.slotId) !== plan.slotId)) lessonFail_('pending','記録の対象が変更されたため再開を停止しました');
    lessonPut_('lessonPrivateNotes','recordId',plan.recordId,plan.note);
    lessonPut_('lessonRecords','id',plan.recordId,plan.record); result.revision=plan.record.revision;
  } else if (plan.operation === 'lessonHomeworkApply') {
    var r=lessonOwnedRecord_(plan.recordId,plan.studentId);
    result.added=[]; result.updated=[]; result.held=[]; result.unchanged=[]; result.withdrawn=[];
    if (!lessonActive_(lessonStudent_(plan.studentId)) || lessonSlotChanged_(r) || r.status !== 'active') {
      result.ok=false; result.error='対象の予約・在籍状態が変わったため、未反映の宿題を停止しました。反映済みの宿題は一覧で確認してください'; result.errorCode='conflict'; result.partial=true; result.failed=[];
      plan.items.forEach(function (entry) {
        var task=lessonTask_(plan.recordId,entry.item.itemId,plan.studentId);
        if (task && Number(task.sourceRevision) === plan.sourceRevision) result.unchanged.push(entry.item.itemId);
        else result.failed.push(entry.item.itemId);
      });
      return result;
    }
    plan.items.forEach(function (entry) {
      var item=entry.item, task=lessonTask_(plan.recordId,item.itemId,plan.studentId);
      if (task && task.withdrawnAt) { result.withdrawn.push(item.itemId); return; }
      if (task && task.doneAt && !lessonTaskSame_(task,item)) { result.held.push(item.itemId); return; }
      if (task && lessonTaskSame_(task,item) && Number(task.sourceRevision) === plan.sourceRevision) { result.unchanged.push(item.itemId); return; }
      var next=task ? lessonCopy_(task) : { id:entry.taskId,studentId:plan.studentId,createdAt:plan.now,createdBy:'teacher',doneAt:'',withdrawnAt:'',sourceRecordId:plan.recordId,sourceItemId:item.itemId };
      next.title=item.title; next.due=item.due; next.type=item.type; next.sourceRevision=plan.sourceRevision;
      lessonPut_('tasks','id',next.id,next); (task ? result.updated : result.added).push(item.itemId);
    });
    result.revision=plan.sourceRevision;
  } else if (plan.operation === 'lessonHomeworkWithdraw') {
    var task=lessonTask_(plan.recordId,plan.itemId,plan.studentId);
    if (!task || String(task.id) !== plan.taskId) lessonFail_('pending','対象宿題が変更されたため再開を停止しました');
    if (!task.withdrawnAt) { var next=lessonCopy_(task); next.withdrawnAt=plan.now; lessonPut_('tasks','id',next.id,next); }
    result.withdrawn=[plan.itemId];
  } else if (plan.operation === 'lessonRecordVoid') {
    lessonPut_('lessonRecords','id',plan.recordId,plan.record); result.revision=plan.record.revision;
  } else if (plan.operation === 'lessonReportDraftSave') {
    lessonOwnedRecord_(plan.recordId,plan.studentId);
    lessonPut_('lessonReportDrafts','recordId',plan.recordId,plan.draft); result.draftRevision=plan.draft.revision;
  }
  return result;
}
function lessonResume_(journal) {
  var plan=JSON.parse(journal.payloadJson), result;
  try {
    result=lessonExecute_(plan);
    journal.status=result.ok ? 'applied' : 'failed'; journal.resultJson=JSON.stringify(result); journal.updatedAt=new Date().toISOString();
    lessonPut_('lessonWrites','requestId',journal.requestId,journal);
  } catch (e) {
    // Journal remains pending, including when a completed mutation's receipt
    // could not be written. Do not log payloads or claim the whole apply passed.
    return { error:'保存が途中です。同じ操作を再開してください',errorCode:'pending',requestId:String(journal.requestId),recordId:plan.recordId,retryRequired:true };
  }
  return lessonResultContext_(result,plan);
}
function lessonResultContext_(result,plan) {
  result.context=lessonContextData_(plan.studentId,plan.slotId,plan.recordId); return result;
}
function lessonWrite_(req) {
  var requestId=lessonId_(req.requestId), payload=lessonPayload_(req), hash=hashPass_(JSON.stringify(payload),'lesson-write-v1');
  var existing=lessonFind_('lessonWrites','requestId',requestId);
  if (existing) {
    if (String(existing.payloadHash) !== hash || String(existing.operation) !== req.op) lessonFail_('conflict','同じリクエストIDの内容が変わっています');
    var oldPlan=JSON.parse(existing.payloadJson);
    if (oldPlan.studentId !== payload.studentId) lessonFail_('notFound','処理が見つかりません');
    if (existing.status === 'applied' || existing.status === 'failed') return lessonResultContext_(JSON.parse(existing.resultJson),oldPlan);
    return lessonResume_(existing);
  }
  var plan=lessonPlan_(payload,requestId,hash);
  var serialized=JSON.stringify(plan);
  if (serialized.length > 49000) lessonFail_('validation','保存内容が大きすぎます。文章量を減らしてください');
  var journal={requestId:requestId,operation:req.op,payloadHash:hash,payloadJson:serialized,status:'pending',resultJson:'',createdAt:plan.now,updatedAt:plan.now};
  lessonPut_('lessonWrites','requestId',requestId,journal);
  return lessonResume_(journal);
}

function lessonRecordView_(r,includePrivate) {
  if (!r) return null;
  var out={id:String(r.id),studentId:String(r.studentId),slotId:String(r.slotId),date:String(r.lessonDate),start:String(r.lessonStart),min:Number(r.lessonMin),subject:String(r.subject || ''),revision:Number(r.revision),status:String(r.status),content:String(r.content || ''),progress:String(r.progress || ''),nextFocus:String(r.nextFocus || ''),homework:lessonHomeworkItems_(r),updatedAt:String(r.updatedAt || ''),voidReason:String(r.voidReason || '')};
  if (includePrivate) { var note=lessonFind_('lessonPrivateNotes','recordId',r.id); out.teacherNote=note ? String(note.teacherNote || '') : ''; }
  return out;
}
function lessonTaskView_(t) {
  return {id:String(t.id),title:String(t.title || ''),due:normDate_(t.due) || '',type:String(t.type || '宿題'),done:!!t.doneAt,doneAt:t.doneAt ? String(t.doneAt) : '',sourceRecordId:String(t.sourceRecordId || ''),sourceItemId:String(t.sourceItemId || '')};
}
function lessonDraftTemplate_(r) {
  if (!r) return '';
  return ['授業内容\n'+r.content,r.progress ? '取り組みの様子\n'+r.progress : '',r.homework.length ? '宿題\n'+r.homework.map(function (x) { return x.title+(x.due ? '（'+x.due+'）' : ''); }).join('\n') : '',r.nextFocus ? '次回の焦点\n'+r.nextFocus : ''].filter(Boolean).join('\n\n');
}
function lessonContextData_(studentId,slotId,recordId) {
  var student=lessonStudent_(studentId), all=lessonRows_('lessonRecords').filter(function (x) { return String(x.studentId) === studentId; });
  if (!slotId) {
    var candidates=readRows_('slots').filter(function (x) { return String(x.studentId) === studentId && x.status === 'booked'; }).sort(function (a,b) { return (a.date+'T'+a.start) < (b.date+'T'+b.start) ? 1 : -1; });
    var history=all.slice().sort(function (a,b) { return String(a.lessonDate)+String(a.lessonStart) < String(b.lessonDate)+String(b.lessonStart) ? 1 : -1; });
    if (recordId) slotId=String(lessonOwnedRecord_(recordId,studentId).slotId);
    else if (candidates.length) {
      var past=candidates.filter(function (x) { return x.date <= todayStr_(); });
      slotId=String(past.length ? past[0].id : candidates[candidates.length-1].id);
    } else if (history.length) { slotId=String(history[0].slotId); recordId=String(history[0].id); }
    else return {student:{id:studentId,name:String(student.name || ''),active:lessonActive_(student)},slot:null,record:null,previous:null,otherPrevious:[],openTasks:lessonRows_('tasks').filter(function (t) { return String(t.studentId) === studentId && t.id && t.title && !t.doneAt && !t.withdrawnAt; }).map(lessonTaskView_),homeworkState:[],draft:null,draftTemplate:'',pending:null,slotChanged:false,lessonChoices:[]};
  }
  var r=recordId ? lessonOwnedRecord_(recordId,studentId) : all.filter(function (x) { return String(x.slotId) === slotId && x.status === 'active'; })[0] || null;
  if (r && String(r.slotId) !== slotId) lessonFail_('notFound','授業が一致しません');
  var actual=findSlotRow_(slotId), slot=actual && String(actual.slot.studentId) === studentId ? actual.slot : null;
  if (!slot && !r) lessonFail_('notFound','対象授業が見つかりません');
  var pending=lessonPending_(studentId,slotId,r ? String(r.id) : '');
  var lockedRecordIds={};
  lessonRows_('lessonWrites').filter(function (x) { return x.status === 'pending'; }).forEach(function (w) {
    var p=JSON.parse(w.payloadJson); lockedRecordIds[p.recordId]=true;
  });
  var reference=r || {lessonDate:slot.date,lessonStart:slot.start,subject:String(slot.subject || '')};
  var key=String(reference.lessonDate)+'T'+String(reference.lessonStart);
  var previous=all.filter(function (x) { return x.status === 'active' && !lockedRecordIds[x.id] && (String(x.lessonDate)+'T'+String(x.lessonStart)) < key; }).sort(function (a,b) { return (String(a.lessonDate)+'T'+String(a.lessonStart)) < (String(b.lessonDate)+'T'+String(b.lessonStart)) ? 1 : -1; });
  var same=previous.filter(function (x) { return String(x.subject || '') === String(reference.subject || ''); })[0] || null;
  var current=pending.length ? null : lessonRecordView_(r,true);
  var draft=r && !pending.length ? lessonFind_('lessonReportDrafts','recordId',r.id) : null;
  var tasks=lessonRows_('tasks').filter(function (x) { return String(x.studentId) === studentId; });
  var state=[];
  if (current) {
    var ids={};
    current.homework.forEach(function (item) {
      ids[item.itemId]=true; var t=lessonTask_(current.id,item.itemId,studentId);
      state.push({itemId:item.itemId,taskId:t ? String(t.id) : '',title:item.title,due:item.due,type:item.type,done:!!(t && t.doneAt),withdrawn:!!(t && t.withdrawnAt),status:!t ? 'new' : t.withdrawnAt ? 'withdrawn' : t.doneAt && !lessonTaskSame_(t,item) ? 'held' : lessonTaskSame_(t,item) ? 'applied' : 'changed'});
    });
    lessonRawTasks_(current.id).forEach(function (t) { if (!ids[String(t.sourceItemId)] && String(t.studentId) === studentId) state.push({itemId:String(t.sourceItemId),taskId:String(t.id),title:String(t.title),due:normDate_(t.due)||'',type:String(t.type),done:!!t.doneAt,withdrawn:!!t.withdrawnAt,status:t.withdrawnAt ? 'withdrawn' : 'removed'}); });
  }
  var choices=readRows_('slots').filter(function (x) { return String(x.studentId) === studentId && x.status === 'booked'; }).map(function (x) {
    var record=all.filter(function (z) { return z.status === 'active' && String(z.slotId) === String(x.id); })[0];
    return {id:String(x.id),recordId:record ? String(record.id) : '',date:x.date,start:x.start,min:Number(x.min),subject:String(x.subject || ''),status:x.status,done:x.done === true || String(x.done) === 'true',slotChanged:record ? lessonSlotChanged_(record) : false,recordStatus:record ? record.status : ''};
  });
  all.forEach(function (x) {
    if (!choices.some(function (c) { return c.recordId === String(x.id); })) choices.push({id:String(x.slotId),recordId:String(x.id),date:String(x.lessonDate),start:String(x.lessonStart),min:Number(x.lessonMin),subject:String(x.subject || ''),status:'history',done:false,slotChanged:lessonSlotChanged_(x),recordStatus:String(x.status)});
  });
  choices.sort(function (a,b) { return (a.date+'T'+a.start) < (b.date+'T'+b.start) ? 1 : -1; });
  return {student:{id:studentId,name:String(student.name || ''),active:lessonActive_(student)},slot:slot ? {id:String(slot.id),date:slot.date,start:slot.start,min:Number(slot.min),subject:String(slot.subject || ''),status:slot.status,done:slot.done === true || String(slot.done) === 'true'} : {id:slotId,date:String(r.lessonDate),start:String(r.lessonStart),min:Number(r.lessonMin),subject:String(r.subject || ''),status:'missing',done:false},record:current,previous:lessonRecordView_(same,false),otherPrevious:previous.filter(function (x) { return String(x.subject || '') !== String(reference.subject || ''); }).map(function (x) { return {id:String(x.id),slotId:String(x.slotId),date:String(x.lessonDate),subject:String(x.subject || '')}; }),openTasks:tasks.filter(function (t) { return t.id && t.title && !t.doneAt && !t.withdrawnAt; }).map(lessonTaskView_),homeworkState:state,draft:draft ? {body:String(draft.body || ''),revision:Number(draft.revision),sourceRevision:Number(draft.sourceRevision),updatedAt:String(draft.updatedAt || ''),stale:Number(draft.sourceRevision)!==Number(r.revision)} : null,draftTemplate:lessonDraftTemplate_(current ? lessonRecordView_(r,false) : null),pending:pending.length ? {requestId:String(pending[0].requestId),operation:String(pending[0].operation)} : null,slotChanged:r ? lessonSlotChanged_(r) : !slot || slot.status !== 'booked',lessonChoices:choices};
}

// Caller must hold ScriptLock (doPost also serializes legacy task completion).
function lessonAdmin_(req) {
  try {
    if (!req || req.mcpKey !== undefined || !req.token || authMode_() !== 'account' || !authOk_(req)) return {error:'先生としてログインし直してください',badAuth:true};
    if (getConfig_('lessonCycleEnabled') === 'off') return {error:'授業記録は準備中です',errorCode:'disabled'};
    memoClear_(); ensureLessonSchema_();
    if (req.op === 'lessonContext') {
      lessonOnly_(req,['action','op','token','from','view','studentId','slotId','recordId']);
      return {ok:true,context:lessonContextData_(lessonId_(req.studentId),req.slotId === undefined || req.slotId === '' ? '' : lessonId_(req.slotId),req.recordId === undefined || req.recordId === '' ? '' : lessonId_(req.recordId))};
    }
    if (req.op === 'lessonWriteResume') {
      lessonOnly_(req,['action','op','token','from','view','studentId','requestId']);
      var studentId=lessonId_(req.studentId), w=lessonFind_('lessonWrites','requestId',lessonId_(req.requestId));
      if (!w || JSON.parse(w.payloadJson).studentId !== studentId) lessonFail_('notFound','処理が見つかりません');
      return w.status === 'applied' || w.status === 'failed' ? lessonResultContext_(JSON.parse(w.resultJson),JSON.parse(w.payloadJson)) : lessonResume_(w);
    }
    return lessonWrite_(req);
  } catch (e) { return lessonError_(e); }
}

// Compatibility hook for the existing teacher taskDel operation. A stable
// synthetic request ID makes a repeated legacy delete a withdrawal retry.
function lessonTaskWithdraw_(req,task) {
  if (!req.studentId || String(task.studentId) !== String(req.studentId)) return {error:'宿題の対象が一致しません',errorCode:'notFound'};
  return lessonAdmin_({action:'admin',op:'lessonHomeworkWithdraw',token:req.token,studentId:String(req.studentId),recordId:String(task.sourceRecordId),itemId:String(task.sourceItemId),requestId:'legacy-withdraw-'+String(task.id)});
}

// Safe list badges only: no record content or private data enters cached charts.
function lessonMetadata_(studentId,slotId) {
  var records=lessonRows_('lessonRecords').filter(function (r) { return String(r.studentId) === String(studentId) && String(r.slotId) === String(slotId); });
  var active=records.filter(function (r) { return r.status === 'active'; })[0];
  return {lessonRecordStatus:active ? 'active' : records.length ? 'void' : 'none',lessonDraftStatus:active && lessonFind_('lessonReportDrafts','recordId',active.id) ? 'draft' : 'none'};
}
