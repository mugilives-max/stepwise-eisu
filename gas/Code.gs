/**
 * ステップワイズ個別指導 予約システム バックエンド (Google Apps Script)
 *
 * セットアップ:
 * 1. スプレッドシートの 拡張機能 > Apps Script にこのコードを貼り付け
 * 2. エディタで setup() を一度実行(初回は権限の承認が必要)
 * 3. デプロイ > 新しいデプロイ > ウェブアプリ
 *    - 実行ユーザー: 自分 / アクセスできるユーザー: 全員
 * 4. 発行された /exec のURLをフロントエンド(yoyaku/index.html)の API 定数に設定
 */

var TZ = 'Asia/Tokyo';
var CAL_TITLE_PREFIX = '【塾】';
var SITE_URL = 'https://www.stepwise-education.jp/yoyaku/';

/* ================= 初期セットアップ ================= */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, 'config', ['key', 'value']);
  ensureSheet_(ss, 'students', ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly']);
  ensureSheet_(ss, 'slots', ['id', 'date', 'start', 'min', 'status', 'studentId', 'done', 'eventId', 'meetUrl']);
  ensureSheet_(ss, 'log', ['time', 'message']);
  if (!getConfig_('pin')) setConfig_('pin', '0000');
  if (!getConfig_('calendarSync')) setConfig_('calendarSync', 'on');
  if (!getConfig_('emailNotify')) setConfig_('emailNotify', 'on');
  // 権限承認をここでまとめて発生させる
  CalendarApp.getDefaultCalendar().getName();
  MailApp.getRemainingDailyQuota();
  Logger.log('setup 完了');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

/* ================= HTTPエンドポイント ================= */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === 'state') return json_(studentState_(p.k || ''));
    if (p.action === 'authmode') return json_({ mode: authMode_() });
    return json_({ ok: true, service: 'stepwise-yoyaku' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureEmailHeader_();
    ensureMeetHeader_();
    ensureCodeHeader_();
    ensureFeeHeaders_();
    var req = JSON.parse(e.postData.contents);
    var res;
    switch (req.action) {
      case 'accept':  res = accept_(req.slotId, req.k); break;
      case 'decline': res = decline_(req.slotId, req.k); break;
      case 'cancel':  res = cancel_(req.slotId, req.k); break;
      case 'admin':  res = admin_(req); break;
      default:       res = { error: 'unknown action' };
    }
    return json_(res);
  } catch (err) {
    return json_({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================= 生徒向け ================= */

function studentState_(code) {
  var me = findStudentByCode_(code);
  if (!me) return { me: null, slots: [], today: todayStr_() };
  var today = todayStr_();
  // 本人の予定・案内のみ返す(他の生徒の予定は一切送らない)
  var slots = readRows_('slots')
    .filter(function (s) {
      return s.date >= today && String(s.studentId) === String(me.id);
    })
    .map(function (s) {
      var st = s.status === 'offered' ? 'offer' : 'mine';
      return {
        id: s.id, date: s.date, start: s.start, min: Number(s.min), st: st,
        meet: st === 'mine' ? String(s.meetUrl || '') : ''
      };
    });
  return { me: { name: me.name }, slots: slots, today: today };
}

function findStudentByCode_(code) {
  code = String(code == null ? '' : code).trim();
  if (!code) return null;
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].code || '') === code &&
        !(String(rows[i].active) === 'false' || rows[i].active === false)) return rows[i];
  }
  return null;
}

function accept_(slotId, code) {
  var student = findStudentByCode_(code);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = findSlotRow_(slotId);
  if (!r) return { error: 'この案内は見つかりません', refresh: true };
  if (r.slot.status !== 'offered' || String(r.slot.studentId) !== String(student.id)) {
    return { error: 'この案内は承認できません', refresh: true };
  }
  r.slot.status = 'booked';
  var cal = createCalEvent_(r.slot, student);
  r.slot.eventId = cal.eventId;
  r.slot.meetUrl = cal.meetUrl;
  writeSlotRow_(r);
  addLog_(student.name + 'さんが ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' の案内を承認');
  notify_('【確定】' + student.name + 'さん',
    student.name + 'さんが案内を承認し、授業が確定しました。\n' +
    fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min) +
    (cal.meetUrl ? '\nMeet: ' + cal.meetUrl : ''));
  return { ok: true, state: studentState_(code) };
}

