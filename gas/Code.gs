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
var CANCEL_DEADLINE_H = 24; // 授業の何時間前まで生徒が取消を依頼できるか

/* ================= 初期セットアップ ================= */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, 'config', ['key', 'value']);
  ensureSheet_(ss, 'students', ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly']);
  ensureSheet_(ss, 'slots', ['id', 'date', 'start', 'min', 'status', 'studentId', 'done', 'eventId', 'meetUrl', 'subject']);
  ensureSheet_(ss, 'blocked', ['id', 'studentId', 'date', 'note']);
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
  var t0 = Date.now();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureSchema_();
    var req = JSON.parse(e.postData.contents);
    var res;
    switch (req.action) {
      case 'accept':  res = accept_(req.slotId, req.k); break;
      case 'decline': res = decline_(req.slotId, req.k); break;
      case 'cancel':  res = { error: '取消は先生への依頼制になりました。ページを開き直してください', refresh: true }; break;
      case 'cancelReq': res = cancelReq_(req); break;
      case 'wish':    res = wish_(req); break;
      case 'unwish':  res = unwish_(req); break;
      case 'wishMany': res = wishMany_(req); break;
      case 'eventAddMany': res = eventAddMany_(req); break;
      case 'eventAdd': res = eventAdd_(req); break;
      case 'taskAdd':  res = taskAdd_(req); break;
      case 'taskDone': res = taskDone_(req); break;
      case 'taskDel':  res = taskDel_(req); break;
      case 'grades':  res = studentGrades_(req); break;
      case 'parentLogin': res = parentLogin_(req); break;
      case 'parentData':  res = parentData_(req); break;
      case 'parentPlanDecide': res = parentPlanDecide_(req); break;
      case 'eventDel': res = eventDel_(req); break;
      case 'block':   res = block_(req); break;
      case 'unblock': res = unblock_(req); break;
      case 'blockSet': res = blockSet_(req); break;
      case 'admin':  res = admin_(req); break;
      default:       res = { error: 'unknown action' };
    }
    if (res && typeof res === 'object') res.ms = Date.now() - t0; // 処理時間(ミリ秒)。フロントのconsoleに出る
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
  var all = readRows_('slots').filter(function (s) { return String(s.studentId) === String(me.id); });
  var slots = all
    .filter(function (s) { return s.date >= today; })
    .map(function (s) {
      var st = s.status === 'offered' ? 'offer' : 'mine';
      return {
        id: s.id, date: s.date, start: s.start, min: Number(s.min), st: st,
        subject: String(s.subject || ''),
        meet: st === 'mine' ? String(s.meetUrl || '') : '',
        req: st === 'mine' ? parseReq_(s.req) : null,
        hours: Math.round(hoursUntil_(s.date, s.start) * 10) / 10
      };
    });
  // 過去の授業(直近120日、確定分)。カレンダーの表示と教科ごとの回数に使う。done=実施済み
  var since = addDays_(today, -120);
  var history = all
    .filter(function (s) { return s.date < today && s.date >= since && s.status === 'booked'; })
    .map(function (s) { return { id: s.id, date: s.date, start: s.start, min: Number(s.min), subject: String(s.subject || ''),
      done: String(s.done) === 'true' || s.done === true }; });
  var blocked = readRows_('blocked')
    .filter(function (b) {
      return String(b.studentId) === String(me.id) && b.date >= today;
    })
    .map(function (b) { return { id: b.id, date: b.date, note: String(b.note || '') }; });
  var wishes = wishRows_().filter(function (x) { return String(x.studentId) === String(me.id) && x.date >= today; })
    .map(function (x) { return { id: x.id, date: x.date, start: x.start, end: x.end, note: x.note, kind: x.kind }; });
  var evSince = addDays_(today, -60);
  var events = eventRows_().filter(function (x) { return x.studentId === String(me.id) && x.dateTo >= evSince; })
    .map(function (x) { return { id: x.id, date: x.date, dateTo: x.dateTo, title: x.title, kind: x.kind }; });
  var planInfo = planFor_(me.id, today.slice(0, 7));
  var planMi = planMonthInfo_(me.id, today.slice(0, 7));
  var tasks = tasksFor_(me.id, 45);
  return { me: { name: me.name }, slots: slots, blocked: blocked, history: history, wishes: wishes, events: events, tasks: tasks, plan: planInfo.plan, planStatus: planMi.status, today: today, cancelDeadlineH: CANCEL_DEADLINE_H };
}

function ensureBlockedSheet_() {
  var ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName('blocked')) {
    var sh = ss.insertSheet('blocked');
    sh.appendRow(['id', 'studentId', 'date', 'note']);
  }
}

// date〜dateTo の各日をblockedに追加(共通処理)。追加件数を返す
function addBlockRange_(studentId, date, dateTo, note) {
  var existing = readRows_('blocked');
  var sh = sheet_('blocked');
  var added = 0;
  var d = date;
  for (var i = 0; i < 31 && d <= dateTo; i++) {
    var dd = d;
    var dup = existing.some(function (b) {
      return String(b.studentId) === String(studentId) && b.date === dd;
    });
    if (!dup && dd >= todayStr_()) {
      sh.appendRow([uid_(), studentId, dd, note]);
      added++;
    }
    d = addDays_(d, 1);
  }
  return added;
}

function rangeText_(date, dateTo) {
  return date === dateTo ? fmtDateJa_(date) : fmtDateJa_(date) + '〜' + fmtDateJa_(dateTo);
}

function normRange_(req) {
  var date = String(req.date || '');
  var dateTo = String(req.dateTo || '') || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return null;
  if (dateTo < date) { var t = date; date = dateTo; dateTo = t; }
  return { date: date, dateTo: dateTo };
}

function block_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = normRange_(req);
  if (!r || r.dateTo < todayStr_()) return { error: '今日以降の日付をえらんでください' };
  var note = String(req.note || '').slice(0, 50);
  var added = addBlockRange_(student.id, r.date, r.dateTo, note);
  if (added === 0) return { error: 'この期間はすでに登録されています' };
  addLog_(student.name + 'さんが ' + rangeText_(r.date, r.dateTo) + ' を授業できない日に登録' + (note ? '(' + note + ')' : ''));
  return { ok: true, state: studentState_(req.k) };
}

// 予定表で選んだ日をまとめて登録/解除(add: 追加する日付の配列, removeIds: 解除する登録のid配列)
function blockSet_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var today = todayStr_();
  var seen = {};
  var add = (req.add || []).map(String).filter(function (d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today || seen[d]) return false;
    seen[d] = true; return true;
  }).slice(0, 62).sort();
  var removeIds = (req.removeIds || []).map(String);
  var note = String(req.note || '').slice(0, 50);
  var existing = readRows_('blocked');
  var sh = sheet_('blocked');
  var delRows = [], removedDates = [];
  existing.forEach(function (b, i) {
    if (removeIds.indexOf(String(b.id)) >= 0 && String(b.studentId) === String(student.id)) { delRows.push(i + 2); removedDates.push(b.date); }
  });
  delRows.sort(function (a, b) { return b - a; }).forEach(function (rn) { sh.deleteRow(rn); });
  var added = [];
  add.forEach(function (d) {
    var dup = existing.some(function (b) { return String(b.studentId) === String(student.id) && b.date === d && removedDates.indexOf(d) < 0; });
    if (!dup) { sh.appendRow([uid_(), student.id, d, note]); added.push(d); }
  });
  if (!added.length && !removedDates.length) return { error: '変更はありませんでした' };
  var msg = [];
  if (added.length) msg.push(added.map(fmtDateJa_).join('、') + ' を授業できない日に登録' + (note ? '(' + note + ')' : ''));
  if (removedDates.length) msg.push(removedDates.sort().map(fmtDateJa_).join('、') + ' の授業できない日を解除');
  addLog_(student.name + 'さんが ' + msg.join('。'));
  return { ok: true, state: studentState_(req.k) };
}

function unblock_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var ids = (req.blockIds || (req.blockId ? [req.blockId] : [])).map(String);
  var rows = readRows_('blocked');
  var toDel = [];
  var dates = [];
  rows.forEach(function (b, i) {
    if (ids.indexOf(String(b.id)) >= 0 && String(b.studentId) === String(student.id)) {
      toDel.push(i + 2);
      dates.push(b.date);
    }
  });
  if (toDel.length === 0) return { error: '登録が見つかりません', refresh: true };
  toDel.sort(function (a, b) { return b - a; }).forEach(function (ri) {
    sheet_('blocked').deleteRow(ri);
  });
  dates.sort();
  addLog_(student.name + 'さんが ' + rangeText_(dates[0], dates[dates.length - 1]) + ' の授業できない日を取消');
  return { ok: true, state: studentState_(req.k) };
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
  if (!isTestStudent_(student)) notify_('【確定】' + student.name + 'さん',
    student.name + 'さんが案内を承認し、授業が確定しました。\n' +
    fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min) +
    (r.slot.subject ? '(' + r.slot.subject + ')' : '') +
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
  addLog_(student.name + 'さんが ' + fmtDateJa_(r.slot.date) + ' ' + r.slot.start + ' の案内を「この日時は難しい」');
  if (!isTestStudent_(student)) notify_('【日時が合わない】' + student.name + 'さん',
    student.name + 'さんが案内「' + when + '」を「この日時は難しい」と回答しました。\n別の時間を案内してください。');
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
  if (!isTestStudent_(student)) notify_('【取消】' + name + 'さん',
    name + 'さんが予約を取り消しました。\n' +
    fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min));
  return { ok: true, state: studentState_(code) };
}

/* ================= 取消依頼(生徒→先生) ================= */

function ensureReqHeader_() {
  var sh = sheet_('slots');
  if (sh && sh.getRange(1, 11).getValue() !== 'req') sh.getRange(1, 11).setValue('req');
}

// slots.req 列: JSON文字列 {"kind":"cancel","reason":"...","at":"yyyy-MM-dd HH:mm"}
function parseReq_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  try { var o = JSON.parse(s); return o && o.kind ? o : null; } catch (e) { return null; }
}

