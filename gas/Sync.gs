/** 書き込んだあと、変わったシートを Worker（D1）へ送る。
 *
 * なぜ要るか: 画面の表示は Worker が D1 から返すようになる（速いので）。書き込みは当面この
 * GAS が続けるため、書いたら D1 にも伝えないと画面が古いままになる。送るのは一方通行で、
 * Worker から台帳へ書き戻すことはない。
 *
 * 設定（鍵を入れて初めて動く。入れるまでは何もしない＝今までどおり）
 *   Script Properties の WORKER_SYNC_KEY … 24文字以上の共有の鍵（Worker 側の secret SYNC_KEY と同じ値）
 *   Script Properties の WORKER_SYNC_URL … 送り先。未設定なら下の既定値を使う。
 *     URL は秘密ではない（画面にも載る公開の口で、中身は鍵で守る）ので既定値を持たせてある。
 *
 * 失敗したときは記録だけ残し、応答は壊さない（授業の登録が失敗扱いになると困るため）。
 * 次の書き込みのときに、取りこぼしたシートもまとめて送り直す。
 */
var SYNC_TOUCHED_ = {};      // この実行で書き込み対象になったシート { シート名: 'app'|'ledger' }
var SYNC_PENDING_KEY_ = 'WORKER_SYNC_PENDING';
var SYNC_MAX_SHEETS_ = 40;   // 1 回に送るシート数の上限（取りこぼしが溜まったとき用）

var SYNC_DEFAULT_URL_ = 'https://stepwise-api.stepwise-edu.workers.dev/sync';
function syncUrl_() { return String(PropertiesService.getScriptProperties().getProperty('WORKER_SYNC_URL') || SYNC_DEFAULT_URL_).trim(); }
function syncKey_() { return String(PropertiesService.getScriptProperties().getProperty('WORKER_SYNC_KEY') || '').trim(); }
function syncEnabled_() { return !!syncUrl_() && syncKey_().length >= 24; }

// 書き込み対象になったシートを覚える。sheet_() / ledgerSheet_() から呼ばれる
function syncTouch_(name, book) {
  if (!name) return;
  SYNC_TOUCHED_[String(name)] = book === 'ledger' ? 'ledger' : 'app';
}

// 前回送れなかったシート
function syncPending_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SYNC_PENDING_KEY_);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function syncSavePending_(map) {
  var props = PropertiesService.getScriptProperties();
  if (!map || !Object.keys(map).length) props.deleteProperty(SYNC_PENDING_KEY_);
  else props.setProperty(SYNC_PENDING_KEY_, JSON.stringify(map));
}

// 1 シートを送れる形にする。値の直し方は移行用の書き出しと同じ（Export.gs の exportCell_）
function syncSheetPayload_(name, book) {
  var ss = book === 'ledger' ? ledger_() : ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) return null;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastCol < 1) return null;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues().map(function (row) { return row.map(exportCell_); }) : [];
  return { book: book, sheet: name, headers: headers, rows: rows };
}

