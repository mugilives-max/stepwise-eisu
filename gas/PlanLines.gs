/* 授業計画の行(案内)。生徒 × 科目 × 種類 × 期間(開始日〜終了日) → 回数・1回の授業時間・1回の授業料・コメント。
   行ごとに 下書き(draft) → 案内送信(proposed) → 承認(approved)/見送り(declined) と進み、行ごとに版(revision)を持つ。
   月は期間の特別な場合(1日〜月末)。同じ科目・種類で期間が重なる行は作れない(実施した授業がどの行の分か決められなくなる)。
   請求は今までどおり月ごと。実施した授業を日付・科目・種類の合う承認済みの行に当てはめ、行の単価で時間按分する。 */
var PLAN_LINE_COLS_ = ['id','studentId','subject','kind','count','startDate','endDate','lessonMin','rate30','comment','status','revision','proposedAt','approvedAt','approvedVia','consentDate','memo','approvedCount','createdAt','updatedAt'];
var PLAN_LINE_MAX_DAYS_ = 366;
var PLAN_LINE_STATUSES_ = ['draft','proposed','approved','declined'];

function ensurePlanLinesSheet_() {
  var ss = ss_(), existed = !!ss.getSheetByName('planLines');
  billingEnsureColumns_(ss, 'planLines', PLAN_LINE_COLS_);
  if (!existed) memoClear_();
  planLinesMigrate_();
}

function planDate_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || ''); }
function planMonthEnd_(ym) { var p = ym.split('-'), d = new Date(+p[0], +p[1], 0); return ym + '-' + ('0' + d.getDate()).slice(-2); }
function planDaysBetween_(a, b) { return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000); }
function planCommentClean_(v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim(); }

