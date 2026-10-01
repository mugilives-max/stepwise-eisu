/* 講師アカウント（雇用する講師）。
 * 方針: 講師には業務の遂行に必要な情報だけを返す（2026-10-01 先生と決定）。
 *   見せる: 自分が担当する授業の予定、担当授業の授業記録（入力・公開・宿題）、担当生徒の前回の記録・宿題・計画の位置づけ、
 *           担当生徒の成績・模試（読み取りのみ）、「先生だけのメモ」（講師と共有する）
 *   見せない: 料金・請求・入金、保護者の連絡先・メール、生徒の専用リンク、担当外の生徒、設定、ログ
 *   させない: 授業の案内・変更・取消、授業計画の作成（取消・変更の連絡は先生へ回す）
 * 返す内容は許可リスト方式で組み立てる（kanriStudent_ の profile のように行を丸ごと返さない）。
 * ログイン・セッション・パスワードは保護者アカウントと同じ作り（PBKDF2、端末ごとのセッション、失敗時のロック）。 */
var INSTRUCTOR_COLS_ = ['id','name','email','status','passSalt','passHash','createdAt','updatedAt','lastLogin','failCount','lockUntil','tokenHash','tokenExpiresAt','securityVersion','inviteHash','inviteExpiresAt','inviteFailCount'];
var INSTRUCTOR_INVITE_MS_ = 7 * 24 * 3600 * 1000;
var INSTRUCTOR_INVITE_URL_ = 'https://www.stepwise-education.jp/kanri/#instructor-invite=';
var INSTRUCTOR_LESSON_OPS_ = ['lessonContext','lessonRecordDraftSave','lessonPreparationSave','lessonRecordSave','lessonHomeworkApply','lessonHomeworkWithdraw','lessonReportDraftSave','lessonWriteResume'];
// 授業記録を保存した人。講師の操作中だけ 'instructor:<id>' になる（1リクエストごとに戻す）
var INSTRUCTOR_ACTOR_ = '';

function ensureInstructorSchema_() {
  billingEnsureColumns_(ss_(), 'instructors', INSTRUCTOR_COLS_);
  // 授業の担当講師。slots の14列目（13列目は kind）。空 = 先生本人
  var sh = ss_().getSheetByName('slots');
  if (sh && sh.getRange(1, 14).getValue() !== 'instructorId') {
    if (sh.getRange(1, 13).getValue() !== 'kind') throw new Error('slotsの列構成を確認してください（13列目が kind ではありません）');
    sh.getRange(1, 14).setValue('instructorId');
  }
  memoClear_();
}
function instructorError_(message, code) { return {error: message, errorCode: code || 'validation'}; }
function instructorRows_() { return ss_().getSheetByName('instructors') ? familyRows_('instructors') : []; }
function instructorById_(id) {
  var rows = instructorRows_().filter(function (r) { return String(r.id) === String(id); });
  if (rows.length > 1) throw new Error('講師の登録が重複しています');
  return rows[0] || null;
}
function instructorByEmail_(email) {
  if (!email) return null;
  var rows = instructorRows_().filter(function (r) { return String(r.email) === String(email); });
  if (rows.length > 1) throw new Error('講師のメール登録が重複しています');
  return rows[0] || null;
}
function instructorSave_(r) { r.updatedAt = familyStamp_(); familyWrite_('instructors', INSTRUCTOR_COLS_, r); }
function instructorInvalidate_(r) { r.tokenHash = ''; r.tokenExpiresAt = ''; r.securityVersion = (Number(r.securityVersion) || 0) + 1; }
function instructorName_(id) { var r = id ? instructorById_(id) : null; return r ? String(r.name) : ''; }
function instructorPublic_(r) {
  return {id: String(r.id), name: String(r.name), email: String(r.email), status: String(r.status), configured: !!r.passHash,
    inviteExpiresAt: r.inviteHash && Number(r.inviteExpiresAt) > Date.now() ? Number(r.inviteExpiresAt) : 0,
    lastLogin: String(r.lastLogin || ''), createdAt: String(r.createdAt || '')};
}
// 案内・授業の詳細で選ぶ候補（停止中は選べない）
function instructorOptions_() {
  return instructorRows_().filter(function (r) { return r.status !== 'disabled'; }).map(function (r) { return {id: String(r.id), name: String(r.name)}; });
}
// 担当講師の指定を確かめる。'' は先生本人
function instructorAssignable_(id) {
  id = String(id == null ? '' : id);
  if (!id) return {id: ''};
  var r = instructorById_(id);
  if (!r || r.status === 'disabled') return instructorError_('担当の講師を選び直してください');
  return {id: String(r.id)};
}

