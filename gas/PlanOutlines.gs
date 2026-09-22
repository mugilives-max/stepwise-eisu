/** Optional learning allocation. Independent of contractual plan revisions/fees.
 * Only explicit public projections leave the teacher APIs. All mutations use
 * lessonWrites so retries resume the same captured version and snapshot.
 */
function outlineRows_(table) { return ss_().getSheetByName(table) ? lessonRows_(table) : []; }
function outlineFind_(table,key,id) { return ss_().getSheetByName(table) ? lessonFind_(table,key,id) : null; }
function outlineJSON_(value,fallback) { return value ? JSON.parse(String(value)) : fallback; }
function planOutlineItems_(items) {
  if (!Array.isArray(items) || items.length>30) lessonFail_('validation','内訳は30件以内で入力してください');
  var ids=Object.create(null);
  return items.map(function(item) {
    lessonOnly_(item,['id','title','count']);
    var id=lessonId_(item.id), title=lessonText_(item.title,200,true).trim(), count=lessonInteger_(item.count,1);
    if (ids[id] || count>100) lessonFail_('validation','内訳のID・予定数（1〜100）を確認してください');
    ids[id]=true; return {id:id,title:title,count:count};
  });
}
function planOutlineIdentity_(line) { return JSON.stringify([line.subject,line.kind,line.startDate,line.endDate]); }
function planOutlineTotal_(items) { return items.reduce(function(n,item){return n+item.count;},0); }
function planOutlinePending_(studentId,lineId) {
  return outlineRows_('lessonWrites').filter(function(w) {
    if(w.status!=='pending'||w.operation!=='planOutlineSave')return false;
    var p=JSON.parse(w.payloadJson);return p.studentId===studentId&&p.input.lineId===lineId;
  })[0] || null;
}
function planOutlinePublic_(line) {
  var row=outlineFind_('planOutlines','id',line.id);
  if (!row || String(row.studentId)!==line.studentId || !row.publishedJson || ['proposed','approved'].indexOf(line.status)<0) return null;
  var receipt=outlineFind_('lessonWrites','requestId',String(row.lastRequestId));
  if(!receipt||receipt.status!=='applied'||receipt.operation!=='planOutlineSave')return null;
  var published=outlineJSON_(row.publishedJson,null), limit=planLineLimit_(line);
  var adjustment=published.identity!==planOutlineIdentity_(line) || planOutlineTotal_(published.items)>limit;
  return {revision:Number(row.publishedRevision),publishedAt:String(row.publishedAt),adjustmentRequired:adjustment,
    items:adjustment?[]:published.items,unallocated:adjustment?null:limit-planOutlineTotal_(published.items),total:limit};
}
function planOutlineTeacher_(studentId,lineId) {
  var line=planLine_(studentId,lineId);
  if (!line) lessonFail_('notFound','授業計画が見つかりません');
  var row=outlineFind_('planOutlines','id',lineId);
  if (row && String(row.studentId)!==studentId) lessonFail_('conflict','内訳の対象が一致しません');
  var pending=planOutlinePending_(studentId,lineId);
  return {pending:pending?{requestId:String(pending.requestId)}:null,lineId:line.id,planRevision:line.revision,subject:line.subject,kind:line.kind,period:planPeriodLabel_(line),status:line.status,
    limit:planLineLimit_(line),revision:row?Number(row.revision):0,items:row?outlineJSON_(row.itemsJson,[]):[],
    published:planOutlinePublic_(line),hasPublication:!!(row&&row.publishedJson),publishedRevision:row?Number(row.publishedRevision):0};
}
function planOutlineWritePlan_(p,requestId,hash,now,student) {
  if (!lessonActive_(student)) lessonFail_('validation','停止中の生徒の内訳は変更できません');
  var line=planLine_(p.studentId,p.lineId);
  if (!line) lessonFail_('notFound','授業計画が見つかりません');
  lessonRevision_(line,p.expectedPlanRevision);
  var old=outlineFind_('planOutlines','id',p.lineId);
  if (old && String(old.studentId)!==p.studentId) lessonFail_('notFound','内訳の対象が一致しません');
  lessonRevision_(old,p.expectedRevision);
  var pending=lessonRows_('lessonWrites').some(function(w) {
    if(w.status!=='pending'||w.operation!=='planOutlineSave')return false;
    var saved=JSON.parse(w.payloadJson); return saved.studentId===p.studentId&&saved.input.lineId===p.lineId;
  });
  if(pending)lessonFail_('pending','未完了の内訳保存を同じ操作で再試行してください');
  var next={id:p.lineId,studentId:p.studentId,revision:p.expectedRevision+1,itemsJson:JSON.stringify(p.items),
    publishedJson:old?String(old.publishedJson||''):'',publishedRevision:old?Number(old.publishedRevision)||0:0,publishedAt:old?String(old.publishedAt||''):'',updatedAt:now,lastRequestId:requestId};
  if(p.publication==='publish') {
    if(!p.items.length || line.status==='declined')lessonFail_('validation','公開する内訳と案内の状態を確認してください');
    if(planOutlineTotal_(p.items)>planLineLimit_(line))lessonFail_('validation','内訳が案内・承認回数を超えています。配分を見直してから公開してください');
    next.publishedJson=JSON.stringify({identity:planOutlineIdentity_(line),items:p.items}); next.publishedRevision=next.revision; next.publishedAt=now;
  } else if(p.publication==='hide') { next.publishedJson=''; next.publishedRevision=0; next.publishedAt=''; }
  return {operation:p.operation,studentId:p.studentId,slotId:'',recordId:'',requestId:requestId,hash:hash,now:now,input:p,outline:next};
}
function lessonOutlineInput_(value) {
  if(value===null)return null;
  lessonOnly_(value,['lineId','itemId','expectedRevision','expectedPlanRevision','refresh']);
  if(value.refresh!==undefined&&typeof value.refresh!=='boolean')lessonFail_('validation','内訳の更新方法を確認してください');
  return {lineId:lessonId_(value.lineId),itemId:lessonId_(value.itemId),expectedRevision:lessonInteger_(value.expectedRevision,0),
    expectedPlanRevision:lessonInteger_(value.expectedPlanRevision,0),refresh:value.refresh===true};
}
function lessonOutlineMatches_(line,slot) {
  return line.studentId===String(slot.studentId)&&line.subject===String(slot.subject||'')&&line.kind===kindNorm_(slot.kind)&&planLineCovers_(line,String(slot.date))&&line.status!=='declined';
}
function lessonOutlineOrdinal_(studentId,line,slot,itemId) {
  if(String(slot.date)>todayStr_())return {ordinal:null,reason:'授業日以降に確定'};
  if(!(slot.done===true||String(slot.done)==='true'))return {ordinal:null,reason:'実施登録後に確定'};
  var active={}, bindings={}, receipts={};
  lessonRows_('lessonWrites').forEach(function(w){if(w.operation==='lessonRecordSave'&&w.status==='applied')receipts[String(w.requestId)]=true;});
  lessonRows_('lessonRecords').forEach(function(r){if(String(r.studentId)===studentId&&r.status==='active'&&receipts[String(r.lastRequestId)])active[String(r.id)]=r;});
  outlineRows_('lessonOutlineLinks').forEach(function(link) {
    var record=active[String(link.recordId)];
    if(record&&Number(link.sourceRevision)===Number(record.revision)&&!lessonSlotChanged_(record))bindings[String(link.slotId)]=link;
  });
  var key=String(slot.date)+'T'+String(slot.start)+'|'+String(slot.id), count=1, missing=0;
  readRows_('slots').forEach(function(s) {
    if(s.status!=='booked'||String(s.date)>todayStr_()||!(s.done===true||String(s.done)==='true')||!lessonOutlineMatches_(line,s))return;
    if(String(s.date)+'T'+String(s.start)+'|'+String(s.id)>=key)return;
    var link=bindings[String(s.id)];
    if(!link||!link.lineId){missing++;return;}
    if(String(link.lineId)===line.id&&String(link.itemId)===itemId)count++;
  });
  return missing?{ordinal:null,reason:'過去の実施授業'+missing+'件の対応を確認'}:{ordinal:count,reason:''};
}
function lessonOutlinePosition_(studentId,line,slot,item,published) {
  var position=lessonOutlineOrdinal_(studentId,line,slot,item.id);
  return {title:item.title,plannedCount:item.count,ordinal:position.ordinal,reason:position.reason,
    course:kindLabel_(line.subject,line.kind),total:planLineLimit_(line),period:planPeriodLabel_(line),public:published};
}
function lessonOutlineChoices_(studentId,slot) {
  if(!slot||slot.status!=='booked')return [];
  return planLinesFor_(studentId).filter(function(line){return lessonOutlineMatches_(line,slot);}).map(function(line) {
    var teacher=planOutlineTeacher_(studentId,line.id), published=teacher.published;
    var items=teacher.pending?[]:teacher.items.slice();
    if(published&&!published.adjustmentRequired)published.items.forEach(function(item){if(!items.some(function(x){return x.id===item.id;}))items.push(item);});
    return {lineId:line.id,label:kindLabel_(line.subject,line.kind)+' '+planPeriodLabel_(line),comment:line.comment,total:planLineLimit_(line),
      revision:teacher.revision,planRevision:line.revision,adjustmentRequired:!!(published&&published.adjustmentRequired),
      items:items.map(function(item) {
        var publicItem=published&&!published.adjustmentRequired&&published.items.filter(function(x){return x.id===item.id;})[0];
        return {id:item.id,title:item.title,position:lessonOutlinePosition_(studentId,line,slot,item,false),
          publicPosition:publicItem?lessonOutlinePosition_(studentId,line,slot,publicItem,true):null};
      })};
  }).filter(function(line){return line.items.length;});
}
function lessonOutlineBuild_(record,slot,input) {
  var old=record&&outlineFind_('lessonOutlineLinks','recordId',String(record.id));
  if(input===undefined || (old&&input&&!input.refresh&&input.lineId===String(old.lineId)&&input.itemId===String(old.itemId)))return old?lessonCopy_(old):null;
  var link={recordId:'',studentId:String(slot.studentId),slotId:String(slot.id),lineId:'',itemId:'',sourceRevision:0,teacherJson:'',publicJson:''};
  if(input===null)return link;
  var line=planLine_(String(slot.studentId),input.lineId), outline=line&&planOutlineTeacher_(String(slot.studentId),input.lineId);
  if(!line||!lessonOutlineMatches_(line,slot))lessonFail_('validation','この授業に対応する計画を選んでください');
  lessonRevision_({revision:outline.revision},input.expectedRevision); lessonRevision_(line,input.expectedPlanRevision);
  var choice=lessonOutlineChoices_(String(slot.studentId),slot).filter(function(x){return x.lineId===line.id;})[0];
  var item=choice&&choice.items.filter(function(x){return x.id===input.itemId;})[0];
  if(!item)lessonFail_('validation','内訳が変更されています。最新を確認してください');
  link.lineId=line.id;link.itemId=item.id;link.teacherJson=JSON.stringify(item.position);link.publicJson=item.publicPosition?JSON.stringify(item.publicPosition):'';
  return link;
}
function lessonOutlineRecordView_(record) {
  var link=outlineFind_('lessonOutlineLinks','recordId',String(record.id));
  if(!link||String(link.studentId)!==String(record.studentId)||Number(link.sourceRevision)!==Number(record.revision)||!link.lineId)return null;
  return {lineId:String(link.lineId),itemId:String(link.itemId),position:outlineJSON_(link.teacherJson,null),publicPosition:outlineJSON_(link.publicJson,null)};
}
function lessonOutlinePublicSnapshot_(snapshot) {
  var saved=outlineFind_('lessonOutlineSnapshots','id',String(snapshot.id));
  if(!saved||String(saved.studentId)!==String(snapshot.studentId)||String(saved.recordId)!==String(snapshot.recordId)||Number(saved.revision)!==Number(snapshot.revision))return null;
  return outlineJSON_(saved.bodyJson,null);
}