function planLineRows_() {
  if (!ss_().getSheetByName('planLines')) return [];
  return readRows_('planLines').map(function (r, i) { return planLineNorm_(r, i + 2); }).filter(function (l) { return l.id && l.studentId; });
}
function planLineNorm_(r, row) {
  return { _row: row, id: String(r.id || ''), studentId: String(r.studentId || ''), subject: String(r.subject || ''), kind: kindNorm_(r.kind), count: Number(r.count) || 0,
    startDate: planDate_(r.startDate), endDate: planDate_(r.endDate), lessonMin: Number(r.lessonMin) || 0, rate30: Number(r.rate30) || 0, comment: String(r.comment || ''),
    status: String(r.status || '') || 'draft', revision: Number(r.revision) || 0, proposedAt: String(r.proposedAt || ''), approvedAt: String(r.approvedAt || ''), approvedVia: String(r.approvedVia || ''),
    consentDate: planDate_(r.consentDate), memo: String(r.memo || ''), approvedCount: r.approvedCount === '' || r.approvedCount == null ? null : Number(r.approvedCount), createdAt: String(r.createdAt || ''), updatedAt: String(r.updatedAt || '') };
}
function planLineWrite_(l) {
  l.updatedAt = billingStamp_(); if (!l.createdAt) l.createdAt = l.updatedAt;
  var sh = sheet_('planLines'), row = l._row || sh.getLastRow() + 1;
  var vals = PLAN_LINE_COLS_.map(function (k) { var v = l[k]; if (v == null) v = ''; return typeof v === 'string' ? billingText_(v) : v; });
  sh.getRange(row, 1, 1, vals.length).setNumberFormat('@').setValues([vals]); l._row = row;
}
function planLine_(studentId, lineId) {
  var m = planLineRows_().filter(function (l) { return l.studentId === String(studentId) && l.id === String(lineId); });
  if (m.length > 1) throw new Error('授業計画の行が重複しています。台帳を確認してください');
  return m[0] || null;
}
// 同じ行IDが2つあれば、その生徒の計画・確定・請求は止める(どちらが正か決められない)
function planLinesFor_(studentId, rows) {
  var mine = (rows || planLineRows_()).filter(function (l) { return l.studentId === String(studentId); }), seen = {};
  for (var i = 0; i < mine.length; i++) { if (seen[mine[i].id]) throw new Error('授業計画の行が重複しています。台帳を確認してください'); seen[mine[i].id] = true; }
  return mine;
}
function planLineCovers_(l, date) { return date >= l.startDate && date <= l.endDate; }
function planLineOverlapsMonth_(l, ym) { return l.startDate.slice(0, 7) <= ym && l.endDate.slice(0, 7) >= ym; }
function planLineMonths_(l) { var out = [], ym = l.startDate.slice(0, 7), last = l.endDate.slice(0, 7); while (ym && ym <= last && out.length < 14) { out.push(ym); ym = nextYm_(ym); } return out; }
function planLineLimit_(l) { return l.status === 'approved' && l.approvedCount != null ? l.approvedCount : l.count; }
function planLineFee_(l) { return Math.round(l.rate30 * l.lessonMin / 30); }
function planLineIsMonth_(l) { return l.startDate.slice(8) === '01' && l.endDate === planMonthEnd_(l.startDate.slice(0, 7)); }
function planPeriodLabel_(l) {
  if (planLineIsMonth_(l)) return (+l.startDate.slice(0, 4)) + '年' + (+l.startDate.slice(5, 7)) + '月';
  function md(d) { return (+d.slice(5, 7)) + '/' + (+d.slice(8)); }
  return (+l.startDate.slice(0, 4)) + '/' + md(l.startDate) + '〜' + (l.endDate.slice(0, 4) !== l.startDate.slice(0, 4) ? (+l.endDate.slice(0, 4)) + '/' : '') + md(l.endDate);
}
// 授業(確定・実施)がどの行の分か: 科目・種類が同じで、日付が期間内の承認済みの行
function planLineMatch_(lines, slot, statuses) {
  var subject = String(slot.subject || ''), kind = kindNorm_(slot.kind), date = String(slot.date || ''), ok = statuses || ['approved'];
  return lines.filter(function (l) { return ok.indexOf(l.status) >= 0 && l.subject === subject && l.kind === kind && planLineCovers_(l, date); })[0] || null;
}
function planLineBooked_(l, slots, exceptId) {
  return (slots || readRows_('slots')).filter(function (s) { return String(s.studentId) === l.studentId && s.status === 'booked' && String(s.subject || '') === l.subject && kindNorm_(s.kind) === l.kind && planLineCovers_(l, String(s.date || '')) && String(s.id) !== String(exceptId || ''); });
}
// 期間に請求済みの月があれば、その行は変更できない(請求の根拠を変えない)
function planLineLocked_(l) {
  var months = planLineMonths_(l);
  for (var i = 0; i < months.length; i++) { var c = billingMonthUnlocked_(l.studentId, months[i]); if (c) return c; }
  return null;
}
function planLineView_(l) {
  return { id: l.id, subject: l.subject, kind: l.kind, count: l.count, approvedCount: l.approvedCount, startDate: l.startDate, endDate: l.endDate, period: planPeriodLabel_(l), month: planLineIsMonth_(l) ? l.startDate.slice(0, 7) : '',
    lessonMin: l.lessonMin, rate30: l.rate30, lessonFee: planLineFee_(l), comment: l.comment, status: l.status, revision: l.revision, proposedAt: l.proposedAt, approvedAt: l.approvedAt, approvedVia: l.approvedVia, consentDate: l.consentDate, memo: l.memo, updatedAt: l.updatedAt };
}
function planLineSort_(a, b) { return a.startDate === b.startDate ? (a.subject + a.kind).localeCompare(b.subject + b.kind) : (a.startDate < b.startDate ? 1 : -1); }
// 監査(approvalEvents)は月間承認と同じ列に書く: ym には期間、planJson には行の内容
function planLineAuditable_(l) {
  var row = { subject: l.subject, count: l.count }; if (l.kind) row.kind = l.kind;
  l.ym = l.startDate + '~' + l.endDate; l.planJson = JSON.stringify([row]); l.monthly = 0;
  l.approvedPlanJson = l.status === 'approved' || l.status === 'declined' ? JSON.stringify([{ subject: l.subject, kind: l.kind || undefined, count: l.approvedCount == null ? 0 : l.approvedCount }]) : '';
  return l;
}