/* ---------- ログイン・セッション ---------- */
function instructorTokenShape_(token) { return /^in1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(String(token || '')); }
function instructorRequire_(req) {
  var token = String(req.token || ''), r = instructorTokenShape_(token) ? instructorById_(token.split('.')[1]) : null;
  var ok = !!(r && r.status === 'active' && r.passHash && familySessions_(r).some(function (x) { return parentEqual_(x.hash, parentDigest_('instructor-session', r.id, token)); }));
  return ok ? {instructor: r} : {error: '講師としてログインし直してください', badAuth: true};
}
function instructorIssueSession_(r) {
  var sessions = familySessions_(r).slice(-9), token = 'in1.' + r.id + '.' + parentSecret_(), exp = Date.now() + PARENT_SESSION_MS_;
  sessions.push({hash: parentDigest_('instructor-session', r.id, token), expiresAt: exp});
  r.tokenHash = JSON.stringify(sessions); r.tokenExpiresAt = exp; r.lastLogin = familyStamp_(); r.failCount = 0; r.lockUntil = ''; instructorSave_(r);
  return {ok: true, token: token, role: 'instructor', instructor: {id: String(r.id), name: String(r.name)}};
}
function instructorPassword_(r, pass) {
  pass = String(pass || '');
  if (r && Number(r.lockUntil) > Date.now()) return false;
  if (r && Number(r.lockUntil)) { r.failCount = 0; r.lockUntil = ''; }
  var valid = pass.length >= 12 && pass.length <= 128;
  var hash = valid ? parentPasswordHash_(pass, r && r.passSalt ? String(r.passSalt) : 'instructor-login-unknown') : '';
  var same = !!(r && r.passHash && valid && parentEqual_(r.passHash, hash));
  if (r) { r.failCount = same ? 0 : Number(r.failCount || 0) + 1; r.lockUntil = r.failCount >= PARENT_MAX_FAILURES_ ? Date.now() + PARENT_LOCK_MS_ : ''; instructorSave_(r); }
  return same;
}
// 管理画面のログイン欄から。先生のメールでなければこちらに来る（先生のロック・失敗回数とは別に数える）
function instructorLogin_(req) {
  var r = instructorByEmail_(familyEmail_(req.email));
  if (!instructorPassword_(r, req.password) || !r || r.status !== 'active') return {error: 'メールアドレスまたはパスワードがちがいます。続けて間違えた場合は15分後にお試しください'};
  return instructorIssueSession_(r);
}
function instructorLogout_(r, req) {
  var token = String(req.token || ''), sessions = familySessions_(r).filter(function (x) { return !parentEqual_(x.hash, parentDigest_('instructor-session', r.id, token)); });
  r.tokenHash = sessions.length ? JSON.stringify(sessions) : ''; r.tokenExpiresAt = sessions.reduce(function (n, x) { return Math.max(n, Number(x.expiresAt)); }, 0) || ''; instructorSave_(r);
  return {ok: true};
}