/** この実行で変わったシートを送る。呼び出しの最後に 1 回だけ実行する。 */
function syncPush_() {
  // 正本が Worker に移ったあとは押し戻さない。Worker 側も /sync を断る（409）ので、
  // 送っても無駄に時間がかかり、取りこぼしの控えだけが溜まっていく
  if (workerOwnsLedger_()) { SYNC_TOUCHED_ = {}; syncSavePending_({}); return null; }
  if (!syncEnabled_()) { SYNC_TOUCHED_ = {}; return null; }
  var targets = {};
  var pending = syncPending_();
  var name;
  for (name in pending) targets[name] = pending[name];
  for (name in SYNC_TOUCHED_) targets[name] = SYNC_TOUCHED_[name];
  SYNC_TOUCHED_ = {};
  var names = Object.keys(targets);
  if (!names.length) return null;
  if (names.length > SYNC_MAX_SHEETS_) names = names.slice(0, SYNC_MAX_SHEETS_);

  var sheets = [];
  for (var i = 0; i < names.length; i++) {
    var payload = syncSheetPayload_(names[i], targets[names[i]]);
    if (payload) sheets.push(payload);
  }
  if (!sheets.length) { syncSavePending_({}); return null; }

  try {
    var res = UrlFetchApp.fetch(syncUrl_(), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ key: syncKey_(), sheets: sheets }),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      // 送れた分を取りこぼしから外す
      var rest = {};
      for (name in targets) if (names.indexOf(name) < 0) rest[name] = targets[name];
      syncSavePending_(rest);
      return { ok: true, sheets: sheets.length, remaining: Object.keys(rest).length };
    }
    syncSavePending_(targets);
    return { ok: false, status: code };
  } catch (e) {
    syncSavePending_(targets);
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 台帳ぜんぶを送り直す（エディタから手で実行する。取りこぼしが疑わしいときの復旧用）。 */
function resyncLedgerToWorker() {
  if (!syncEnabled_()) return { ok: false, message: 'スクリプト プロパティに WORKER_SYNC_KEY（24文字以上）を設定してください' };
  var all = {};
  ss_().getSheets().forEach(function (sh) { all[sh.getName()] = 'app'; });
  ledger_().getSheets().forEach(function (sh) { all[sh.getName()] = 'ledger'; });
  syncSavePending_(all);
  var done = 0, rounds = 0;
  var result = null;
  while (rounds++ < 10) {
    result = syncPush_();
    if (!result) break;
    if (!result.ok) return { ok: false, message: '送信に失敗しました', detail: result };
    done += result.sheets;
    if (!result.remaining) break;
  }
  return { ok: true, sheets: done, message: '台帳ぜんぶを Worker へ送りました' };
}

/* ================= Worker が正本になったあとの役割 =================
 * 台帳の正本が D1 に移ったら、この Apps Script は次の 2 つだけを担当する。
 *   1. 付随処理の代行: Worker はメールもカレンダーも直接扱えないので、頼まれて実行する
 *   2. 台帳の書き出し: Worker から取り寄せてシートへ写す（先生が眺める控え、戻すときの道）
 * 台帳への書き込みは受け付けない（doPost が断る）。二重に書くと正本が 2 つになるため。
 */

// Worker が正本かどうか。スクリプト プロパティ WORKER_OWNS_LEDGER が '1' のとき
function workerOwnsLedger_() { return String(PropertiesService.getScriptProperties().getProperty('WORKER_OWNS_LEDGER') || '') === '1'; }

// 台帳を変える操作か（読み取りと認証だけのものは通す）
var SYNC_READ_ONLY_ACTIONS_ = ['state', 'authmode', 'preview', 'export', 'effects', 'familyHome', 'familyData',
  'familyStudentState', 'familyNotices', 'familyVerificationInfo'];
function syncWriteBlocked_(req) {
  if (!workerOwnsLedger_()) return null;
  var action = String(req && req.action || '');
  if (SYNC_READ_ONLY_ACTIONS_.indexOf(action) >= 0) return null;
  if (action === 'admin') {
    var op = String(req.op || '');
    if (['state', 'kanriDashboard', 'kanriStudent', 'billingPreview', 'login', 'lessonKinds'].indexOf(op) >= 0) return null;
    // MCP からの呼び出しは Worker へ中継する。MCP の鍵は Worker に置かず、ここから渡すので
    // MCP サーバーの設定を変えずに使い続けられる
    if (req.mcpKey !== undefined) return workerProxy_(req);
  }
  return { error: 'この操作は新しい仕組みで受け付けています。画面を再読み込みしてください', errorCode: 'ledgerMoved', refresh: true };
}

// Worker へそのまま渡して、返ってきたものをそのまま返す
function workerProxy_(req) {
  if (!syncKey_() || syncKey_().length < 24) return { error: '中継の設定がありません（WORKER_SYNC_KEY）', badAuth: true };
  try {
    var res = UrlFetchApp.fetch(syncUrl_().replace(/\/sync$/, '/proxy'), {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ key: syncKey_(), mcpKey: mcpKey_(), request: req }),
      muteHttpExceptions: true, followRedirects: true,
    });
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return { error: '中継先が応答しません（' + res.getResponseCode() + '）' };
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { error: '中継に失敗しました: ' + String(e && e.message || e).slice(0, 120) };
  }
}

// 付随処理の代行。Worker からだけ呼ばれる（鍵が要る）
function effectsOp_(req) {
  var key = syncKey_();
  if (!key || key.length < 24 || String(req.key || '') !== key) { Utilities.sleep(300); return { error: '鍵が正しくありません', badAuth: true }; }
  // Worker が先に作ってほしい予定（オンライン授業の Meet はここでしか作れない）
  if (Array.isArray(req.ensure)) return { ok: true, events: effectsEnsureEvents_(req.ensure) };
  var items = Array.isArray(req.items) ? req.items : [];
  var writebacks = [], done = 0, failed = [];
  for (var i = 0; i < items.length && i < 50; i++) {
    var item = items[i];
    try {
      if (item.kind === 'mail') { effectsSendMail_(item); done++; }
      else if (item.kind === 'calendarCreate') { var w = effectsCreateEvent_(item); if (w) writebacks.push(w); done++; }
      else if (item.kind === 'calendarPatch') { var wp = effectsPatchEvent_(item); if (wp) writebacks.push(wp); done++; }
      else if (item.kind === 'calendarMeet') { var wm = effectsMeetOnly_(item); if (wm) writebacks.push(wm); done++; }
      else if (item.kind === 'calendarDelete') { effectsDeleteEvent_(item); done++; }
    } catch (e) {
      failed.push({ kind: String(item && item.kind || ''), error: String(e && e.message || e).slice(0, 200) });
    }
  }
  return { ok: true, done: done, writebacks: writebacks, failed: failed };
}

