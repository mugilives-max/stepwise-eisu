// 日程の決め方（段階1、2026-10-01）。設計は docs/SCHEDULING_FLOW_DESIGN.md
// 先生が送った「仮予定」（status=offered）は締め切り（confirmBy）までに連絡がなければ、毎日0時10分の処理で「決定」（booked）になる。
// 生徒・保護者は授業ごとの「変更・お休みの連絡」で、日時の変更のお願い・お休み・開始を遅らせたい・キャンセルを伝える。
//
// slots の15〜19列目（14列目は instructorId）:
//   confirmBy     仮予定の締め切り（YYYY-MM-DD、その日の終わりまで）。'hold' = 予定表にまとめてまだ送っていない（生徒には見せない）。
//                 空 = 締め切りなし（この仕組みより前の案内・授業の日が近い案内）。自動では決定しない
//   changeReqAt   「日時の変更のお願い」「開始を遅らせたい」を受け付けた時刻（ISO）。空ならお願いなし
//   changeReqBy   student / parent
//   changeReqKind move（日時の変更のお願い） / late（開始を遅らせたい）
//   changeReqNote 一言（500文字まで）
// お休み・キャンセルは今までの取消の申請（cancelReq）と取消の記録をそのまま使う。画面と件名の呼び方だけ料金の有無で分ける。
var SCHEDULE_FLOW_COLS_ = ['confirmBy', 'changeReqAt', 'changeReqBy', 'changeReqKind', 'changeReqNote'];
var SCHEDULE_FLOW_COL0_ = 15;
var KANRI_URL_ = 'https://www.stepwise-education.jp/kanri/';

function ensureScheduleFlowSchema_() {
  var sh = ss_().getSheetByName('slots');
  if (!sh) return;
  var head = sh.getRange(1, 14, 1, 6).getValues()[0];
  if (head.slice(1).join('|') === SCHEDULE_FLOW_COLS_.join('|')) return;
  if (String(head[0]) !== 'instructorId') throw new Error('slotsの列構成を確認してください（14列目が instructorId ではありません）');
  for (var i = 0; i < SCHEDULE_FLOW_COLS_.length; i++) {
    if (head[i + 1] !== '' && head[i + 1] != null && String(head[i + 1]) !== SCHEDULE_FLOW_COLS_[i]) throw new Error('slotsの15列目以降を確認してください');
  }
  sh.getRange(1, SCHEDULE_FLOW_COL0_, 1, SCHEDULE_FLOW_COLS_.length).setValues([SCHEDULE_FLOW_COLS_]);
  memoClear_();
}

function slotFlowSet_(rowIndex, patch) {
  var sh = sheet_('slots'), range = sh.getRange(rowIndex, SCHEDULE_FLOW_COL0_, 1, SCHEDULE_FLOW_COLS_.length), cur = range.getValues()[0];
  SCHEDULE_FLOW_COLS_.forEach(function (k, i) { if (k in patch) cur[i] = patch[k] == null ? '' : String(patch[k]); else cur[i] = cur[i] == null ? '' : String(cur[i]); });
  range.setNumberFormat('@').setValues([cur]);
  memoClear_();
}
var SCHEDULE_CHANGE_CLEAR_ = { changeReqAt: '', changeReqBy: '', changeReqKind: '', changeReqNote: '' };
// 先生が日時を直した・決定した・取り下げたときに、お願いを済みにする
function slotChangeClear_(slotId) {
  var r = findSlotRow_(String(slotId || ''));
  if (r && String(r.slot.changeReqAt || '')) slotFlowSet_(r.rowIndex, SCHEDULE_CHANGE_CLEAR_);
}
function slotConfirmBy_(s) { var v = normDate_(s && s.confirmBy); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
function slotHeld_(s) { return String(s && s.confirmBy || '') === 'hold'; }
// 画面に渡す形。生徒・保護者・先生で共通
function slotFlow_(s) {
  return {
    confirmBy: slotConfirmBy_(s), held: slotHeld_(s),
    change: s && s.changeReqAt ? { at: String(s.changeReqAt), by: String(s.changeReqBy || ''), kind: String(s.changeReqKind || ''), note: String(s.changeReqNote || '') } : null
  };
}

// 締め切りの決め方: 「送った日の3日後」。翌月以降の授業だけなら「今月25日」と遅い方。
// 授業ごとに、授業の2日前を超えない（前日0時10分に決定し、前日23時までは無料で変えられるように）。
// それより近い授業は締め切りなし（空）。先生が直接決定する。
function scheduleConfirmBy_(slots, today, requested) {
  var base;
  if (requested) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested < today) return { error: '締め切りは今日以降の日付にしてください' };
    base = requested;
  } else {
    base = addDays_(today, 3);
    var nextStart = nextYm_(today.slice(0, 7)) + '-01';
    if (slots.every(function (s) { return String(s.date) >= nextStart; })) { var d25 = today.slice(0, 7) + '-25'; if (d25 > base) base = d25; }
  }
  var byId = {};
  slots.forEach(function (s) { var limit = addDays_(String(s.date), -2), v = base < limit ? base : limit; byId[String(s.id)] = v >= today ? v : ''; });
  return { byId: byId, base: base };
}