/* ---------- 招待（初回・パスワードの再設定とも同じ） ---------- */
function instructorInviteFind_(code) {
  var p = String(code || '').trim().split('.'), r = p.length === 3 && p[0] === 'ii1' ? instructorById_(p[1]) : null;
  if (!r || r.status === 'disabled' || !r.inviteHash || Number(r.inviteExpiresAt) <= Date.now()) return null;
  if (!/^[a-f0-9]{64}$/.test(p[2]) || !parentEqual_(r.inviteHash, parentDigest_('instructor-invite', r.id, p[2]))) {
    r.inviteFailCount = Number(r.inviteFailCount || 0) + 1; if (r.inviteFailCount >= PARENT_MAX_FAILURES_) r.inviteHash = ''; instructorSave_(r);
    return null;
  }
  return r;
}
function instructorInviteInfo_(req) {
  var r = instructorInviteFind_(req.invite);
  return r ? {ok: true, name: String(r.name), email: String(r.email), configured: !!r.passHash} : {error: 'この招待リンクは期限切れか、すでに使われています。先生に再発行を頼んでください', inviteUnavailable: true};
}
function instructorSetup_(req) {
  var r = instructorInviteFind_(req.invite), pass = String(req.password || '');
  if (!r) return {error: 'この招待リンクは期限切れか、すでに使われています。先生に再発行を頼んでください', inviteUnavailable: true};
  if (pass.length < 12 || pass.length > 128) return instructorError_('パスワードは12〜128文字で設定してください');
  r.passSalt = parentSecret_(); r.passHash = parentPasswordHash_(pass, r.passSalt);
  r.status = 'active'; r.inviteHash = ''; r.inviteExpiresAt = ''; r.inviteFailCount = 0; r.failCount = 0; r.lockUntil = '';
  instructorInvalidate_(r);
  return instructorIssueSession_(r);
}
function instructorIssueInvite_(r) {
  var secret = parentSecret_();
  r.inviteHash = parentDigest_('instructor-invite', r.id, secret); r.inviteExpiresAt = Date.now() + INSTRUCTOR_INVITE_MS_; r.inviteFailCount = 0; instructorSave_(r);
  return INSTRUCTOR_INVITE_URL_ + 'ii1.' + r.id + '.' + secret;
}

/* ---------- 先生の操作（管理画面の設定ページ） ---------- */
function instructorAdminOp_(req) {
  if (req.op === 'instructorList') return {ok: true, instructors: instructorRows_().map(instructorPublic_), work: instructorWork_(String(req.ym || todayStr_().slice(0, 7)))};
  if (req.op === 'instructorAdd') {
    var name = String(req.name || '').trim(), email = familyEmail_(req.email);
    if (!name || name.length > 40) return instructorError_('講師の名前を40文字以内で入力してください');
    if (!email) return instructorError_('メールアドレスを確認してください');
    if (email === normEmail_(getConfig_('teacherEmail')) || instructorByEmail_(email)) return instructorError_('このメールアドレスは登録できません（先生か、ほかの講師が使っています）');
    var r = {id: familyId_(), name: name, email: email, status: 'pending', createdAt: familyStamp_(), securityVersion: 0, failCount: 0};
    var url = instructorIssueInvite_(r);
    addLog_('講師「' + name + '」を追加しました');
    return {ok: true, instructor: instructorPublic_(r), inviteUrl: url, expiresAt: Number(r.inviteExpiresAt)};
  }
  var target = instructorById_(String(req.instructorId || ''));
  if (!target) return instructorError_('講師が見つかりません。画面を更新してください', 'notFound');
  if (req.op === 'instructorInvite') {
    if (target.status === 'disabled') return instructorError_('停止中の講師には発行できません。先に再開してください');
    var link = instructorIssueInvite_(target);
    return {ok: true, instructor: instructorPublic_(target), inviteUrl: link, expiresAt: Number(target.inviteExpiresAt)};
  }
  if (req.op === 'instructorSetActive') {
    if (typeof req.active !== 'boolean') return instructorError_('利用の状態を確認してください');
    target.status = req.active ? (target.passHash ? 'active' : 'pending') : 'disabled';
    if (!req.active) { instructorInvalidate_(target); target.inviteHash = ''; target.inviteExpiresAt = ''; }
    instructorSave_(target);
    addLog_('講師「' + target.name + '」を' + (req.active ? '再開' : '停止') + 'しました');
    return {ok: true, instructor: instructorPublic_(target)};
  }
  return {error: 'unknown op'};
}
// 授業の担当を変える（授業の詳細から）。実施済み・請求済みでも変えられる（記録の担当を直すため）
function setSlotInstructor_(req) {
  var row = findSlotRow_(String(req.slotId || ''));
  if (!row || String(row.slot.studentId) !== String(req.studentId || row.slot.studentId)) return instructorError_('授業が見つかりません。画面を更新してください', 'notFound');
  var pick = instructorAssignable_(req.instructorId); if (pick.error) return pick;
  if (String(row.slot.instructorId || '') === pick.id) return {ok: true};
  sheet_('slots').getRange(row.rowIndex, 14).setValue(pick.id);
  memoClear_();
  addLog_(fmtDateJa_(row.slot.date) + ' ' + row.slot.start + ' ' + studentName_(row.slot.studentId) + 'さんの授業の担当を' + (pick.id ? '「' + instructorName_(pick.id) + '」' : '先生') + 'にしました');
  return {ok: true};
}
// 勤務実績: その月に実施済みにした担当授業の回数と時間（講師ごと）。給与計算の元
function instructorWork_(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return {ym: ym, rows: []};
  var byId = {};
  instructorRows_().forEach(function (r) { byId[String(r.id)] = {instructorId: String(r.id), name: String(r.name), count: 0, minutes: 0, lessons: []}; });
  readRows_('slots').forEach(function (s) {
    var id = String(s.instructorId || '');
    if (!id || !byId[id] || s.status !== 'booked' || String(s.date || '').slice(0, 7) !== ym || !(s.done === true || String(s.done) === 'true')) return;
    var w = byId[id]; w.count++; w.minutes += Number(s.min) || 0;
    w.lessons.push({date: s.date, start: s.start, min: Number(s.min) || 0, subject: String(s.subject || ''), studentName: studentName_(s.studentId)});
  });
  return {ym: ym, rows: Object.keys(byId).map(function (k) { var w = byId[k]; w.lessons.sort(slotSort_); return w; })};
}