function hoursUntil_(date, start) {
  var d = new Date(String(date) + 'T' + String(start || '00:00') + ':00+09:00');
  return (d.getTime() - Date.now()) / 36e5;
}

function mailStudent_(student, subject, body) {
  if (!student || isTestStudent_(student)) return;
  var email = normEmail_(student.email);
  if (!email) return;
  try { MailApp.sendEmail(email, '[ステップワイズ] ' + subject, body); }
  catch (err) { addLog_('生徒へのメール送信に失敗: ' + err); }
}

function cancelReq_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var r = findSlotRow_(req.slotId);
  if (!r || r.slot.status !== 'booked' || String(r.slot.studentId) !== String(student.id)) {
    return { error: 'この予定は見つかりません', refresh: true };
  }
  var when = fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min);
  var name = student.name;
  if (req.withdraw) {
    sheet_('slots').getRange(r.rowIndex, 11).setValue('');
    addLog_(name + 'さんが ' + when + ' の取消依頼を取り下げ');
    if (!isTestStudent_(student)) notify_('【取消依頼の取り下げ】' + name + 'さん', name + 'さんが ' + when + ' の取消依頼を取り下げました。予定どおり行います。');
    return { ok: true, state: studentState_(req.k) };
  }
  if (hoursUntil_(r.slot.date, r.slot.start) < CANCEL_DEADLINE_H) {
    return { error: '授業の' + CANCEL_DEADLINE_H + '時間前を過ぎているため、ここからは依頼できません。先生にLINEで連絡してください', refresh: true };
  }
  var reason = String(req.reason || '').trim().slice(0, 200);
  var obj = { kind: 'cancel', reason: reason, at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') };
  var cell = sheet_('slots').getRange(r.rowIndex, 11);
  cell.setNumberFormat('@');
  cell.setValue(JSON.stringify(obj));
  addLog_(name + 'さんが ' + when + ' の取消を依頼' + (reason ? '(' + reason + ')' : ''));
  if (!isTestStudent_(student)) notify_('【取消依頼】' + name + 'さん',
    name + 'さんから ' + when + ' の授業の取消依頼が届きました。\n' +
    (reason ? '理由: ' + reason + '\n' : '') +
    '\n管理画面で「取消を承認」または「予定どおり行う」を選んでください。\nhttps://www.stepwise-education.jp/kanri/');
  return { ok: true, state: studentState_(req.k) };
}

// 先生が取消依頼に回答(approve: true=取消する / false=予定どおり行う)
function adminResolveCancel_(req) {
  var r = findSlotRow_(req.slotId);
  if (!r || r.slot.status !== 'booked') return { error: '予定が見つかりません' };
  var student = systemStudent_(r.slot.studentId);
  var name = student ? student.name : '(不明)';
  var when = fmtDateJa_(r.slot.date) + ' ' + r.slot.start + '〜' + endTime_(r.slot.start, r.slot.min);
  if (req.approve === true || String(req.approve) === 'true') {
    deleteCalEvent_(r.slot);
    sheet_('slots').deleteRow(r.rowIndex);
    addLog_('先生が ' + name + 'さんの ' + when + ' の取消を承認');
    mailStudent_(student, when + ' の授業は取消になりました',
      name + 'さん\n\n' + when + ' の授業の取消依頼を承認しました。この授業は行いません。\n次の予定は先生から案内します。\n' + SITE_URL + '?k=' + String(student ? student.code : ''));
  } else {
    sheet_('slots').getRange(r.rowIndex, 11).setValue('');
    addLog_('先生が ' + name + 'さんの ' + when + ' を予定どおり実施に(取消依頼を取り下げ)');
    mailStudent_(student, when + ' の授業は予定どおり行います',
      name + 'さん\n\n' + when + ' の授業の取消依頼を確認しましたが、この授業は予定どおり行います。\n事情がある場合は先生にLINEで相談してください。\n' + SITE_URL + '?k=' + String(student ? student.code : ''));
  }
  return { ok: true };
}

/* ================= 希望日程(生徒→先生) ================= */

function ensureWishesSheet_() {
  var ss = ss_();
  if (!ss.getSheetByName('wishes')) {
    var sh = ss.insertSheet('wishes');
    sh.appendRow(['id', 'studentId', 'date', 'start', 'end', 'note', 'createdAt']);
  }
}

// wishes.kind 列: 'want'=この日時に授業をしたい(開始〜終了がそのまま授業時間) / 'ok'=この時間帯のどこかで調整してほしい
function ensureWishKindHeader_() {
  var sh = sheet_('wishes');
  if (sh && sh.getRange(1, 8).getValue() !== 'kind') sh.getRange(1, 8).setValue('kind');
}

// wishes を正規化して返す(date yyyy-MM-dd / start,end HH:mm / kind want|ok)
function wishRows_() {
  if (!ss_().getSheetByName('wishes')) return [];
  return readRows_('wishes').map(function (x) {
    return { id: x.id, studentId: String(x.studentId || ''), date: x.date, start: x.start,
      end: normTime_(x.end), note: String(x.note || ''), createdAt: x.createdAt ? fmtLogTime_(x.createdAt) : '',
      kind: String(x.kind || '') === 'want' ? 'want' : 'ok' };
  }).filter(function (x) { return x.id && x.date; });
}

function wish_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var kind = String(req.kind || '') === 'want' ? 'want' : 'ok';
  var date = String(req.date || ''), start = normTime_(req.start), end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayStr_()) return { error: '今日以降の日付をえらんでください' };
  if (!/^\d{2}:\d{2}$/.test(start)) return { error: '開始時刻を入れてください' };
  if (kind === 'want') {
    var mins = Number(req.min) || 0;
    if ([30, 45, 60, 90, 120].indexOf(mins) < 0) return { error: '長さをえらんでください' };
    end = endTime_(start, mins);
  } else {
    end = normTime_(req.end);
    if (!/^\d{2}:\d{2}$/.test(end) || start >= end) return { error: '時間帯は「開始 < 終了」で入れてください' };
  }
  var mine = wishRows_().filter(function (x) { return x.studentId === String(student.id) && x.date >= todayStr_(); });
  if (mine.length >= 20) return { error: '希望は20件までです。不要なものを取り消してください' };
  if (mine.some(function (x) { return x.date === date && x.start === start && x.end === end && x.kind === kind; })) return { error: '同じ希望がすでにあります' };
  var note = String(req.note || '').trim().slice(0, 100);
  var sh = sheet_('wishes');
  sh.appendRow([uid_(), String(student.id), date, start, end, note, new Date(), kind]);
  var rr = sh.getLastRow();
  sh.getRange(rr, 2).setNumberFormat('@'); sh.getRange(rr, 4, 1, 2).setNumberFormat('@');
  var when = fmtDateJa_(date) + ' ' + start + '〜' + end + (kind === 'want' ? '(この日時を希望)' : '(この時間帯のどこかで)');
  addLog_(student.name + 'さんが' + (kind === 'want' ? '希望日時' : '授業できる時間帯') + 'を登録: ' + when + (note ? '(' + note + ')' : ''));
  if (!isTestStudent_(student)) notify_('【' + (kind === 'want' ? '希望日時' : '授業できる時間帯') + '】' + student.name + 'さん',
    student.name + 'さんから' + (kind === 'want' ? '授業の希望日時' : '授業できる時間帯') + 'が届きました。\n' + when + (note ? '\nメモ: ' + note : '') +
    '\n\n管理画面の「授業」ページから、この希望で案内できます。\nhttps://www.stepwise-education.jp/kanri/#lessons');
  return { ok: true, state: studentState_(req.k) };
}

// 予定表で選んだ複数日に同じ内容の希望をまとめて登録
function wishMany_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var kind = String(req.kind || '') === 'want' ? 'want' : 'ok';
  var today = todayStr_();
  var seen = {};
  var dates = (req.dates || []).map(String).filter(function (d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today || seen[d]) return false; seen[d] = true; return true; }).sort();
  if (!dates.length) return { error: '日付をえらんでください' };
  var start = normTime_(req.start), end;
  if (!/^\d{2}:\d{2}$/.test(start)) return { error: '開始時刻を入れてください' };
  if (kind === 'want') {
    var mins = Number(req.min) || 0;
    if ([30, 45, 60, 90, 120].indexOf(mins) < 0) return { error: '長さをえらんでください' };
    end = endTime_(start, mins);
  } else {
    end = normTime_(req.end);
    if (!/^\d{2}:\d{2}$/.test(end) || start >= end) return { error: '時間帯は「開始 < 終了」で入れてください' };
  }
  var mine = wishRows_().filter(function (x) { return x.studentId === String(student.id) && x.date >= today; });
  if (mine.length + dates.length > 20) return { error: '希望は合計20件までです。不要なものを取り消してください' };
  var note = String(req.note || '').trim().slice(0, 100);
  var sh = sheet_('wishes');
  var added = [];
  dates.forEach(function (d) {
    if (mine.some(function (x) { return x.date === d && x.start === start && x.end === end && x.kind === kind; })) return;
    sh.appendRow([uid_(), String(student.id), d, start, end, note, new Date(), kind]);
    var rr = sh.getLastRow();
    sh.getRange(rr, 2).setNumberFormat('@'); sh.getRange(rr, 4, 1, 2).setNumberFormat('@');
    added.push(d);
  });
  if (!added.length) return { error: '同じ希望がすでにあります' };
  var label = (kind === 'want' ? '希望日時' : '授業できる時間帯') + ': ' + added.map(fmtDateJa_).join('、') + ' ' + start + '〜' + end + (note ? '(' + note + ')' : '');
  addLog_(student.name + 'さんが' + label + 'を登録');
  if (!isTestStudent_(student)) notify_('【' + (kind === 'want' ? '希望日時' : '授業できる時間帯') + '】' + student.name + 'さん(' + added.length + '日)',
    student.name + 'さんから' + label + (kind === 'want' ? '(この日時を希望)' : '(この時間帯のどこかで)') + '\n\n管理画面の「授業」ページから案内できます。\nhttps://www.stepwise-education.jp/kanri/#lessons');
  return { ok: true, state: studentState_(req.k) };
}