function scheduleMonthsOf_(slots) {
  var ms = [];
  slots.forEach(function (s) { var m = String(s.date).slice(0, 7); if (ms.indexOf(m) < 0) ms.push(m); });
  return ms.sort();
}

// 先生: 予定表にまとめておいた仮予定（未送信）を送る。通知は1回
function scheduleSend_(req) {
  var student = findStudent_(String(req.studentId || ''));
  if (!student) return schedulingError_('生徒を選んでください');
  var rid = String(req.requestId || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(rid)) return schedulingError_('処理番号を確認してください');
  var today = todayStr_(), held = [];
  readRows_('slots').forEach(function (s, i) {
    if (String(s.studentId) === String(student.id) && s.status === 'offered' && slotHeld_(s) && String(s.date) >= today) held.push({ slot: s, rowIndex: i + 2 });
  });
  if (!held.length) return { ok: true, sent: 0, admin: adminState_() };
  var d = scheduleConfirmBy_(held.map(function (h) { return h.slot; }), today, req.confirmBy ? String(req.confirmBy) : '');
  if (d.error) return schedulingError_(d.error);
  held.forEach(function (h) { h.slot.confirmBy = d.byId[String(h.slot.id)]; slotFlowSet_(h.rowIndex, { confirmBy: h.slot.confirmBy }); });
  var slots = held.map(function (h) { return h.slot; }).sort(slotSort_), key = 'schedule:' + student.id + ':' + rid, months = scheduleMonthsOf_(slots);
  addLog_('先生が' + student.name + 'さんに予定表（' + slots.length + '件）を送りました');
  var warnings = [];
  try {
    var notice = typeof studentEmailNotify_ === 'function' ? studentEmailNotify_(student, key, 'schedule', slots) : {};
    if (notice.warning) warnings.push(notice.warning);
  } catch (e) { warnings.push('予定表は送りました。生徒へのメール通知を確認してください'); }
  var family = billingNotifyResult_('scheduleSent', student.id, key, { ym: months[0] });
  if (family.notificationWarning) warnings.push(family.notificationWarning);
  return { ok: true, sent: slots.length, notificationWarning: warnings.join(' '), admin: adminState_() };
}