/* ---------- 講師本人の操作 ---------- */
function instructorAssignedSlots_(r) { return readRows_('slots').filter(function (s) { return String(s.instructorId || '') === String(r.id) && s.status === 'booked'; }); }
function instructorStudentIds_(r) { var ids = {}; instructorAssignedSlots_(r).forEach(function (s) { ids[String(s.studentId)] = true; }); return ids; }
function instructorSlot_(r, slotId, studentId) {
  var row = slotId ? findSlotRow_(String(slotId)) : null, s = row && row.slot;
  return s && s.status === 'booked' && String(s.instructorId || '') === String(r.id) && String(s.studentId) === String(studentId) ? s : null;
}
function instructorProfile_(studentId) {
  var p = ledgerRows_('生徒台帳').filter(function (x) { return String(x['生徒ID']) === String(studentId); })[0] || {};
  return {grade: String(p['学年'] || ''), school: String(p['学校'] || '')};
}
function instructorHome_(r) {
  memoClear_();
  var today = todayStr_(), from = addDays_(today, -60), to = addDays_(today, 61), names = {}, students = {};
  var lessons = instructorAssignedSlots_(r).filter(function (s) { return s.date >= from && s.date < to; }).sort(slotSort_).map(function (s) {
    var sid = String(s.studentId); if (!names[sid]) names[sid] = studentName_(sid);
    students[sid] = true;
    return {id: String(s.id), date: s.date, start: s.start, min: Number(s.min) || 0, subject: String(s.subject || ''), kind: kindNorm_(s.kind), deliveryMode: String(s.deliveryMode || ''),
      meetUrl: String(s.meetUrl || ''), studentId: sid, studentName: names[sid], done: s.done === true || String(s.done) === 'true', lessonRecordStatus: lessonMetadata_(sid, s.id).lessonRecordStatus};
  });
  Object.keys(instructorStudentIds_(r)).forEach(function (sid) { students[sid] = true; if (!names[sid]) names[sid] = studentName_(sid); });
  return {ok: true, data: {role: 'instructor', me: {id: String(r.id), name: String(r.name)}, today: today, lessons: lessons,
    students: Object.keys(students).map(function (sid) { var p = instructorProfile_(sid); return {id: sid, name: names[sid], grade: p.grade, school: p.school}; }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })}};
}
function instructorStudent_(r, req) {
  var sid = String(req.studentId || '');
  if (!instructorStudentIds_(r)[sid]) return instructorError_('担当している生徒だけ表示できます', 'forbidden');
  var grades = ledgerRows_('成績推移').filter(function (x) { return String(x['生徒ID']) === sid; })
    .map(function (x) { return {date: x['日付'], test: x['テスト名'], subject: x['科目'], score: Number(x['点数']), max: Number(x['満点'] || 0) || null, dev: x['偏差値'] === '' ? null : Number(x['偏差値']), rank: x['順位']}; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  var exams = examsFor_(sid, false).map(function (e) { var o = Object.assign({}, e); delete o.row; delete o.url; return o; });
  var tasks = lessonRows_('tasks').filter(function (t) { return String(t.studentId) === sid && t.id && t.title && !t.withdrawnAt && !t.doneAt && !(t.done === true || String(t.done) === 'true'); }).map(lessonTaskView_);
  var p = instructorProfile_(sid);
  return {ok: true, data: {id: sid, name: studentName_(sid), grade: p.grade, school: p.school, grades: grades, exams: exams, tasks: tasks}};
}
// 授業記録画面の「実施にする」。担当授業を実施済みにするだけ（未実施に戻すのは先生）
function instructorDone_(r, req) {
  if (req.done !== true) return instructorError_('実施済みにする操作だけ使えます', 'forbidden');
  if (!instructorSlot_(r, req.slotId, req.studentId)) return instructorError_('担当している授業だけ操作できます', 'forbidden');
  var res = adminToggleDone_({slotId: req.slotId, studentId: req.studentId, done: true});
  return res && res.ok ? {ok: true} : res;
}
// 授業記録の操作。どの授業の記録かを確かめてから、先生と同じ処理に渡す
function instructorLesson_(r, req) {
  var sid = String(req.studentId || ''), slotId = String(req.slotId || '');
  try {
    if (!slotId && req.recordId) slotId = String(lessonOwnedRecord_(lessonId_(req.recordId), lessonId_(sid)).slotId);
    if (!slotId && req.op === 'lessonWriteResume') {
      var w = lessonFind_('lessonWrites', 'requestId', lessonId_(req.requestId));
      var plan = w ? JSON.parse(w.payloadJson) : null;
      slotId = plan ? String(plan.slotId || (plan.recordId ? lessonOwnedRecord_(plan.recordId, plan.studentId).slotId : '')) : '';
    }
  } catch (e) { slotId = ''; }
  if (!instructorSlot_(r, slotId, sid)) return instructorError_('担当している授業の記録だけ開けます', 'forbidden');
  if (req.op === 'lessonRecordSave' && req.record && req.record.report && typeof req.record.report === 'object' && !String(req.record.report.teacher || '').trim()) req.record.report.teacher = String(r.name);
  var res = lessonAdminBody_(req);
  if (res && res.context) instructorContextFilter_(r, res.context);
  return res;
}
// 「別の授業・過去の記録を開く」に担当外の授業を出さない（開けないので）
function instructorContextFilter_(r, c) {
  var mine = {}; instructorAssignedSlots_(r).forEach(function (s) { mine[String(s.id)] = true; });
  if (Array.isArray(c.lessonChoices)) c.lessonChoices = c.lessonChoices.filter(function (x) { return mine[String(x.id)]; });
  if (Array.isArray(c.otherPrevious)) c.otherPrevious = c.otherPrevious.filter(function (x) { return mine[String(x.slotId)]; });
  c.role = 'instructor';
  return c;
}
function instructorAdmin_(req) {
  var auth = instructorRequire_(req); if (auth.error) return auth;
  var me = auth.instructor;
  INSTRUCTOR_ACTOR_ = 'instructor:' + me.id;
  try {
    if (req.op === 'instructorHome') return instructorHome_(me);
    if (req.op === 'instructorStudent') return instructorStudent_(me, req);
    if (req.op === 'toggleDone') return instructorDone_(me, req);
    if (req.op === 'logout') return instructorLogout_(me, req);
    if (INSTRUCTOR_LESSON_OPS_.indexOf(req.op) >= 0) return instructorLesson_(me, req);
    return instructorError_('この操作は講師のアカウントでは使えません', 'forbidden');
  } finally { INSTRUCTOR_ACTOR_ = ''; }
}