function unwish_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var rows = readRows_('wishes');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(req.wishId) && String(rows[i].studentId) === String(student.id)) {
      sheet_('wishes').deleteRow(i + 2);
      addLog_(student.name + 'さんが希望日程を取消: ' + fmtDateJa_(rows[i].date) + ' ' + rows[i].start);
      return { ok: true, state: studentState_(req.k) };
    }
  }
  return { error: 'この希望は見つかりません', refresh: true };
}

// 先生側: 希望を削除(案内した/対応済み)
function delWish_(wishId) {
  var rows = readRows_('wishes');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(wishId)) { sheet_('wishes').deleteRow(i + 2); return true; }
  }
  return false;
}

// 管理画面向け: 今日以降の希望(生徒名付き)
/* ================= 月の授業回数(計画): 生徒 × 月(または既定) × 科目 → 回数 ================= */

function ensurePlansSheet_() {
  var ss = ss_();
  if (!ss.getSheetByName('plans')) {
    var sh = ss.insertSheet('plans');
    sh.appendRow(['id', 'studentId', 'ym', 'subject', 'count']);
  }
}

// plans 列6〜10: status(draft|proposed|approved|declined) / proposedAt / approvedAt / approvedVia / memo
function ensurePlanStatusCols_() {
  var sh = sheet_('plans');
  if (sh && sh.getRange(1, 6).getValue() !== 'status') {
    sh.getRange(1, 6, 1, 5).setValues([['status', 'proposedAt', 'approvedAt', 'approvedVia', 'memo']]);
  }
}
function planYm_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM') : String(v || ''); }
function planStamp_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || ''); }

// plans を正規化して返す。ym は 'YYYY-MM' または 'default'(毎月の既定)
function planRows_() {
  if (!ss_().getSheetByName('plans')) return [];
  return readRows_('plans').map(function (x) {
    return { id: x.id, studentId: String(x.studentId || ''), ym: planYm_(x.ym), subject: String(x.subject || ''), count: Number(x.count) || 0,
      status: String(x.status || '') || 'draft', proposedAt: planStamp_(x.proposedAt), approvedAt: planStamp_(x.approvedAt), approvedVia: String(x.approvedVia || ''), memo: String(x.memo || '') };
  }).filter(function (x) { return x.id && x.subject; });
}

// その月の承認状況(月行がなければ none)。行ごとの status を月として集約: どれかが declined→declined、全部 approved→approved、どれかが proposed→proposed、それ以外→draft
function planMonthInfo_(studentId, ym, rows) {
  rows = rows || planRows_();
  var mine = rows.filter(function (x) { return x.studentId === String(studentId); });
  var month = mine.filter(function (x) { return x.ym === ym; });
  var defaults = mine.filter(function (x) { return x.ym === 'default'; });
  var src = month.length ? month : defaults;
  var status = 'none';
  if (month.length) {
    var st = month.map(function (x) { return x.status; });
    status = st.indexOf('declined') >= 0 ? 'declined' : st.every(function (v) { return v === 'approved'; }) ? 'approved' : st.indexOf('proposed') >= 0 ? 'proposed' : 'draft';
  }
  var first = month[0] || {};
  var total = 0; src.forEach(function (x) { total += x.count; });
  return { ym: ym, rows: src.map(function (x) { return { subject: x.subject, count: x.count, status: x.status }; }), fromDefault: !month.length && defaults.length > 0, total: total,
    status: status, proposedAt: first.proposedAt || '', approvedAt: first.approvedAt || '', approvedVia: first.approvedVia || '', memo: month.map(function (x) { return x.memo; }).filter(Boolean)[0] || '' };
}

function nextYm_(ym) { var p = ym.split('-'); var d = new Date(+p[0], +p[1], 1); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }

// 月の行の status をまとめて更新(既定から月行を作る場合は copyDefault)
function planSetStatus_(studentId, ym, status, via, memo, copyDefault) {
  var rows = readRows_('plans');
  var sh = sheet_('plans');
  var found = false;
  var now = new Date();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].studentId) !== String(studentId) || planYm_(rows[i].ym) !== ym) continue;
    found = true;
    var vals = [[status, status === 'proposed' ? now : (rows[i].proposedAt || ''), status === 'approved' ? now : (status === 'proposed' || status === 'draft' ? '' : rows[i].approvedAt || ''), status === 'approved' ? String(via || '') : (status === 'proposed' || status === 'draft' ? '' : rows[i].approvedVia || ''), String(memo || '')]];
    sh.getRange(i + 2, 6, 1, 5).setValues(vals);
  }
  if (!found && copyDefault) {
    var defs = rows.filter(function (x) { return String(x.studentId) === String(studentId) && planYm_(x.ym) === 'default' && Number(x.count) > 0; });
    if (!defs.length) return { error: '計画がありません。先に科目と回数を登録してください' };
    defs.forEach(function (x) {
      sh.appendRow([uid_(), String(studentId), ym, String(x.subject), Number(x.count), status, status === 'proposed' ? now : '', status === 'approved' ? now : '', status === 'approved' ? String(via || '') : '', String(memo || '')]);
      sh.getRange(sh.getLastRow(), 2, 1, 2).setNumberFormat('@');
    });
    found = true;
  }
  return found ? { ok: true } : { error: '計画がありません。先に科目と回数を登録してください' };
}

// 先生: 保護者に提案(未承認に戻す)
function planPropose_(req) {
  var id = String(req.studentId || ''), ym = String(req.ym || '');
  var st = systemStudent_(id);
  if (!st) return { error: '生徒が見つかりません' };
  if (!/^\d{4}-\d{2}$/.test(ym)) return { error: '月の形式は YYYY-MM です' };
  var res = planSetStatus_(id, ym, 'proposed', '', '', true);
  if (res.error) return res;
  addLog_('先生が ' + st.name + 'さんの ' + ym + ' の授業回数を保護者に提案');
  return { ok: true };
}

// 先生: LINE・電話などで得た承諾を記録
function planApproveTeacher_(req) {
  var id = String(req.studentId || ''), ym = String(req.ym || '');
  var st = systemStudent_(id);
  if (!st) return { error: '生徒が見つかりません' };
  if (!/^\d{4}-\d{2}$/.test(ym)) return { error: '月の形式は YYYY-MM です' };
  var via = String(req.via || '').trim().slice(0, 20) || 'LINE';
  var res = planSetStatus_(id, ym, 'approved', via, String(req.memo || '').slice(0, 100), true);
  if (res.error) return res;
  addLog_('先生が ' + st.name + 'さんの ' + ym + ' の授業回数の承諾を記録(' + via + ')');
  return { ok: true };
}

// 保護者(保護者ページ): 承認 / 見送り
function parentPlanDecide_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var t = String(student.parentToken || ''), exp = Number(student.parentExp || 0);
  if (!t || String(req.ptoken || '') !== t || Date.now() > exp) return { error: '保護者ページを開き直してください' };
  var ym = String(req.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { error: '月の形式は YYYY-MM です' };
  var approve = req.approve === true || String(req.approve) === 'true';
  var memo = String(req.memo || '').trim().slice(0, 100);
  var res = planSetStatus_(student.id, ym, approve ? 'approved' : 'declined', approve ? '保護者ページ' : '', memo, false);
  if (res.error) return res;
  var info = planMonthInfo_(student.id, ym);
  var text = info.rows.map(function (x) { return x.subject + ' ' + x.count + '回'; }).join('、');
  addLog_(student.name + 'さんの保護者が ' + ym + ' の授業回数を' + (approve ? '承認' : '見送り') + (memo ? '(' + memo + ')' : ''));
  if (!isTestStudent_(student)) notify_('【回数' + (approve ? '承認' : '見送り') + '】' + student.name + 'さん ' + ym,
    student.name + 'さんの保護者が ' + ym + ' の授業回数(' + text + ')を' + (approve ? '承認しました。' : '見送りました。') + (memo ? '\nメモ: ' + memo : '') + '\n\n管理画面: https://www.stepwise-education.jp/kanri/');
  return { ok: true, data: parentData_(req).data };
}

// その月の計画(科目→回数)。月の指定が無ければ既定を使う
function planFor_(studentId, ym, rows) {
  rows = rows || planRows_();
  var mine = rows.filter(function (x) { return x.studentId === String(studentId); });
  var month = mine.filter(function (x) { return x.ym === ym; });
  var src = month.length ? month : mine.filter(function (x) { return x.ym === 'default'; });
  var out = {};
  src.forEach(function (x) { if (x.count > 0) out[x.subject] = x.count; });
  return { plan: out, fromDefault: !month.length && src.length > 0 };
}

function planSet_(req) {
  var id = String(req.studentId || '');
  if (!systemStudent_(id)) return { error: '生徒が見つかりません' };
  var ym = String(req.ym || '');
  if (ym !== 'default' && !/^\d{4}-\d{2}$/.test(ym)) return { error: '月の形式は YYYY-MM です' };
  var subject = String(req.subject || '').trim().slice(0, 20);
  if (!subject) return { error: '科目をえらんでください' };
  var count = Math.max(0, Math.min(31, Math.floor(Number(req.count) || 0)));
  var rows = readRows_('plans');
  var sh = sheet_('plans');
  for (var i = rows.length - 1; i >= 0; i--) {
    var rowYm = rows[i].ym instanceof Date ? Utilities.formatDate(rows[i].ym, TZ, 'yyyy-MM') : String(rows[i].ym || '');
    if (String(rows[i].studentId) === id && rowYm === ym && String(rows[i].subject) === subject) {
      if (count === 0) sh.deleteRow(i + 2);
      else {
        var changed = Number(rows[i].count) !== count;
        sh.getRange(i + 2, 5).setValue(count);
        if (changed && ym !== 'default') sh.getRange(i + 2, 6, 1, 4).setValues([['draft', '', '', '']]); // 回数を変えたら承認をやり直し
      }
      return { ok: true };
    }
  }
  if (count > 0) {
    sh.appendRow([uid_(), id, ym, subject, count]);
    sh.getRange(sh.getLastRow(), 2, 1, 2).setNumberFormat('@');
  }
  return { ok: true };
}

/* ================= 保護者ページ(パスワードは当面、先生のログインパスワードと共通) ================= */