// 先生: 行の保存(下書き)または案内送信(propose)。保存するたびに版が進み、承認済み・送信済みの行は下書き/再送信に戻る
function planLineSave_(req) {
  var id = String(req.studentId || ''), st = findStudent_(id);
  if (!st) return billingError_('在籍生徒を選んでください', 'notFound');
  var subject = String(req.subject || '').trim(), kind = kindNorm_(req.kind), count = Number(req.count);
  if (!subject || subject.length > 20 || /^[=+@-]/.test(subject)) return billingError_('科目を20文字以内で選んでください');
  if (!kindValid_(kind)) return kindError_();
  if (!Number.isInteger(count) || count < 1 || count > 99) return billingError_('回数は1〜99の整数で入力してください');
  var start = String(req.startDate || ''), end = String(req.endDate || '');
  if (!billingDateValid_(start) || !billingDateValid_(end)) return billingError_('期間の開始日と終了日を入力してください');
  if (end < start) return billingError_('終了日は開始日以降にしてください');
  if (planDaysBetween_(start, end) >= PLAN_LINE_MAX_DAYS_) return billingError_('期間は1年以内にしてください');
  var lessonMin = Number(req.lessonMin), fee = Number(req.lessonFee);
  if (!Number.isInteger(lessonMin) || lessonMin < 30 || lessonMin > 240 || lessonMin % 30) return billingError_('1回の授業時間は30〜240分の30分刻みで入力してください');
  if (!Number.isInteger(fee) || fee < 0 || fee > 10000000) return billingError_('1回の授業料を整数で入力してください');
  var rate30 = Math.round(fee * 30 / lessonMin), comment = planCommentClean_(req.comment);
  if (comment.length > 500) return billingError_('コメントは500文字以内で入力してください');
  var propose = req.propose === true || String(req.propose) === 'true';
  var lines = planLinesFor_(id), lineId = String(req.lineId || ''), l = null, check;
  if (lineId) {
    l = lines.filter(function (x) { return x.id === lineId; })[0];
    if (!l) return billingError_('案内が見つかりません。最新の画面を読み直してください', 'notFound');
    check = billingRevisionCheck_(req, l, false) || planLineLocked_(l); if (check) return check;
    // 確定済みの授業を外す変更はできない(回数を減らす・期間から外す)
    var booked = planLineBooked_(l);
    if (booked.some(function (s) { return String(s.subject || '') !== subject || kindNorm_(s.kind) !== kind || s.date < start || s.date > end; })) return billingError_('確定済みの授業が期間・科目・種類から外れます。先に授業を取り消すか、変更内容を見直してください', 'bookedOutside');
    if (booked.length > count) return billingError_('確定済みの授業数(' + booked.length + '回)より少ない回数にはできません', 'bookedOver');
  }
  check = planLineLocked_({ studentId: id, startDate: start, endDate: end }); if (check) return check;
  var clash = lines.filter(function (x) { return x.id !== lineId && x.status !== 'declined' && x.subject === subject && x.kind === kind && x.startDate <= end && x.endDate >= start; })[0];
  if (clash) return billingError_('同じ科目・種類で期間が重なる案内があります（' + planPeriodLabel_(clash) + '）。期間を分けるか、その案内を変更してください', 'overlap');
  var previous = l ? l.status : '';
  if (!l) l = { id: billingId_(), studentId: id, revision: 0, createdAt: '' };
  l.subject = subject; l.kind = kind; l.count = count; l.startDate = start; l.endDate = end; l.lessonMin = lessonMin; l.rate30 = rate30; l.comment = comment;
  l.revision = Number(l.revision) + 1; l.approvedAt = ''; l.approvedVia = ''; l.consentDate = ''; l.memo = ''; l.approvedCount = null;
  l.status = propose ? 'proposed' : 'draft'; l.proposedAt = propose ? billingStamp_() : '';
  planLineWrite_(l);
  billingAudit_(planLineAuditable_(l), propose ? 'proposed' : 'planChanged', l.id + ':' + l.revision + ':' + (propose ? 'proposed' : 'changed'), previous ? { previousStatus: previous } : undefined);
  addLog_('先生が' + studentName_(id) + 'さんの授業計画 ' + kindLabel_(subject, kind) + ' ' + planPeriodLabel_(l) + ' ' + count + '回を' + (propose ? '案内' : '下書き保存'));
  var notice = propose ? billingNotifyResult_('planProposed', id, l.id + ':' + l.revision + ':proposed', { ym: planPeriodLabel_(l), lineId: l.id, revision: l.revision, subject: kindLabel_(subject, kind) }) : {};
  return Object.assign({ ok: true, line: planLineView_(l), invalidated: previous === 'approved' }, notice);
}