// 宛先 'TEACHER' は先生自身のアドレス（Worker には実アドレスを置かない）
function effectsSendMail_(item) {
  var to = String(item.to || '') === 'TEACHER' ? Session.getEffectiveUser().getEmail() : String(item.to || '');
  if (!to) return;
  var options = { to: to, subject: String(item.subject || ''), body: String(item.body || '') };
  if (item.name) options.name = String(item.name);
  MailApp.sendEmail(options);
}

// Meet は発行までに少し間がある。ここは利用者を待たせていない場所なので、
// 何度か取りに行く。それでも取れなければ空のまま返し、画面は「準備中」を出しつづける
function effectsMeetUrl_(eventId, tries) {
  var meet = '';
  for (var i = 0; i < (tries || 5) && !meet; i++) {
    if (i) Utilities.sleep(1200);
    try { meet = addMeet_(eventId); } catch (e) { meet = ''; }
  }
  return meet;
}

function effectsCreateEvent_(item) {
  if (getConfig_('calendarSync') !== 'on') return null;
  var ev = Calendar.Events.insert(item.body, 'primary', { sendUpdates: 'none' });
  var eventId = String(ev.iCalUID || ev.id + '@google.com');
  return { marker: String(item.marker || ''), eventId: eventId, meetUrl: item.wantMeet ? effectsMeetUrl_(eventId) : '' };
}

// 発行が間に合わなかった Meet の取り直し。取れたときだけ書き戻す
function effectsMeetOnly_(item) {
  if (getConfig_('calendarSync') !== 'on') return null;
  var eventId = String(item.eventId || '');
  if (!eventId) return null;
  var meet = effectsMeetUrl_(eventId, 2);
  return meet ? { marker: eventId, eventId: eventId, meetUrl: meet } : null;
}

// 既にある予定の書き換え（題名の変更、対面⇔オンラインの切り替え）
function effectsPatchEvent_(item) {
  if (getConfig_('calendarSync') !== 'on') return null;
  var id = String(item.marker || '').split('@')[0];
  if (!id) return null;
  var event;
  try { event = Calendar.Events.patch(item.body || {}, 'primary', id, { conferenceDataVersion: 1, sendUpdates: 'none' }); }
  catch (e) { if (!schedulingCalendarMissing_(e)) throw e; return null; }
  var eventId = String(event.iCalUID || event.id + '@google.com');
  return { marker: String(item.marker || ''), eventId: eventId, meetUrl: item.wantMeet ? effectsMeetUrl_(eventId) : '' };
}

function effectsDeleteEvent_(item) {
  if (getConfig_('calendarSync') !== 'on') return;
  try { Calendar.Events.remove('primary', String(item.eventId).split('@')[0], { sendUpdates: 'none' }); }
  catch (e) { if (!/\b404\b|\b410\b|not found|already deleted/i.test(String(e))) throw e; }
}

/** Worker の台帳をシートへ写す（エディタから手で実行）。切り替え後の控えづくりと、戻すときの道。 */
// 旧・取り寄せ。安全確認のある mirrorLedgerFromWorker（gas/Mirror.gs）に寄せる。
// 手で実行したときに、確認なしの全面上書きが走らないようにするため。
function pullLedgerFromWorker() { return mirrorLedgerFromWorker(); }

// 予定を「あれば取る、無ければ作る」。できた予定をそのまま返す（Worker がその中身で判定する）
function effectsEnsureEvents_(wanted) {
  var out = {};
  for (var i = 0; i < wanted.length && i < 31; i++) {
    var want = wanted[i], id = String(want.id || '');
    if (!id) continue;
    var event = null;
    try { event = Calendar.Events.get('primary', id); }
    catch (e) { if (!schedulingCalendarMissing_(e)) throw e; }
    if (!event) {
      try { event = Calendar.Events.insert(want.body, 'primary', { conferenceDataVersion: 1, sendUpdates: 'none' }); }
      catch (e) {
        if (!schedulingCalendarConflict_(e)) throw e;
        event = Calendar.Events.get('primary', id);
      }
    }
    // 会議室がまだなら作り直す（schedulingCalendarFor_ と同じ考え方）
    if (want.body && want.body.conferenceData && (!event.conferenceData || !schedulingCalendarMeet_(event))) {
      try { event = Calendar.Events.patch({ conferenceData: schedulingConferenceRequest_(id, event) }, 'primary', id, { conferenceDataVersion: 1, sendUpdates: 'none' }); }
      catch (e) { /* 次の試行で取り直す */ }
    }
    out[id] = JSON.parse(JSON.stringify(event));
  }
  return out;
}