function decline_(slotId, code) {
  var student = findStudentByCode_(code);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = findSlotRow_(slotId);
  if (!r) return { error: 'この案内は見つかりません', refresh: true };
  if (r.slot.status !== 'offered' || String(r.slot.studentId) !== String(student.id)) {
    return { error: 'この案内は操作できません', refresh: true };
  }
  var when = fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min);
  sheet_('slots').deleteRow(r.rowIndex);
  addLog_(student.name + 'さんが ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' の案内を「都合が悪い」');
  notify_('【都合が悪い】' + student.name + 'さん',
    student.name + 'さんが案内「' + when + '」を都合が悪いと回答しました。\n別の時間を案内してください。');
  return { ok: true, state: studentState_(code) };
}

function cancel_(slotId, code) {
  var student = findStudentByCode_(code);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = findSlotRow_(slotId);
  if (!r) return { error: 'この予約は見つかりません', refresh: true };
  if (r.slot.status !== 'booked' || String(r.slot.studentId) !== String(student.id)) {
    return { error: 'この予約は取り消せません', refresh: true };
  }
  var name = student.name;
  deleteCalEvent_(r.slot);
  r.slot.status = 'open';
  r.slot.studentId = '';
  r.slot.done = '';
  r.slot.eventId = '';
  r.slot.meetUrl = '';
  writeSlotRow_(r);
  addLog_(name + 'さんが ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' を取消');
  notify_('【取消】' + name + 'さん',
    name + 'さんが予約を取り消しました。\n' +
    fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min));
  return { ok: true, state: studentState_(code) };
}

/* ================= 先生向け(PIN必須) ================= */

function pinOk_(input) {
  var stored = String(getConfig_('pin'));
  input = String(input == null ? '' : input).trim();
  if (input !== '' && input === stored) return true;
  // 「0000」のような数字PINがシート上で数値化(先頭ゼロ欠落)した場合の救済
  return /^\d+$/.test(input) && String(Number(input)) === stored;
}

/* ---- 先生アカウント認証 ---- */

function authMode_() {
  return getConfig_('passHash') ? 'account' : 'pin';
}

function hashPass_(password, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var v = (raw[i] + 256) % 256;
    out += ('0' + v.toString(16)).slice(-2);
  }
  return out;
}

function issueToken_() {
  var t = newCode_() + newCode_();
  setConfig_('adminToken', t);
  setConfig_('adminTokenExp', String(Date.now() + 30 * 24 * 3600 * 1000));
  return t;
}

function tokenOk_(token) {
  var t = getConfig_('adminToken');
  var exp = Number(getConfig_('adminTokenExp') || 0);
  return !!token && !!t && String(token) === t && Date.now() < exp;
}

function authOk_(req) {
  if (authMode_() === 'account') return tokenOk_(req.token);
  return pinOk_(req.pin);
}

function adminSetupAccount_(req) {
  if (authMode_() === 'account') return { error: 'すでにアカウント設定済みです' };
  if (!pinOk_(req.pin)) return { error: 'PINがちがいます' };
  var email = normEmail_(req.email);
  if (!email) return { error: 'メールアドレスの形式がただしくありません' };
  var pass = String(req.password || '');
  if (pass.length < 8) return { error: 'パスワードは8文字以上にしてください' };
  var salt = newCode_() + newCode_();
  setConfig_('teacherEmail', email);
  setConfig_('passSalt', salt);
  setConfig_('passHash', hashPass_(pass, salt));
  var token = issueToken_();
  addLog_('先生アカウントを設定しました');
  return { ok: true, token: token, admin: adminState_() };
}

function adminLogin_(req) {
  if (authMode_() !== 'account') return { error: '先に初期設定をしてください', needSetup: true };
  var lockUntil = Number(getConfig_('lockUntil') || 0);
  if (Date.now() < lockUntil) {
    return { error: '試行回数が多すぎます。10分ほどしてからお試しください' };
  }
  var email = normEmail_(req.email);
  var pass = String(req.password || '');
  var ok = email !== '' && email === getConfig_('teacherEmail') &&
    hashPass_(pass, getConfig_('passSalt')) === getConfig_('passHash');
  if (!ok) {
    var fails = Number(getConfig_('failCount') || 0) + 1;
    if (fails >= 5) {
      setConfig_('lockUntil', String(Date.now() + 10 * 60000));
      setConfig_('failCount', '0');
    } else {
      setConfig_('failCount', String(fails));
    }
    return { error: 'メールアドレスまたはパスワードがちがいます' };
  }
  setConfig_('failCount', '0');
  var token = issueToken_();
  return { ok: true, token: token, admin: adminState_() };
}