// 先生: 日時の変更のお願い・開始を遅らせたい連絡を、日時を直さずに済みにする（LINE で話がついたときなど）
function scheduleChangeClear_(req) {
  var r = findSlotRow_(String(req.slotId || ''));
  if (!r || String(r.slot.studentId) !== String(req.studentId || '')) return schedulingError_('授業が見つかりません', 'notFound');
  if (String(r.slot.changeReqAt || '')) { slotFlowSet_(r.rowIndex, SCHEDULE_CHANGE_CLEAR_); addLog_(studentName_(r.slot.studentId) + 'さんの ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' のお願いを済みにしました'); }
  return { ok: true, admin: adminState_() };
}

// 生徒・保護者: 「日時の変更をお願いする」（仮予定・決定後〜前日23時）、「開始を遅らせたい」（前日23時〜開始前）。取り下げ（withdraw）もここ
function lessonChange_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = findSlotRow_(String(req.slotId || ''));
  if (!r || String(r.slot.studentId) !== String(student.id) || ['offered', 'booked'].indexOf(r.slot.status) < 0 || slotHeld_(r.slot) || String(r.slot.done) === 'true')
    return { error: 'この授業は見つかりません。画面を更新してください', refresh: true };
  var pending = typeof schedulingPendingSlotMutation_ === 'function' ? schedulingPendingSlotMutation_(r.slot.id) : null;
  if (pending) return pending;
  var who = req.familyProxy ? 'parent' : 'student', name = student.name, sender = req.familyProxy ? name + 'さんの保護者' : name + 'さん';
  var when = fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min) + (r.slot.subject ? '（' + r.slot.subject + '）' : '');
  if (req.withdraw) {
    if (String(r.slot.changeReqAt || '')) {
      slotFlowSet_(r.rowIndex, SCHEDULE_CHANGE_CLEAR_);
      addLog_(name + 'さんが ' + when + ' のお願いを取り下げ');
      if (!isTestStudent_(student)) notify_('【お願いの取り下げ】' + name + 'さん', sender + 'が ' + when + ' のお願いを取り下げました。予定どおり行います。');
    }
    return { ok: true, state: studentState_(req.k) };
  }
  var kind = String(req.kind || ''), note = String(req.note == null ? '' : req.note).trim();
  if (['move', 'late'].indexOf(kind) < 0) return { error: '連絡の種類を選んでください' };
  if (!note || note.length > 500) return { error: (kind === 'move' ? '希望の日時など' : '何分ほど遅らせたいか') + 'を500文字以内で書いてください' };
  var now = req._receivedAt || Date.now(), deadline = cancelDeadline_(r.slot), start = Date.parse(r.slot.date + 'T' + r.slot.start + ':00+09:00');
  if (kind === 'move' && r.slot.status === 'booked' && now > deadline) return { error: '前日23時を過ぎたため、日時の変更はお願いできません。画面を更新してください', errorCode: 'late', refresh: true };
  if (kind === 'late' && (r.slot.status !== 'booked' || now <= deadline || now >= start)) return { error: '開始を遅らせたい連絡は、前日23時から授業の開始までの間だけ送れます。画面を更新してください', refresh: true };
  if (String(r.slot.changeReqAt || '') && String(r.slot.changeReqKind) === kind && String(r.slot.changeReqNote) === note) return { ok: true, replayed: true, state: studentState_(req.k) };
  slotFlowSet_(r.rowIndex, { changeReqAt: new Date(now).toISOString(), changeReqBy: who, changeReqKind: kind, changeReqNote: note });
  addLog_(name + 'さんが ' + when + ' について' + (kind === 'move' ? '日時の変更をお願い' : '開始を遅らせたいと連絡'));
  if (!isTestStudent_(student)) {
    if (kind === 'move') notify_('【日時の変更のお願い】' + name + 'さん', sender + 'から日時の変更のお願いが届きました。\n' + when + (r.slot.status === 'offered' ? '（仮予定）' : '') + '\n希望: ' + note + '\n\n日時を直すと、お願いは済みになります。管理画面で確認してください。\n' + KANRI_URL_);
    else notify_('【開始を遅らせたい】' + name + 'さん', sender + 'から、開始を遅らせたいという連絡が届きました。\n' + when + '\n内容: ' + note + '\n\n応じる場合は管理画面で開始時刻を直してください。\n' + KANRI_URL_);
  }
  return { ok: true, state: studentState_(req.k) };
}

// 毎日0時10分（Worker の定期実行）: 締め切りを過ぎ、連絡のない仮予定を決定する。
// 決定の処理は先生の直接決定と同じ（カレンダー・Meet を含む）。1件ずつ行い、失敗したものは残して翌日やり直す。
function scheduleAutoConfirm_() {
  ensureSchema_();
  var today = todayStr_(), by = {}, result = { confirmed: 0, students: 0, failed: 0 };
  readRows_('slots').forEach(function (s) {
    var cb = slotConfirmBy_(s);
    if (s.status === 'offered' && cb && cb < today && !String(s.changeReqAt || '') && String(s.date) >= today) (by[String(s.studentId)] = by[String(s.studentId)] || []).push(s);
  });
  Object.keys(by).sort().forEach(function (id) {
    var student = findStudent_(id), done = [];
    if (!student || !student.code) { result.failed += by[id].length; return; }
    by[id].sort(slotSort_).forEach(function (s) {
      var res;
      try {
        res = schedulingAcceptMany_({ k: student.code, slotIds: [String(s.id)], requestId: 'auto-' + schedulingHash_(String(s.id) + '|' + slotConfirmBy_(s)).slice(0, 40), expectedSnapshots: [schedulingSnapshot_(s)] }, true);
      } catch (e) { res = { error: String(e && e.message || e) }; }
      if (res && res.ok) done.push(s);
      else { result.failed++; addLog_(student.name + 'さんの ' + fmtDateJa_(s.date) + ' ' + s.start + ' を自動で決定できませんでした（' + String(res && res.error || '不明') + '）。翌日もう一度試します'); }
    });
    if (!done.length) return;
    result.confirmed += done.length; result.students++;
    addLog_(student.name + 'さんの仮予定 ' + done.length + '件を、締め切りを過ぎたので決定しました');
    var key = 'confirmed:' + id + ':' + today;
    try { if (typeof studentEmailNotify_ === 'function') studentEmailNotify_(student, key, 'confirmed', done); } catch (e) {}
    billingNotifyResult_('scheduleConfirmed', id, key, { ym: scheduleMonthsOf_(done)[0] });
  });
  return result;
}