// 先生: 行の削除。確定済みの授業がある行や請求済みの月にかかる行は消せない
function planLineDelete_(req) {
  var id = String(req.studentId || ''); if (!systemStudent_(id)) return billingError_('生徒が見つかりません', 'notFound');
  var l = planLine_(id, String(req.lineId || '')); if (!l) return { ok: true, replayed: true };
  var check = billingRevisionCheck_(req, l, false) || planLineLocked_(l); if (check) return check;
  if (planLineBooked_(l).length) return billingError_('確定済みの授業がある案内は削除できません。先に授業を取り消すか、回数・期間を変更してください', 'bookedExists');
  billingAudit_(planLineAuditable_(l), 'deleted', l.id + ':' + l.revision + ':deleted');
  sheet_('planLines').deleteRow(l._row);
  addLog_('先生が' + studentName_(id) + 'さんの授業計画 ' + kindLabel_(l.subject, l.kind) + ' ' + planPeriodLabel_(l) + ' を削除');
  return { ok: true };
}

// 承認(先生の記録 / 保護者ページ)。保護者は案内以内の回数に減らせる(0回=見送り)
function planLineApprove_(req, id, parent) {
  var l = planLine_(id, String(req.lineId || '')); if (!l) return billingError_('案内が見つかりません。最新の画面を読み直してください', 'notFound');
  var check = billingRevisionCheck_(req, l, true); if (check) return check;
  var approve = parent ? (req.approve === true || String(req.approve) === 'true') : true, approvedCount = l.count;
  if (parent && req.approvedCount !== undefined && req.approvedCount !== null && req.approvedCount !== '') {
    approvedCount = Number(req.approvedCount);
    if (!Number.isInteger(approvedCount) || approvedCount < 0 || approvedCount > l.count) return billingError_('案内された回数以内で選択してください');
    approve = approvedCount > 0;
  }
  if (!approve) approvedCount = 0;
  if ((approve && l.status === 'approved') || (!approve && l.status === 'declined')) {
    if (Number(l.approvedCount) !== approvedCount) return billingError_('回答済みの内容と異なります。最新の案内を確認してください', 'conflict');
    return { ok: true, replayed: true, line: planLineView_(l) };
  }
  check = planLineLocked_(l); if (check) return check;
  if (l.status !== 'proposed') return billingError_('現在の案内を読み直してください', 'conflict');
  var today = todayStr_(), date = parent ? today : String(req.consentDate || '');
  if (!billingDateValid_(date) || date > today) return billingError_('実際に承諾を得た日を、今日以前の日付で入力してください');
  var via = parent ? '保護者ページ' : String(req.via || '').trim(), memo = String(req.memo || '').trim();
  if (!via || via.length > 40 || memo.length > 500) return billingError_('承諾方法と500文字以内のメモを入力してください');
  var booked = planLineBooked_(l);
  var retrospective = l.endDate < today || booked.some(function (s) { return s.date < date; });
  if (!parent && retrospective && !memo) return billingError_('授業後・過去の期間の承諾は、経緯をメモに残してください');
  if (parent && booked.length > approvedCount) return billingError_('確定済みの授業数より少なくする場合は、先に先生へ授業の取消・見直しをご相談ください');
  l.status = approve ? 'approved' : 'declined'; l.approvedCount = approvedCount; l.approvedAt = approve ? billingStamp_() : ''; l.approvedVia = approve ? via : ''; l.consentDate = date; l.memo = memo;
  // 承諾の記録が保存できなければ承認を有効にしない
  billingAudit_(planLineAuditable_(l), l.status, l.id + ':' + l.revision + ':' + l.status);
  planLineWrite_(l);
  addLog_((parent ? '保護者' : '先生') + 'が' + studentName_(id) + 'さんの授業計画 ' + kindLabel_(l.subject, l.kind) + ' ' + planPeriodLabel_(l) + ' を' + (approve ? '承認(' + approvedCount + '回)' : '見送り'));
  return { ok: true, line: planLineView_(l) };
}
function planLineApproveTeacher_(req) {
  var id = String(req.studentId || ''); if (!systemStudent_(id)) return billingError_('生徒が見つかりません', 'notFound');
  return planLineApprove_(req, id, false);
}
function planLineParentDecide_(student, req) {
  var res = planLineApprove_(req, String(student.id), true); if (res.error) return res;
  if (!res.replayed && !isTestStudent_(student)) notify_('【授業計画の回答】' + student.name + 'さん ' + (res.line ? res.line.period + ' ' + kindLabel_(res.line.subject, res.line.kind) : ''), '保護者ページから授業計画への回答がありました。管理画面でご確認ください。');
  return Object.assign({ ok: true, data: parentDataForStudent_(student).data }, res.replayed ? { replayed: true } : {});
}