function adminChangePass_(req) {
  if (hashPass_(String(req.current || ''), getConfig_('passSalt')) !== getConfig_('passHash')) {
    return { error: '現在のパスワードがちがいます' };
  }
  var pass = String(req.newPass || '');
  if (pass.length < 8) return { error: '新しいパスワードは8文字以上にしてください' };
  var salt = newCode_() + newCode_();
  setConfig_('passSalt', salt);
  setConfig_('passHash', hashPass_(pass, salt));
  var token = issueToken_();
  return { ok: true, token: token, admin: adminState_() };
}

function admin_(req) {
  if (req.op === 'login') return adminLogin_(req);
  if (req.op === 'setupAccount') return adminSetupAccount_(req);
  if (!authOk_(req)) return { error: 'ログインし直してください', badAuth: true };
  switch (req.op) {
    case 'state':       return { ok: true, admin: adminState_() };
    case 'offer':       return adminOffer_(req);
    case 'deleteSlot':  return adminDeleteSlot_(req);
    case 'unbook':      return adminUnbook_(req);
    case 'toggleDone':  return adminToggleDone_(req);
    case 'addStudent':  return adminAddStudent_(req);
    case 'setEmail':    return adminSetEmail_(req);
    case 'setFee':      return adminSetFee_(req);
    case 'newCode':     return adminNewCode_(req);
    case 'hideStudent': return adminHideStudent_(req);
    case 'changePass':  return adminChangePass_(req);
    case 'logout':
      setConfig_('adminToken', '');
      return { ok: true };
    default: return { error: 'unknown op' };
  }
}

function adminState_() {
  backfillCodes_();
  var slots = readRows_('slots').map(function (s) {
    return {
      id: s.id, date: s.date, start: s.start, min: Number(s.min),
      status: s.status, studentId: String(s.studentId || ''),
      studentName: s.studentId ? studentName_(s.studentId) : '',
      done: String(s.done) === 'true' || s.done === true,
      meetUrl: String(s.meetUrl || '')
    };
  });
  var students = readRows_('students').map(function (s) {
    return {
      id: s.id, name: s.name, email: String(s.email || ''),
      code: String(s.code || ''),
      rate30: Number(s.rate30 || 0),
      monthly: Number(s.monthly || 0),
      active: !(String(s.active) === 'false' || s.active === false)
    };
  });
  var log = readRows_('log').slice(-30).reverse().map(function (l) {
    return { time: fmtLogTime_(l.time), message: l.message };
  });
  return {
    slots: slots, students: students, log: log, today: todayStr_(),
    account: getConfig_('teacherEmail')
  };
}

function adminOffer_(req) {
  var student = null;
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId) &&
        !(String(rows[i].active) === 'false' || rows[i].active === false)) student = rows[i];
  }
  if (!student) return { error: '案内する生徒をえらんでください' };
  var sh = sheet_('slots');
  var existing = readRows_('slots');
  var added = 0;
  var dates = [];
  var repeat = Math.max(1, Math.min(12, Number(req.repeat) || 1));
  for (var w = 0; w < repeat; w++) {
    var d = addDays_(req.date, w * 7);
    var dup = existing.some(function (s) { return s.date === d && s.start === req.start; });
    if (dup) continue;
    sh.appendRow([uid_(), d, req.start, Number(req.min) || 60, 'offered', student.id, '', '', '']);
    dates.push(fmtDateJa_(d));
    added++;
  }
  if (added > 0) {
    addLog_('先生が' + student.name + 'さんに' + added + '件案内(' + fmtDateJa_(req.date) + ' ' + req.start + (repeat > 1 ? ' から毎週' : '') + ')');
    offerMailToStudent_(student, dates, req.start, Number(req.min) || 60);
  }
  return { ok: true, added: added, admin: adminState_() };
}

// メール登録済みの生徒には案内の連絡を送る(専用リンク付き)
function offerMailToStudent_(student, dates, start, min) {
  var email = normEmail_(student.email);
  if (!email) return;
  try {
    var link = SITE_URL + '?k=' + String(student.code || '');
    MailApp.sendEmail(email,
      '[ステップワイズ] 授業のご案内が届いています',
      student.name + 'さん\n\n先生から授業のご案内が届いています。\n\n' +
      dates.map(function (d) { return '・' + d + ' ' + start + '〜' + endTime_(start, min); }).join('\n') +
      '\n\n下のあなた専用リンクをひらいて、承認するか、都合が悪いかを選んでください。\n' + link);
  } catch (err) {
    addLog_('案内メールの送信に失敗: ' + err);
  }
}

function adminDeleteSlot_(req) {
  var r = findSlotRow_(req.slotId);
  if (!r) return { error: '枠が見つかりません' };
  if (r.slot.status === 'booked') return { error: '予約が入っている枠です。先に予約を解除してください' };
  sheet_('slots').deleteRow(r.rowIndex);
  return { ok: true, admin: adminState_() };
}

