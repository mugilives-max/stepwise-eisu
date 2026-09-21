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