function ensureParentHeaders_() {
  var sh = sheet_('students');
  if (sh && sh.getRange(1, 8).getValue() !== 'parentToken') {
    sh.getRange(1, 8).setValue('parentToken');
    sh.getRange(1, 9).setValue('parentExp');
  }
}

// 生徒本人の成績推移(台帳の成績推移シート)。生徒も見られる
function studentGrades_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var id = String(student.id);
  var grades = ledgerRows_('成績推移').filter(function (x) { return String(x['生徒ID']) === id; })
    .map(function (x) { return { date: x['日付'], test: x['テスト名'], subject: x['科目'], score: Number(x['点数']),
      max: Number(x['満点'] || 0) || null, dev: x['偏差値'] === '' ? null : Number(x['偏差値']), rank: x['順位'] }; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { ok: true, grades: grades, exams: examsFor_(id, false) };
}

// 模試(台帳の「模試」シート)。1行=1回分。withUrl=false なら成績票のリンクは返さない(生徒向け)
var EXAM_SUBJECTS_ = ['国語', '数学', '社会', '理科', '英語'];
function numOrNull_(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(v); return isNaN(n) ? null : n; }
function examsFor_(id, withUrl) {
  return ledgerRows_('模試').filter(function (e) { return String(e['生徒ID']) === id; }).map(function (e) {
    var sub = {};
    EXAM_SUBJECTS_.forEach(function (s) { sub[s] = { score: numOrNull_(e[s]), dev: numOrNull_(e[s + '偏差値']) }; });
    return { row: e._row, date: e['日付'], name: String(e['模試名'] || ''), round: String(e['回'] || ''), grade: String(e['学年'] || ''), subjects: sub,
      total3: { score: numOrNull_(e['3教科']), dev: numOrNull_(e['3教科偏差値']) }, total5: { score: numOrNull_(e['5教科']), dev: numOrNull_(e['5教科偏差値']) },
      rank3: String(e['3教科順位'] || ''), rank5: String(e['5教科順位'] || ''), n: String(e['受験者数'] || ''),
      judge: String(e['志望校判定'] || '').split(/\s*\/\s*|\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean),
      url: withUrl ? String(e['資料URL'] || '') : '', note: String(e['備考'] || '') };
  }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function parentLogin_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  if (authMode_() !== 'account') return { error: '保護者ページは準備中です' };
  var pass = String(req.pass || '');
  if (!pass || hashPass_(pass, getConfig_('passSalt')) !== getConfig_('passHash')) {
    Utilities.sleep(800);
    return { error: 'パスワードがちがいます' };
  }
  var rows = readRows_('students');
  var token = newCode_() + newCode_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(student.id)) {
      var sh = sheet_('students');
      sh.getRange(i + 2, 8, 1, 2).setNumberFormat('@');
      sh.getRange(i + 2, 8, 1, 2).setValues([[token, String(Date.now() + 12 * 3600 * 1000)]]);
      break;
    }
  }
  addLog_(student.name + 'さんの保護者ページを表示');
  return { ok: true, ptoken: token };
}

function parentData_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var t = String(student.parentToken || ''), exp = Number(student.parentExp || 0);
  if (!t || String(req.ptoken || '') !== t || Date.now() > exp) return { error: '保護者用パスワードをもう一度入れてください' };
  var d = kanriStudent_(student.id);
  if (d.error) return d;
  var months = {}, keys = [];
  (d.lessons || []).forEach(function (l) {
    if (l.status !== 'booked' || !l.done) return;
    var m = l.date.slice(0, 7);
    if (!months[m]) { months[m] = { ym: m, count: 0, minutes: 0 }; keys.push(m); }
    months[m].count++; months[m].minutes += Number(l.min) || 0;
  });
  var prows = planRows_();
  var planMonths = [planMonthInfo_(student.id, d.month, prows), planMonthInfo_(student.id, nextYm_(d.month), prows)].filter(function (x) { return x.status !== 'none' && x.status !== 'draft'; });
  return { ok: true, data: { name: d.name, month: d.month, thisMonth: d.thisMonth, rate30: d.rate30, monthly: d.monthly,
    payments: d.payments, grades: d.grades, months: keys.sort().reverse().slice(0, 6).map(function (m) { return months[m]; }), planMonths: planMonths } };
}

/* ================= 共有予定(生徒・保護者→先生。大会・見学など) ================= */

function ensureEventsSheet_() {
  var ss = ss_();
  if (!ss.getSheetByName('events')) {
    var sh = ss.insertSheet('events');
    sh.appendRow(['id', 'studentId', 'date', 'dateTo', 'title', 'createdAt']);
  }
}

function ensureEventKindCol_() {
  var sh = sheet_('events');
  if (sh && sh.getRange(1, 7).getValue() !== 'kind') sh.getRange(1, 7).setValue('kind');
}

/* ================= 宿題・持ち物(tasks): 先生も生徒も登録、生徒がチェック ================= */
function ensureTasksSheet_() {
  var ss = ss_();
  if (!ss.getSheetByName('tasks')) {
    var sh = ss.insertSheet('tasks');
    sh.appendRow(['id', 'studentId', 'type', 'title', 'due', 'createdAt', 'createdBy', 'doneAt']);
  }
}
function taskRows_() {
  if (!ss_().getSheetByName('tasks')) return [];
  return readRows_('tasks').map(function (x) {
    return { id: x.id, studentId: String(x.studentId || ''), type: String(x.type || '宿題'), title: String(x.title || ''),
      due: normDate_(x.due) || '', createdAt: x.createdAt ? fmtLogTime_(x.createdAt) : '', createdBy: String(x.createdBy || ''),
      done: !!x.doneAt, doneAt: x.doneAt ? fmtLogTime_(x.doneAt) : '' };
  }).filter(function (x) { return x.id && x.title; });
}
function tasksFor_(studentId, sinceDays) {
  var since = addDays_(todayStr_(), -(sinceDays || 45));
  return taskRows_().filter(function (t) { return t.studentId === String(studentId) && (!t.done || (t.due || todayStr_()) >= since); })
    .sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; });
}
function taskAddCore_(studentId, type, title, due, by) {
  type = ['宿題', '持ち物', 'メモ'].indexOf(type) >= 0 ? type : '宿題';
  title = String(title || '').trim().slice(0, 80);
  if (!title) return { error: '内容を入れてください' };
  due = /^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? String(due) : '';
  var sh = sheet_('tasks');
  sh.appendRow([uid_(), String(studentId), type, title, due, new Date(), by, '']);
  sh.getRange(sh.getLastRow(), 2).setNumberFormat('@');
  return { ok: true };
}
function taskAdd_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var res = taskAddCore_(student.id, req.type, req.title, req.due, 'student');
  if (res.error) return res;
  return { ok: true, state: studentState_(req.k) };
}
function taskDone_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var rows = readRows_('tasks');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.taskId) && String(rows[i].studentId) === String(student.id)) {
      sheet_('tasks').getRange(i + 2, 8).setValue(req.done === true || String(req.done) === 'true' ? new Date() : '');
      return { ok: true, state: studentState_(req.k) };
    }
  }
  return { error: '見つかりません', refresh: true };
}
function taskDel_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var rows = readRows_('tasks');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(req.taskId) && String(rows[i].studentId) === String(student.id)) {
      if (String(rows[i].createdBy) !== 'student') return { error: '先生が出した宿題・持ち物は消せません。済んだらチェックしてください' };
      sheet_('tasks').deleteRow(i + 2);
      return { ok: true, state: studentState_(req.k) };
    }
  }
  return { error: '見つかりません', refresh: true };
}
// 先生(管理画面)
function adminTaskAdd_(req) {
  var id = String(req.studentId || '');
  var st = systemStudent_(id);
  if (!st) return { error: '生徒が見つかりません' };
  var res = taskAddCore_(id, req.type, req.title, req.due, 'teacher');
  if (res.error) return res;
  addLog_('先生が ' + st.name + 'さんに' + (req.type || '宿題') + 'を登録: ' + String(req.title || '').slice(0, 30));
  return { ok: true };
}
function adminTaskDel_(req) {
  var rows = readRows_('tasks');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(req.taskId)) { sheet_('tasks').deleteRow(i + 2); return { ok: true }; }
  }
  return { error: '見つかりません' };
}
function adminTaskDone_(req) {
  var rows = readRows_('tasks');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.taskId)) { sheet_('tasks').getRange(i + 2, 8).setValue(req.done === true || String(req.done) === 'true' ? new Date() : ''); return { ok: true }; }
  }
  return { error: '見つかりません' };
}

function eventRows_() {
  if (!ss_().getSheetByName('events')) return [];
  return readRows_('events').map(function (x) {
    return { id: x.id, studentId: String(x.studentId || ''), date: x.date, dateTo: normDate_(x.dateTo) || x.date,
      title: String(x.title || ''), createdAt: x.createdAt ? fmtLogTime_(x.createdAt) : '', kind: String(x.kind || '') === 'test' ? 'test' : 'event' };
  }).filter(function (x) { return x.id && x.date; });
}

function eventAdd_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var date = String(req.date || ''), dateTo = String(req.dateTo || '') || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return { error: '日付をえらんでください' };
  if (dateTo < date) { var tmp = date; date = dateTo; dateTo = tmp; }
  if (dateTo > addDays_(date, 60)) return { error: '期間は60日以内にしてください' };
  var title = String(req.title || '').trim().slice(0, 40);
  if (!title) return { error: '予定の内容を入れてください(例: 大会、高校見学)' };
  var mine = eventRows_().filter(function (x) { return x.studentId === String(student.id) && x.dateTo >= todayStr_(); });
  if (mine.length >= 30) return { error: '予定は30件までです。古いものを取り消してください' };
  var sh = sheet_('events');
  var kind = String(req.kind || '') === 'test' ? 'test' : 'event';
  sh.appendRow([uid_(), String(student.id), date, dateTo, title, new Date(), kind]);
  sh.getRange(sh.getLastRow(), 2).setNumberFormat('@');
  var blocked = 0;
  if (req.alsoBlock === true || String(req.alsoBlock) === 'true') blocked = addBlockRange_(student.id, date, dateTo, title);
  var when = rangeText_(date, dateTo);
  addLog_(student.name + 'さんが予定を共有: ' + when + ' ' + title + (blocked ? '(授業できない日にも登録)' : ''));
  if (!isTestStudent_(student)) notify_('【共有予定】' + student.name + 'さん',
    student.name + 'さんから予定の共有がありました。\n' + when + ' ' + title + (blocked ? '\n(この期間は授業できない日としても登録されました)' : '') +
    '\n\n管理画面: https://www.stepwise-education.jp/kanri/');
  return { ok: true, state: studentState_(req.k) };
}