function adminUnbook_(req) {
  var r = findSlotRow_(req.slotId);
  if (!r || r.slot.status !== 'booked') return { error: '予約が見つかりません' };
  var name = studentName_(r.slot.studentId);
  deleteCalEvent_(r.slot);
  r.slot.status = 'open';
  r.slot.studentId = '';
  r.slot.done = '';
  r.slot.eventId = '';
  r.slot.meetUrl = '';
  writeSlotRow_(r);
  addLog_('先生が ' + name + 'さんの ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' を解除');
  return { ok: true, admin: adminState_() };
}

function adminToggleDone_(req) {
  var r = findSlotRow_(req.slotId);
  if (!r) return { error: '枠が見つかりません' };
  r.slot.done = !(String(r.slot.done) === 'true' || r.slot.done === true);
  writeSlotRow_(r);
  return { ok: true, admin: adminState_() };
}

function adminAddStudent_(req) {
  var name = String(req.name || '').trim();
  if (!name) return { error: '名前を入れてください' };
  var dup = readRows_('students').some(function (s) {
    return s.name === name && !(String(s.active) === 'false' || s.active === false);
  });
  if (dup) return { error: '同じ名前の生徒がいます' };
  sheet_('students').appendRow([uid_(), name, true, normEmail_(req.email), newCode_(), 1500, '']);
  return { ok: true, admin: adminState_() };
}

function adminSetFee_(req) {
  var rate30 = Math.max(0, Number(req.rate30) || 0);
  var monthly = Math.max(0, Number(req.monthly) || 0);
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId)) {
      sheet_('students').getRange(i + 2, 6, 1, 2).setValues([[rate30, monthly || '']]);
      return { ok: true, admin: adminState_() };
    }
  }
  return { error: '生徒が見つかりません' };
}

function ensureFeeHeaders_() {
  var sh = sheet_('students');
  if (!sh) return;
  if (sh.getRange(1, 6).getValue() !== 'rate30') sh.getRange(1, 6).setValue('rate30');
  if (sh.getRange(1, 7).getValue() !== 'monthly') sh.getRange(1, 7).setValue('monthly');
}

function newCode_() {
  return uid_() + uid_();
}

function adminNewCode_(req) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId)) {
      var cell = sheet_('students').getRange(i + 2, 5);
      cell.setNumberFormat('@');
      cell.setValue(newCode_());
      return { ok: true, admin: adminState_() };
    }
  }
  return { error: '生徒が見つかりません' };
}

// コード・単価が未設定の生徒に自動設定(旧データの移行用)
function backfillCodes_() {
  ensureCodeHeader_();
  ensureFeeHeaders_();
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (!String(rows[i].code || '')) {
      var cell = sheet_('students').getRange(i + 2, 5);
      cell.setNumberFormat('@');
      cell.setValue(newCode_());
    }
    if (!Number(rows[i].rate30 || 0)) {
      sheet_('students').getRange(i + 2, 6).setValue(1500);
    }
  }
}

function ensureCodeHeader_() {
  var sh = sheet_('students');
  if (sh && sh.getRange(1, 5).getValue() !== 'code') {
    sh.getRange(1, 5).setValue('code');
  }
}

function adminSetEmail_(req) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId)) {
      var cell = sheet_('students').getRange(i + 2, 4);
      cell.setNumberFormat('@');
      cell.setValue(normEmail_(req.email));
      return { ok: true, admin: adminState_() };
    }
  }
  return { error: '生徒が見つかりません' };
}

function ensureEmailHeader_() {
  var sh = sheet_('students');
  if (sh && sh.getRange(1, 4).getValue() !== 'email') {
    sh.getRange(1, 4).setValue('email');
  }
}

function normEmail_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

function adminHideStudent_(req) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId)) {
      sheet_('students').getRange(i + 2, 3).setValue(false);
    }
  }
  return { ok: true, admin: adminState_() };
}

/* ================= カレンダー・通知 ================= */

function createCalEvent_(slot, student) {
  if (getConfig_('calendarSync') !== 'on') return { eventId: '', meetUrl: '' };
  try {
    var start = dateTimeOf_(slot.date, slot.start);
    var end = new Date(start.getTime() + Number(slot.min) * 60000);
    var opts = {};
    var email = normEmail_(student.email);
    if (email) {
      // 生徒のメールが登録されていればカレンダー招待を自動送信
      opts.guests = email;
      opts.sendInvites = true;
    }
    var ev = CalendarApp.getDefaultCalendar()
      .createEvent(CAL_TITLE_PREFIX + student.name + 'さん 授業', start, end, opts);
    ev.addPopupReminder(60);
    var meetUrl = '';
    try {
      meetUrl = addMeet_(ev.getId());
    } catch (e2) {
      addLog_('Meet作成に失敗: ' + e2);
    }
    return { eventId: ev.getId(), meetUrl: meetUrl };
  } catch (err) {
    addLog_('カレンダー登録に失敗: ' + err);
    return { eventId: '', meetUrl: '' };
  }
}