// 毎月の既定(plans の default 行)から、指定した月の下書きを作る。時間・料金は種類の標準、なければ生徒の基本単価×90分
function planLinesFromDefault_(req) {
  var id = String(req.studentId || ''), ym = String(req.ym || ''), st = findStudent_(id);
  if (!st) return billingError_('在籍生徒を選んでください', 'notFound');
  if (!billingMonthValid_(ym)) return billingError_('月の形式は YYYY-MM です');
  var defaults = planRows_().filter(function (x) { return x.studentId === id && x.ym === 'default' && x.count > 0; });
  if (!defaults.length) return billingError_('毎月の既定回数が登録されていません');
  var created = 0, skipped = 0, kinds = lessonKinds_();
  for (var i = 0; i < defaults.length; i++) {
    var d = defaults[i], k = kinds.filter(function (x) { return x.name === (d.kind || LESSON_KIND_DEFAULT_); })[0];
    var lessonMin = k && k.standardMin ? Number(k.standardMin) : 90, fee = k && k.standardFee != null && k.standardFee !== '' ? Number(k.standardFee) : Math.round((Number(st.rate30) || 0) * lessonMin / 30);
    var res = planLineSave_({ studentId: id, subject: d.subject, kind: d.kind, count: d.count, startDate: ym + '-01', endDate: planMonthEnd_(ym), lessonMin: lessonMin, lessonFee: fee, comment: '', propose: false });
    if (res.error && res.errorCode === 'overlap') { skipped++; continue; }
    if (res.error) return res;
    created++; memoClear_();
  }
  return { ok: true, created: created, skipped: skipped };
}