// 予定表で選んだ日(連続する日は1つの期間)をまとめて共有
function eventAddMany_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var title = String(req.title || '').trim().slice(0, 40);
  if (!title) return { error: '予定の内容を入れてください(例: 大会、高校見学)' };
  var today = todayStr_();
  var ranges = (req.ranges || []).filter(function (x) {
    return x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && /^\d{4}-\d{2}-\d{2}$/.test(String(x.dateTo)) && String(x.dateTo) >= String(x.date) && String(x.dateTo) >= today;
  }).slice(0, 20);
  if (!ranges.length) return { error: '日付をえらんでください' };
  var mine = eventRows_().filter(function (x) { return x.studentId === String(student.id) && x.dateTo >= today; });
  if (mine.length + ranges.length > 30) return { error: '予定は30件までです。古いものを取り消してください' };
  var also = req.alsoBlock === true || String(req.alsoBlock) === 'true';
  var sh = sheet_('events');
  var texts = [], blocked = 0;
  ranges.forEach(function (x) {
    var d = String(x.date), d2 = String(x.dateTo);
    sh.appendRow([uid_(), String(student.id), d, d2, title, new Date(), String(req.kind || '') === 'test' ? 'test' : 'event']);
    sh.getRange(sh.getLastRow(), 2).setNumberFormat('@');
    if (also) blocked += addBlockRange_(student.id, d, d2, title);
    texts.push(rangeText_(d, d2));
  });
  addLog_(student.name + 'さんが予定を共有: ' + texts.join('、') + ' ' + title + (blocked ? '(授業できない日にも登録)' : ''));
  if (!isTestStudent_(student)) notify_('【共有予定】' + student.name + 'さん',
    student.name + 'さんから予定の共有がありました。\n' + texts.join('、') + ' ' + title + (blocked ? '\n(この期間は授業できない日としても登録されました)' : '') +
    '\n\n管理画面: https://www.stepwise-education.jp/kanri/');
  return { ok: true, state: studentState_(req.k) };
}

function eventDel_(req) {
  var student = findStudentByCode_(req.k);
  if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
  var rows = readRows_('events');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(req.eventId) && String(rows[i].studentId) === String(student.id)) {
      sheet_('events').deleteRow(i + 2);
      addLog_(student.name + 'さんが共有予定を取消: ' + fmtDateJa_(rows[i].date) + ' ' + rows[i].title);
      return { ok: true, state: studentState_(req.k) };
    }
  }
  return { error: 'この予定は見つかりません', refresh: true };
}

function delEvent_(eventId) {
  var rows = readRows_('events');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].id) === String(eventId)) { sheet_('events').deleteRow(i + 2); return true; }
  }
  return false;
}