// 高度なサービス「Google Calendar API」(識別子 Calendar) を有効にしておくこと
function addMeet_(calEventId) {
  var id = String(calEventId).split('@')[0];
  var existing = Calendar.Events.get('primary', id);
  if (existing.hangoutLink) return existing.hangoutLink;
  var res = Calendar.Events.patch(
    {
      conferenceData: {
        createRequest: {
          requestId: uid_() + uid_(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    },
    'primary', id, { conferenceDataVersion: 1 });
  if (res.hangoutLink) return res.hangoutLink;
  var eps = (res.conferenceData && res.conferenceData.entryPoints) || [];
  for (var i = 0; i < eps.length; i++) {
    if (eps[i].entryPointType === 'video') return eps[i].uri || '';
  }
  return '';
}

function ensureMeetHeader_() {
  var sh = sheet_('slots');
  if (sh && sh.getRange(1, 9).getValue() !== 'meetUrl') {
    sh.getRange(1, 9).setValue('meetUrl');
  }
}

function deleteCalEvent_(slot) {
  if (!slot.eventId) return;
  try {
    var ev = CalendarApp.getDefaultCalendar().getEventById(slot.eventId);
    if (ev) ev.deleteEvent();
  } catch (err) {
    addLog_('カレンダー削除に失敗: ' + err);
  }
}

function notify_(subject, body) {
  if (getConfig_('emailNotify') !== 'on') return;
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      '[ステップワイズ予約] ' + subject, body);
  } catch (err) {
    addLog_('メール通知に失敗: ' + err);
  }
}

/* ================= シート操作ヘルパー ================= */

function sheet_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

function readRows_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    obj.date = normDate_(obj.date);
    obj.start = normTime_(obj.start);
    out.push(obj);
  }
  return out;
}

function findSlotRow_(slotId) {
  var rows = readRows_('slots');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(slotId)) {
      return { slot: rows[i], rowIndex: i + 2 };
    }
  }
  return null;
}

function writeSlotRow_(r) {
  var s = r.slot;
  sheet_('slots').getRange(r.rowIndex, 1, 1, 9)
    .setValues([[s.id, s.date, s.start, s.min, s.status, s.studentId, s.done, s.eventId, s.meetUrl || '']]);
}

function findStudent_(sid) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(sid) &&
        !(String(rows[i].active) === 'false' || rows[i].active === false)) return rows[i];
  }
  return null;
}

function studentName_(sid) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(sid)) return rows[i].name;
  }
  return '(不明)';
}

function getConfig_(key) {
  var rows = readRows_('config');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) return String(rows[i].value);
  }
  return '';
}

function setConfig_(key, value) {
  var rows = readRows_('config');
  var sh = sheet_('config');
  var cell;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      cell = sh.getRange(i + 2, 2);
      cell.setNumberFormat('@'); // 文字列として保存(先頭ゼロを守る)
      cell.setValue(String(value));
      return;
    }
  }
  sh.appendRow([key, '']);
  cell = sh.getRange(sh.getLastRow(), 2);
  cell.setNumberFormat('@');
  cell.setValue(String(value));
}

function addLog_(message) {
  sheet_('log').appendRow([new Date(), message]);
}

/* ================= 日付ヘルパー ================= */

function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '');
}

function normTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  var s = String(v || '');
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return ('0' + m[1]).slice(-2) + ':' + m[2];
  return s;
}

function dateTimeOf_(dateStr, timeStr) {
  return new Date(dateStr + 'T' + timeStr + ':00+09:00');
}

function addDays_(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function endTime_(start, min) {
  var p = String(start).split(':');
  var t = Number(p[0]) * 60 + Number(p[1]) + Number(min);
  return ('0' + (Math.floor(t / 60) % 24)).slice(-2) + ':' + ('0' + (t % 60)).slice(-2);
}

function fmtDateJa_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return (d.getMonth() + 1) + '/' + d.getDate() + '(' + wd + ')';
}

function fmtLogTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'M/d HH:mm');
  return String(v || '');
}

function uid_() {
  return Utilities.getUuid().slice(0, 8);
}