// 月ごとの集約(管理画面の一覧・MCP・請求の状態表示)。その月にかかる行(見送りを除く)から求める
function billingMonthInfo_(studentId, ym) {
  var all = planLinesFor_(String(studentId)).filter(function (l) { return planLineOverlapsMonth_(l, ym); });
  var lines = all.filter(function (l) { return l.status !== 'declined'; });
  var status = !all.length ? 'none' : !lines.length ? 'declined' : lines.every(function (l) { return l.status === 'approved'; }) ? 'approved' : lines.some(function (l) { return l.status === 'proposed'; }) ? 'proposed' : 'draft';
  var total = 0; lines.forEach(function (l) { total += planLineLimit_(l); });
  return { ym: ym, status: status, total: total, revision: 0, rows: lines.map(function (l) { return { subject: l.subject, kind: l.kind, count: planLineLimit_(l), status: l.status }; }),
    approvedVia: lines.filter(function (l) { return l.status === 'approved'; }).map(function (l) { return l.approvedVia; }).filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('・'),
    lines: all.sort(planLineSort_).map(planLineView_) };
}

// 旧: 月間承認(monthAgreements + plans の月行 + planComments) → 行へ移行。planLines シートを作った直後に一度だけ動く(冪等)
function planLinesMigrate_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PLAN_LINES_MIGRATED')) return;
  var ss = ss_(), n = 0, seen = {};
  // 途中で止まった移行を二重に流さない: 行が既にあれば移行済みとみなす
  if (planLineRows_().length) { props.setProperty('PLAN_LINES_MIGRATED', billingStamp_() + ':existing'); return; }
  function comment(sid, ym) { return ss.getSheetByName('planComments') && typeof planComment_ === 'function' ? planComment_(sid, ym) : ''; }
  function put(sid, ym, row, terms, status, a) {
    var st = systemStudent_(sid); if (!st) return;
    var l = { id: billingId_(), studentId: sid, subject: String(row.subject || ''), kind: kindNorm_(row.kind), count: Number(row.count) || 0, startDate: ym + '-01', endDate: planMonthEnd_(ym),
      lessonMin: terms.lessonMin, rate30: terms.rate30, comment: comment(sid, ym), status: status, revision: Number(a && a.revision) || 1, proposedAt: String(a && a.proposedAt || ''), approvedAt: String(a && a.approvedAt || ''),
      approvedVia: String(a && a.approvedVia || ''), consentDate: planDate_(a && a.consentDate), memo: String(a && a.memo || ''), approvedCount: status === 'approved' ? Number(row.count) || 0 : status === 'declined' ? 0 : null, createdAt: '' };
    if (!l.subject || !l.count) return;
    planLineWrite_(l); n++;
  }
  if (ss.getSheetByName('monthAgreements')) {
    readRows_('monthAgreements').forEach(function (a) {
      var sid = String(a.studentId || ''), ym = String(a.ym || ''); if (!sid || !billingMonthValid_(ym)) return;
      seen[sid + '|' + ym] = true;
      var st = systemStudent_(sid) || {}, status = ['proposed', 'approved', 'declined'].indexOf(String(a.status)) >= 0 ? String(a.status) : 'draft';
      var rows = []; try { rows = JSON.parse(String((status === 'approved' || status === 'declined') && a.approvedPlanJson ? a.approvedPlanJson : a.planJson || '[]')); } catch (e) { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      var lessonMin = Number(a.lessonMin) || 90, rate30 = a.rate30 !== '' && a.rate30 != null && !(Number(a.monthly) > 0) ? Number(a.rate30) : Number(st.rate30) || 0;
      rows.forEach(function (row) { put(sid, ym, row, { lessonMin: lessonMin, rate30: rate30 }, status, a); });
    });
  }
  if (ss.getSheetByName('plans')) {
    planRows_().forEach(function (p) {
      if (p.ym === 'default' || !billingMonthValid_(p.ym) || seen[p.studentId + '|' + p.ym]) return;
      var st = systemStudent_(p.studentId) || {};
      put(p.studentId, p.ym, p, { lessonMin: 90, rate30: Number(st.rate30) || 0 }, 'draft', null);
    });
  }
  props.setProperty('PLAN_LINES_MIGRATED', billingStamp_() + ':' + n);
  memoClear_();
  if (n) addLog_('授業計画を行単位へ移行: ' + n + '行');
}