// 管理画面向け: 今日以降(終了日ベース)の共有予定
function eventsForAdmin_(sinceDays) {
  var since = addDays_(todayStr_(), -(sinceDays || 0));
  var names = {};
  readRows_('students').forEach(function (s) { names[String(s.id)] = s.name; });
  return eventRows_().filter(function (x) { return x.dateTo >= since; })
    .map(function (x) { x.studentName = names[x.studentId] || '(不明)'; return x; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function wishesForAdmin_() {
  var today = todayStr_();
  var names = {};
  readRows_('students').forEach(function (s) { names[String(s.id)] = s.name; });
  return wishRows_().filter(function (x) { return x.date >= today; })
    .map(function (x) { x.studentName = names[x.studentId] || '(不明)'; return x; })
    .sort(function (a, b) { return a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1); });
}

/* ================= 先生向け(PIN必須) ================= */

// 全角数字→半角(日本語入力で「００００」と入る対策)
function halfDigits_(s) {
  return String(s == null ? '' : s).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).trim();
}

function pinOk_(input) {
  var stored = String(getConfig_('pin'));
  input = halfDigits_(input);
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

/* ----- パスワードの設定・再設定(所有者のメールに6桁コードを送る。PIN不要) -----
   初回設定も再設定も同じ流れ: resetRequest でコード送信 → resetConfirm でコード+新パスワード。
   送り先はこのスクリプトの所有者(先生)のGoogleアカウントのメールなので、設定が消えていても必ず先生に届く */
function ownerEmail_() { return String(Session.getEffectiveUser().getEmail() || ''); }
function maskEmail_(e) {
  var p = String(e || '').split('@');
  if (p.length < 2) return '';
  return p[0].slice(0, 2) + '***@' + p[1];
}

function adminResetRequest_(req) {
  var last = Number(getConfig_('resetLast') || 0);
  if (Date.now() - last < 60000) return { error: 'コードは1分に1回まで送れます。届いたメールを確認してください' };
  var to = ownerEmail_();
  if (!to) return { error: '送信先のメールアドレスが取得できませんでした' };
  var code = String(Math.floor(100000 + Math.random() * 900000));
  var salt = newCode_();
  setConfig_('resetLast', String(Date.now()));
  setConfig_('resetSalt', salt);
  setConfig_('resetCode', hashPass_(code, salt));
  setConfig_('resetExp', String(Date.now() + 15 * 60000));
  setConfig_('resetFails', '0');
  try {
    MailApp.sendEmail(to, '[ステップワイズ] 管理画面のパスワード設定コード',
      '管理画面(https://www.stepwise-education.jp/kanri/)のパスワード設定コードです。\n\n' +
      '設定コード: ' + code + '\n\n15分間有効です。心当たりがない場合はこのメールを無視してください(パスワードは変わりません)。');
  } catch (err) {
    addLog_('設定コードのメール送信に失敗: ' + err);
    return { error: 'メールを送れませんでした。しばらくしてからお試しください' };
  }
  addLog_('パスワード設定コードを送信');
  return { ok: true, sent: true, to: maskEmail_(to) };
}

function adminResetConfirm_(req) {
  var exp = Number(getConfig_('resetExp') || 0);
  var stored = getConfig_('resetCode');
  if (!stored || Date.now() > exp) return { error: 'コードが無効か期限切れです。もう一度コードを送ってください' };
  var fails = Number(getConfig_('resetFails') || 0);
  if (fails >= 5) { setConfig_('resetCode', ''); return { error: '入力回数が多すぎます。もう一度コードを送ってください' }; }
  var code = halfDigits_(req.code);
  if (!code || hashPass_(code, getConfig_('resetSalt') || '') !== stored) {
    setConfig_('resetFails', String(fails + 1));
    return { error: 'コードがちがいます' };
  }
  var pass = String(req.newPass || '');
  if (pass.length < 8) return { error: '新しいパスワードは8文字以上にしてください' };
  var email = getConfig_('teacherEmail') || ownerEmail_();
  var newSalt = newCode_() + newCode_();
  setConfig_('teacherEmail', email);
  setConfig_('passSalt', newSalt);
  setConfig_('passHash', hashPass_(pass, newSalt));
  setConfig_('resetCode', ''); setConfig_('resetExp', '0'); setConfig_('resetFails', '0');
  setConfig_('failCount', '0'); setConfig_('lockUntil', '0');
  var token = issueToken_();
  addLog_('パスワードを設定しました(メールコード)');
  return { ok: true, token: token, email: email };
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

var LITE_ = false; // true のとき adminState_ を省略(管理画面からの呼び出し)

// 管理画面(from:'kanri')からの書き込みは、更新後のカルテ(またはホーム)をそのまま返す
function kanriWrap_(req, res, studentId) {
  if (!res || res.error || req.from !== 'kanri') return res;
  if (req.view === 'lessons') return res; // 授業ページは admin 全データをそのまま使う
  if (req.view === 'home') return { ok: true, id: String(studentId || ''), dash: kanriDashboard_() };
  var d = kanriStudent_(String(studentId || req.studentId || ''));
  if (d.error) return d;
  return { ok: true, id: String(studentId || req.studentId || ''), data: d };
}

function admin_(req) {
  LITE_ = req.from === 'kanri' && req.view !== 'lessons'; // 授業ページは予約ページ用の全データ(admin)をそのまま使う
  if (req.op === 'login') return adminLogin_(req);
  if (req.op === 'setupAccount') return adminSetupAccount_(req);
  if (req.op === 'resetRequest') return adminResetRequest_(req);
  if (req.op === 'resetConfirm') return adminResetConfirm_(req);
  if (!authOk_(req)) return { error: 'ログインし直してください', badAuth: true };
  switch (req.op) {
    case 'state':       return { ok: true, admin: adminState_() };
    case 'offer': {
      var ro = adminOffer_(req);
      if (ro && ro.ok && req.wishId) { delWish_(req.wishId); if (ro.admin) ro.admin.wishes = wishesForAdmin_(); }
      return kanriWrap_(req, ro, req.studentId);
    }
    case 'deleteSlot':  return kanriWrap_(req, adminDeleteSlot_(req), req.studentId);
    case 'unbook':      return kanriWrap_(req, adminUnbook_(req), req.studentId);
    case 'toggleDone':  return kanriWrap_(req, adminToggleDone_(req), req.studentId);
    case 'delWish':     return kanriWrap_(req, { ok: delWish_(req.wishId) }, req.studentId);
    case 'delEvent':    return kanriWrap_(req, { ok: delEvent_(req.eventId) }, req.studentId);
    case 'planSet':     return kanriWrap_(req, planSet_(req), req.studentId);
    case 'taskAdd':     return kanriWrap_(req, adminTaskAdd_(req), req.studentId);
    case 'taskDel':     return kanriWrap_(req, adminTaskDel_(req), req.studentId);
    case 'taskDone':    return kanriWrap_(req, adminTaskDone_(req), req.studentId);
    case 'planPropose': return kanriWrap_(req, planPropose_(req), req.studentId);
    case 'planApproveTeacher': return kanriWrap_(req, planApproveTeacher_(req), req.studentId);
    case 'addStudent':  { var ra = adminAddStudent_(req); return kanriWrap_(req, ra, ra.id); }
    case 'setEmail':    return kanriWrap_(req, adminSetEmail_(req));
    case 'setFee':      return kanriWrap_(req, adminSetFee_(req));
    case 'newCode':     return kanriWrap_(req, adminNewCode_(req));
    case 'addBlock':    return adminAddBlock_(req);
    case 'delBlock':    return adminDelBlock_(req);
    case 'hideStudent': return adminHideStudent_(req);
    case 'changePass':  return adminChangePass_(req);
    case 'resolveCancel':    return kanriWrap_(req, adminResolveCancel_(req), req.studentId);
    case 'kanriDashboard':   return { ok: true, data: kanriDashboard_() };
    case 'kanriStudent':     return kanriStudentOp_(req);
    case 'kanriSaveProfile': return kanriSaveProfile_(req);
    case 'kanriAddGrade':    return kanriAddGrade_(req);
    case 'kanriAddExam':     return kanriAddExam_(req);
    case 'kanriAddPayment':  return kanriAddPayment_(req);
    case 'kanriSetPaid':     return kanriSetPaid_(req);
    case 'kanriAddMeeting':  return kanriAddMeeting_(req);
    case 'kanriDeleteRow':   return kanriDeleteRow_(req);
    case 'kanriSetActive':   return kanriWrap_(req, kanriSetActive_(req));
    case 'logout':
      setConfig_('adminToken', '');
      return { ok: true };
    default: return { error: 'unknown op' };
  }
}

function adminState_() {
  memoClear_();
  if (LITE_) return null; // 管理画面からの呼び出しでは予約ページ用の全データは作らない
  backfillCodes_();
  var slots = readRows_('slots').map(function (s) {
    return {
      id: s.id, date: s.date, start: s.start, min: Number(s.min),
      status: s.status, studentId: String(s.studentId || ''),
      studentName: s.studentId ? studentName_(s.studentId) : '',
      done: String(s.done) === 'true' || s.done === true,
      subject: String(s.subject || ''),
      meetUrl: String(s.meetUrl || ''),
      req: parseReq_(s.req)
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
  var blocked = readRows_('blocked')
    .filter(function (b) { return b.date >= todayStr_(); })
    .map(function (b) {
      return {
        id: b.id, date: b.date, note: String(b.note || ''),
        studentId: String(b.studentId), studentName: studentName_(b.studentId)
      };
    });
  return {
    slots: slots, students: students, log: log, blocked: blocked, wishes: wishesForAdmin_(), events: eventsForAdmin_(0), plans: planRows_(), today: todayStr_(),
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
  var repeat = Math.max(1, Math.min(12, Number(req.repeat) || 1));
  // 生徒が「授業できない日」に登録している日への案内は警告(force指定で強行可)
  if (!req.force) {
    var blockedRows = readRows_('blocked');
    var ngDates = [];
    for (var w0 = 0; w0 < repeat; w0++) {
      var d0 = addDays_(req.date, w0 * 7);
      var hit = null;
      blockedRows.forEach(function (b) {
        if (String(b.studentId) === String(student.id) && b.date === d0) hit = b;
      });
      if (hit) ngDates.push(fmtDateJa_(d0) + (hit.note ? '(' + hit.note + ')' : ''));
    }
    if (ngDates.length > 0) {
      return {
        error: student.name + 'さんは ' + ngDates.join('、') + ' を「授業できない日」に登録しています',
        needForce: true
      };
    }
  }
  var subject = String(req.subject || '').slice(0, 20);
  var sh = sheet_('slots');
  var existing = readRows_('slots');
  var added = 0;
  var dates = [];
  for (var w = 0; w < repeat; w++) {
    var d = addDays_(req.date, w * 7);
    var dup = existing.some(function (s) { return s.date === d && s.start === req.start; });
    if (dup) continue;
    sh.appendRow([uid_(), d, req.start, Number(req.min) || 60, 'offered', student.id, '', '', '', subject]);
    dates.push(fmtDateJa_(d));
    added++;
  }
  if (added > 0) {
    addLog_('先生が' + student.name + 'さんに' + added + '件案内(' + fmtDateJa_(req.date) + ' ' + req.start + (repeat > 1 ? ' から毎週' : '') + (subject ? '・' + subject : '') + ')');
    offerMailToStudent_(student, dates, req.start, Number(req.min) || 60, subject);
  }
  return { ok: true, added: added, admin: adminState_() };
}

// メール登録済みの生徒には案内の連絡を送る(専用リンク付き)
function offerMailToStudent_(student, dates, start, min, subject) {
  if (isTestStudent_(student)) return;
  var email = normEmail_(student.email);
  if (!email) return;
  try {
    var link = SITE_URL + '?k=' + String(student.code || '');
    MailApp.sendEmail(email,
      '[ステップワイズ] 授業のご案内が届いています',
      student.name + 'さん\n\n先生から授業のご案内が届いています。' + (subject ? '(' + subject + ')' : '') + '\n\n' +
      dates.map(function (d) { return '・' + d + ' ' + start + '〜' + endTime_(start, min); }).join('\n') +
      '\n\n下のあなた専用リンクをひらいて、承認するか、「この日時は難しい」かを選んでください。\n' + link);
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
  var id = uid_();
  sheet_('students').appendRow([id, name, true, normEmail_(req.email), newCode_(), 1500, '']);
  return { ok: true, id: id, admin: adminState_() };
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

function adminAddBlock_(req) {
  var name = studentName_(req.studentId);
  if (name === '(不明)') return { error: '生徒をえらんでください' };
  var r = normRange_(req);
  if (!r) return { error: '日付をえらんでください' };
  var note = String(req.note || '').slice(0, 50);
  var added = addBlockRange_(req.studentId, r.date, r.dateTo, note);
  if (added === 0) return { error: 'この期間はすでに登録されています' };
  addLog_('先生が' + name + 'さんの ' + rangeText_(r.date, r.dateTo) + ' を授業できない日に登録' + (note ? '(' + note + ')' : ''));
  return { ok: true, admin: adminState_() };
}

function adminDelBlock_(req) {
  var ids = (req.blockIds || (req.blockId ? [req.blockId] : [])).map(String);
  var rows = readRows_('blocked');
  var toDel = [];
  rows.forEach(function (b, i) {
    if (ids.indexOf(String(b.id)) >= 0) toDel.push(i + 2);
  });
  if (toDel.length === 0) return { error: '登録が見つかりません' };
  toDel.sort(function (a, b) { return b - a; }).forEach(function (ri) {
    sheet_('blocked').deleteRow(ri);
  });
  return { ok: true, admin: adminState_() };
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

// 名前が【テスト】で始まる生徒はテスト用: カレンダー・Meet・メールの実動作を行わない
function isTestStudent_(student) {
  return String((student && student.name) || '').indexOf('【テスト】') === 0;
}

function createCalEvent_(slot, student) {
  if (isTestStudent_(student)) return { eventId: '', meetUrl: '' };
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
      .createEvent(CAL_TITLE_PREFIX + student.name + 'さん ' + (slot.subject || '授業'), start, end, opts);
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

function ensureSubjectHeader_() {
  var sh = sheet_('slots');
  if (sh && sh.getRange(1, 10).getValue() !== 'subject') {
    sh.getRange(1, 10).setValue('subject');
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

/* ===== 1リクエスト内のメモ化(高速化) =====
   同じシートを何度も読まない。書き込みは sheet_()/ledgerSheet_() 経由なので、そこでキャッシュを捨てる。
   最終的な読み返し(adminState_/kanriDashboard_/kanriStudent_)の先頭でも全部捨てるので、書き込み後は必ず最新が返る */
var MEMO_ = { ss: null, rows: {}, ledger: null, lrows: {} };
function memoClear_() { MEMO_.rows = {}; MEMO_.lrows = {}; }
function ss_() { if (!MEMO_.ss) MEMO_.ss = SpreadsheetApp.getActive(); return MEMO_.ss; }

// 書き込み用にシートを取る(そのシートのキャッシュは捨てる)
function sheet_(name) {
  delete MEMO_.rows[name];
  return ss_().getSheetByName(name);
}

function sheetValues_(name) {
  if (!MEMO_.rows[name]) {
    var sh = ss_().getSheetByName(name);
    MEMO_.rows[name] = sh ? sh.getDataRange().getValues() : [[]];
  }
  return MEMO_.rows[name];
}

// スキーマ確認(列見出しの追加など)は重いので1日1回だけ
function ensureSchema_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('schemaOk9')) return;
  ensureTasksSheet_();
  ensureEventKindCol_();
  ensurePlansSheet_();
  ensurePlanStatusCols_();
  ensureParentHeaders_();
  ensureEventsSheet_();
  ensureReqHeader_();
  ensureWishesSheet_();
  ensureWishKindHeader_();
  ensureEmailHeader_();
  ensureMeetHeader_();
  ensureCodeHeader_();
  ensureFeeHeaders_();
  ensureBlockedSheet_();
  ensureSubjectHeader_();
  cache.put('schemaOk9', '1', 21600);
}

function readRows_(name) {
  var values = sheetValues_(name);
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
  sheet_('slots').getRange(r.rowIndex, 1, 1, 10)
    .setValues([[s.id, s.date, s.start, s.min, s.status, s.studentId, s.done, s.eventId, s.meetUrl || '', s.subject || '']]);
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

/* ================= 管理画面(塾管理台帳) ================= */

var LEDGER_ID = '1dH5_iT5xHY07OZNYO91XcZJEYd0cGWduW87U6c-zo-U';
var LEDGER_COLS = {
  '生徒台帳': ['生徒ID', '氏名', 'ふりがな', '学年', '学校', '保護者名', '保護者連絡先', 'メール', '入塾日', '状態', '科目', '単価(30分)', '月謝', '備考'],
  '成績推移': ['日付', '生徒ID', '氏名', 'テスト名', '科目', '点数', '満点', '偏差値', '順位', '備考'],
  '模試': ['日付', '生徒ID', '氏名', '模試名', '回', '学年', '国語', '国語偏差値', '数学', '数学偏差値', '社会', '社会偏差値', '理科', '理科偏差値', '英語', '英語偏差値',
           '3教科', '3教科偏差値', '5教科', '5教科偏差値', '3教科順位', '5教科順位', '受験者数', '志望校判定', '資料URL', '備考'],
  '入金管理': ['年月', '生徒ID', '氏名', '請求額', '請求日', '入金日', '入金方法', '状態', '備考'],
  '面談記録': ['日付', '生徒ID', '氏名', '相手', '方法', '内容', '次のアクション']
};

function ledger_() { if (!MEMO_.ledger) MEMO_.ledger = SpreadsheetApp.openById(LEDGER_ID); return MEMO_.ledger; }

function ledgerSheet_(name) {
  delete MEMO_.lrows[name]; // 書き込み前提なのでキャッシュを捨てる
  var ss = ledger_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(LEDGER_COLS[name]); }
  return sh;
}

// 台帳シートを {列名: 値} の配列で読む(_row にシート上の行番号)。日付セルは yyyy-MM-dd に正規化
function ledgerRows_(name) {
  if (!MEMO_.lrows[name]) {
    var sh = ledger_().getSheetByName(name);
    MEMO_.lrows[name] = sh ? sh.getDataRange().getValues() : [];
  }
  var v = MEMO_.lrows[name];
  if (v.length < 2) return [];
  var h = v[0];
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    var empty = true;
    for (var j = 0; j < h.length; j++) {
      var val = v[i][j];
      if (val instanceof Date) val = Utilities.formatDate(val, TZ, 'yyyy-MM-dd');
      if (val !== '' && val !== null) empty = false;
      o[String(h[j])] = val;
    }
    if (!empty) out.push(o);
  }
  return out;
}

function ledgerAppend_(name, obj) {
  var sh = ledgerSheet_(name);
  var cols = LEDGER_COLS[name];
  var row = cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.appendRow(row);
  var r = sh.getLastRow();
  // 数字だけの値(生徒ID・年月・電話番号)が数値化されないよう文字列書式にする
  cols.forEach(function (c, idx) {
    if (c === '生徒ID' || c === '年月' || c === '保護者連絡先') sh.getRange(r, idx + 1).setNumberFormat('@');
  });
  return r;
}

function systemStudent_(studentId) {
  var rows = readRows_('students');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(studentId)) return rows[i];
  }
  return null;
}

function studentFee_(studentId, minutes) {
  var st = systemStudent_(studentId);
  var monthly = st ? Number(st.monthly || 0) : 0;
  var rate30 = st ? Number(st.rate30 || 0) : 0;
  if (monthly > 0) return { amount: monthly, mode: 'monthly' };
  return { amount: Math.round(minutes / 30 * rate30), mode: 'time', rate30: rate30 };
}

function slotSort_(a, b) {
  return a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1);
}

function kanriDashboard_() {
  memoClear_();
  var today = todayStr_();
  var weekEnd = addDays_(today, 7);
  var month = today.slice(0, 7);
  var slots = readRows_('slots');
  var allStudents = readRows_('students');
  var isActive = function (s) { return !(String(s.active) === 'false' || s.active === false); };
  var students = allStudents.filter(isActive);
  var inactive = allStudents.filter(function (s) { return !isActive(s); })
    .map(function (s) { return { id: String(s.id), name: s.name }; });
  var nameOf = {};
  students.forEach(function (s) { nameOf[String(s.id)] = s.name; });
  var slim = function (s) {
    return { id: s.id, date: s.date, start: s.start, min: Number(s.min), status: s.status,
      done: String(s.done) === 'true' || s.done === true, subject: String(s.subject || ''),
      studentId: String(s.studentId || ''), studentName: nameOf[String(s.studentId)] || studentName_(s.studentId),
      meetUrl: String(s.meetUrl || ''), req: parseReq_(s.req) };
  };
  var cancelReqs = slots.filter(function (s) { return s.status === 'booked' && s.date >= today && parseReq_(s.req); }).map(slim).sort(slotSort_);
  var lessonsToday = slots.filter(function (s) { return s.date === today && s.status === 'booked'; }).map(slim).sort(slotSort_);
  var lessonsWeek = slots.filter(function (s) { return s.date > today && s.date < weekEnd && s.status === 'booked'; }).map(slim).sort(slotSort_);
  var pending = slots.filter(function (s) { return s.date >= today && s.status === 'offered'; }).map(slim).sort(slotSort_);
  // ホームの全体予定表用: 今後70日の確定・承認待ちと、生徒の授業できない日
  var horizon = addDays_(today, 70);
  var upcomingAll = slots.filter(function (s) { return s.date >= today && s.date < horizon && (s.status === 'booked' || s.status === 'offered'); }).map(slim).sort(slotSort_);
  var blockedUp = readRows_('blocked').filter(function (b) { return b.date >= today && b.date < horizon; })
    .map(function (b) { return { id: b.id, date: b.date, studentId: String(b.studentId || ''), studentName: nameOf[String(b.studentId)] || studentName_(b.studentId), note: String(b.note || '') }; });
  var payments = ledgerRows_('入金管理');
  var unpaid = payments.filter(function (p) { return String(p['状態'] || '') !== '入金済' && Number(p['請求額'] || 0) > 0; })
    .map(function (p) { return { row: p._row, ym: String(p['年月']), studentId: String(p['生徒ID']), name: p['氏名'], amount: Number(p['請求額']), billDate: p['請求日'] || '' }; });
  var meetings = ledgerRows_('面談記録').sort(function (a, b) { return a['日付'] < b['日付'] ? 1 : -1; }).slice(0, 5)
    .map(function (m) { return { date: m['日付'], studentId: String(m['生徒ID']), name: m['氏名'], who: m['相手'], method: m['方法'], content: m['内容'], next: m['次のアクション'] }; });
  var profiles = {};
  ledgerRows_('生徒台帳').forEach(function (p) { profiles[String(p['生徒ID'])] = p; });
  var planRowsAll = planRows_();
  var stuCards = students.map(function (s) {
    var id = String(s.id);
    var mine = slots.filter(function (x) { return String(x.studentId) === id; });
    var doneMonth = mine.filter(function (x) { return x.status === 'booked' && x.date.slice(0, 7) === month && (String(x.done) === 'true' || x.done === true); });
    var minutes = 0; doneMonth.forEach(function (x) { minutes += Number(x.min) || 0; });
    var next = mine.filter(function (x) { return x.status === 'booked' && x.date >= today; }).sort(slotSort_)[0];
    var pr = profiles[id] || {};
    return { id: id, name: s.name, grade: pr['学年'] || '', school: pr['学校'] || '', status: pr['状態'] || '在籍',
      doneThisMonth: doneMonth.length, minutesThisMonth: minutes, feeThisMonth: studentFee_(id, minutes).amount,
      bookedThisMonth: mine.filter(function (x) { return x.status === 'booked' && x.date.slice(0, 7) === month; }).length,
      plannedThisMonth: (function () { var p = planFor_(id, month, planRowsAll).plan, n = 0; Object.keys(p).forEach(function (k) { n += p[k]; }); return n; })(),
      planStatus: planMonthInfo_(id, month, planRowsAll).status,
      next: next ? { date: next.date, start: next.start } : null,
      unpaid: unpaid.filter(function (u) { return u.studentId === id; }).length };
  });
  return { today: today, month: month, lessonsToday: lessonsToday, lessonsWeek: lessonsWeek, pending: pending,
    unpaid: unpaid, meetings: meetings, students: stuCards, inactive: inactive, cancelReqs: cancelReqs, wishes: wishesForAdmin_(),
    events: eventsForAdmin_(0).filter(function (x) { return x.date < addDays_(today, 21); }),
    slots: upcomingAll, blocked: blockedUp, allEvents: eventsForAdmin_(0) };
}

// 予約ページに表示する/しない(studentsシート active 列)。データは消さない
function kanriSetActive_(req) {
  var rows = readRows_('students');
  var on = req.active === true || String(req.active) === 'true';
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(req.studentId)) {
      if (on) {
        var dup = rows.some(function (s, j) {
          return j !== i && s.name === rows[i].name && !(String(s.active) === 'false' || s.active === false);
        });
        if (dup) return { error: '同じ名前の生徒がすでに在籍中です' };
      }
      sheet_('students').getRange(i + 2, 3).setValue(on);
      return { ok: true };
    }
  }
  return { error: '生徒が見つかりません' };
}

function kanriStudentOp_(req) {
  if (req.view === 'home') return { ok: true, dash: kanriDashboard_() };
  var d = kanriStudent_(req.studentId);
  if (d.error) return d;
  return { ok: true, data: d };
}

function kanriStudent_(studentId) {
  memoClear_();
  var id = String(studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  var today = todayStr_();
  var month = today.slice(0, 7);
  var profile = null;
  ledgerRows_('生徒台帳').forEach(function (p) { if (String(p['生徒ID']) === id) profile = p; });
  if (profile) delete profile._row;
  var lessons = readRows_('slots').filter(function (s) { return String(s.studentId) === id; })
    .map(function (s) { return { id: s.id, date: s.date, start: s.start, min: Number(s.min), status: s.status,
      done: String(s.done) === 'true' || s.done === true, subject: String(s.subject || ''), meetUrl: String(s.meetUrl || ''), req: parseReq_(s.req) }; })
    .sort(function (a, b) { return -slotSort_(a, b); });
  var doneMonth = lessons.filter(function (x) { return x.status === 'booked' && x.done && x.date.slice(0, 7) === month; });
  var minutes = 0; doneMonth.forEach(function (x) { minutes += x.min; });
  var grades = ledgerRows_('成績推移').filter(function (g) { return String(g['生徒ID']) === id; })
    .map(function (g) { return { row: g._row, date: g['日付'], test: g['テスト名'], subject: g['科目'], score: Number(g['点数']),
      max: Number(g['満点'] || 0) || null, dev: g['偏差値'] === '' ? null : Number(g['偏差値']), rank: g['順位'], note: g['備考'] }; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  var payments = ledgerRows_('入金管理').filter(function (p) { return String(p['生徒ID']) === id; })
    .map(function (p) { return { row: p._row, ym: String(p['年月']), amount: Number(p['請求額'] || 0), billDate: p['請求日'] || '',
      paidDate: p['入金日'] || '', method: p['入金方法'] || '', status: p['状態'] || '', note: p['備考'] || '' }; })
    .sort(function (a, b) { return a.ym < b.ym ? 1 : -1; });
  var meetings = ledgerRows_('面談記録').filter(function (m) { return String(m['生徒ID']) === id; })
    .map(function (m) { return { row: m._row, date: m['日付'], who: m['相手'], method: m['方法'], content: m['内容'], next: m['次のアクション'] }; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  var fee = studentFee_(id, minutes);
  return {
    id: id, name: sys.name, email: String(sys.email || ''), rate30: Number(sys.rate30 || 0), monthly: Number(sys.monthly || 0),
    code: String(sys.code || ''), active: !(String(sys.active) === 'false' || sys.active === false), profile: profile, lessons: lessons.slice(0, 60), grades: grades, exams: examsFor_(id, true), payments: payments, meetings: meetings,
    today: today, wishes: wishesForAdmin_().filter(function (x) { return x.studentId === id; }),
    blocked: readRows_('blocked').filter(function (b) { return String(b.studentId) === id && b.date >= today; }).map(function (b) { return { id: b.id, date: b.date, note: String(b.note || '') }; }),
    plan: (function () { var rows = planRows_(); var pf = planFor_(id, month, rows); return { month: month, current: pf.plan, fromDefault: pf.fromDefault,
      monthRows: rows.filter(function (x) { return x.studentId === id && x.ym === month; }), defaultRows: rows.filter(function (x) { return x.studentId === id && x.ym === 'default'; }),
      months: [planMonthInfo_(id, month, rows), planMonthInfo_(id, nextYm_(month), rows)] }; })(),
    events: eventsForAdmin_(60).filter(function (x) { return x.studentId === id; }),
    tasks: tasksFor_(id, 60),
    month: month, thisMonth: { count: doneMonth.length, minutes: minutes, fee: fee.amount, mode: fee.mode,
      billed: payments.some(function (p) { return p.ym === month; }) }
  };
}

function kanriSaveProfile_(req) {
  var id = String(req.studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  var pr = req.profile || {};
  var cols = LEDGER_COLS['生徒台帳'];
  var target = null;
  ledgerRows_('生徒台帳').forEach(function (r) { if (String(r['生徒ID']) === id) target = r; });
  var sh = ledgerSheet_('生徒台帳');
  var obj = {};
  cols.forEach(function (c) { obj[c] = (target && target[c] !== undefined) ? target[c] : ''; });
  ['ふりがな', '学年', '学校', '保護者名', '保護者連絡先', 'メール', '入塾日', '状態', '科目', '備考'].forEach(function (c) {
    if (pr[c] !== undefined) obj[c] = String(pr[c]).slice(0, 200);
  });
  obj['生徒ID'] = id;
  obj['氏名'] = sys.name;
  obj['単価(30分)'] = Number(sys.rate30 || 0) || '';
  obj['月謝'] = Number(sys.monthly || 0) || '';
  if (target) {
    var rng = sh.getRange(target._row, 1, 1, cols.length);
    rng.setValues([cols.map(function (c) { return obj[c]; })]);
    sh.getRange(target._row, 1).setNumberFormat('@');
    sh.getRange(target._row, 7).setNumberFormat('@');
  } else {
    ledgerAppend_('生徒台帳', obj);
  }
  return kanriStudentOp_({ studentId: id, view: req.view });
}

function kanriAddGrade_(req) {
  var id = String(req.studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return { error: '日付をえらんでください' };
  if (req.score === '' || req.score === undefined || isNaN(Number(req.score))) return { error: '点数を入れてください' };
  ledgerAppend_('成績推移', { '日付': req.date, '生徒ID': id, '氏名': sys.name, 'テスト名': String(req.test || '').slice(0, 50),
    '科目': String(req.subject || ''), '点数': Number(req.score), '満点': req.max ? Number(req.max) : '',
    '偏差値': req.dev ? Number(req.dev) : '', '順位': String(req.rank || ''), '備考': String(req.note || '').slice(0, 200) });
  return kanriStudentOp_({ studentId: id, view: req.view });
}

// 模試の結果を1回分登録。scores = { 国語:{score,dev}, ..., '3教科':{...}, '5教科':{...} }
function kanriAddExam_(req) {
  var id = String(req.studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return { error: '日付をえらんでください' };
  if (!String(req.name || '').trim()) return { error: '模試名を入れてください' };
  var num = function (v) { return v === '' || v === undefined || v === null || isNaN(Number(v)) ? '' : Number(v); };
  var sc = req.scores || {};
  var o = { '日付': req.date, '生徒ID': id, '氏名': sys.name, '模試名': String(req.name).trim().slice(0, 40), '回': String(req.round || '').slice(0, 30), '学年': String(req.grade || '').slice(0, 10) };
  EXAM_SUBJECTS_.forEach(function (s) { var x = sc[s] || {}; o[s] = num(x.score); o[s + '偏差値'] = num(x.dev); });
  var t3 = sc['3教科'] || {}, t5 = sc['5教科'] || {};
  o['3教科'] = num(t3.score); o['3教科偏差値'] = num(t3.dev); o['5教科'] = num(t5.score); o['5教科偏差値'] = num(t5.dev);
  o['3教科順位'] = String(req.rank3 || '').slice(0, 30); o['5教科順位'] = String(req.rank5 || '').slice(0, 30); o['受験者数'] = String(req.n || '').slice(0, 20);
  o['志望校判定'] = String(req.judge || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean).join(' / ').slice(0, 600);
  o['資料URL'] = String(req.url || '').slice(0, 300); o['備考'] = String(req.note || '').slice(0, 200);
  ledgerAppend_('模試', o);
  return kanriStudentOp_({ studentId: id, view: req.view });
}

function kanriAddPayment_(req) {
  var id = String(req.studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  if (!/^\d{4}-\d{2}$/.test(String(req.ym || ''))) return { error: '年月の形式は YYYY-MM です' };
  var amount = Number(req.amount);
  if (isNaN(amount) || amount <= 0) return { error: '請求額を入れてください' };
  var paid = String(req.paidDate || '');
  ledgerAppend_('入金管理', { '年月': String(req.ym), '生徒ID': id, '氏名': sys.name, '請求額': amount,
    '請求日': String(req.billDate || todayStr_()), '入金日': paid, '入金方法': String(req.method || ''),
    '状態': paid ? '入金済' : '未入金', '備考': String(req.note || '').slice(0, 200) });
  return kanriStudentOp_({ studentId: id, view: req.view });
}

function kanriSetPaid_(req) {
  var sh = ledgerSheet_('入金管理');
  var row = Number(req.row);
  var cols = LEDGER_COLS['入金管理'];
  var vals = sh.getRange(row, 1, 1, cols.length).getValues()[0];
  if (String(vals[1]) !== String(req.studentId)) return { error: '行が一致しません。画面を更新してください' };
  var paid = req.unpaid ? '' : String(req.paidDate || todayStr_());
  sh.getRange(row, 6, 1, 3).setValues([[paid, req.unpaid ? '' : String(req.method || ''), paid ? '入金済' : '未入金']]);
  return kanriStudentOp_({ studentId: String(req.studentId), view: req.view });
}

function kanriAddMeeting_(req) {
  var id = String(req.studentId || '');
  var sys = systemStudent_(id);
  if (!sys) return { error: '生徒が見つかりません' };
  if (!String(req.content || '').trim()) return { error: '内容を入れてください' };
  ledgerAppend_('面談記録', { '日付': String(req.date || todayStr_()), '生徒ID': id, '氏名': sys.name, '相手': String(req.who || ''),
    '方法': String(req.method || ''), '内容': String(req.content || '').slice(0, 2000), '次のアクション': String(req.next || '').slice(0, 500) });
  return kanriStudentOp_({ studentId: id, view: req.view });
}

function kanriDeleteRow_(req) {
  var name = String(req.sheet || '');
  if (!LEDGER_COLS[name] || name === '生徒台帳') return { error: 'このシートの行は削除できません' };
  var sh = ledgerSheet_(name);
  var row = Number(req.row);
  var cols = LEDGER_COLS[name];
  var vals = sh.getRange(row, 1, 1, cols.length).getValues()[0];
  var idCol = cols.indexOf('生徒ID');
  if (String(vals[idCol]) !== String(req.studentId)) return { error: '行が一致しません。画面を更新してください' };
  sh.deleteRow(row);
  return kanriStudentOp_({ studentId: String(req.studentId), view: req.view });
}

// 【復旧用・エディタから実行】先生のログイン情報を初期化する(Webからは呼べない)。
// 実行後、管理画面のログイン画面に「初期設定」フォームが出るので、PIN(0000)とメール・新しいパスワードで再設定する
function resetTeacherLogin() {
  ['teacherEmail', 'passSalt', 'passHash', 'adminToken'].forEach(function (k) { setConfig_(k, ''); });
  setConfig_('failCount', '0');
  setConfig_('lockUntil', '0');
  CacheService.getScriptCache().remove('schemaOk4');
  addLog_('先生のログイン情報を初期化(再設定待ち)');
  Logger.log('reset done: authMode=' + authMode_());
}

// エディタから実行する動作確認用(Webからは呼べない)
function kanriSelfTest() {
  var d = kanriDashboard_();
  Logger.log('dashboard students=' + d.students.length + ' today=' + d.lessonsToday.length + ' unpaid=' + d.unpaid.length);
  if (d.students.length) {
    var s = kanriStudent_(d.students[0].id);
    Logger.log('student ' + s.name + ' lessons=' + s.lessons.length + ' grades=' + s.grades.length + ' fee=' + s.thisMonth.fee);
  }
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
  // 全桁が数字だとシート上で数値化されてしまうため、必ず英字を含める
  var s = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  if (/^[0-9]+$/.test(s)) s = 'a' + s.slice(1);
  return s;
}
