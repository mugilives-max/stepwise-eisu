/** D1 移行の初回コピー用。台帳の中身を JSON にしてドライブへ書き出す。
 *
 * 使い方（先生がスクリプトエディタから手で実行する）
 *   1. 関数 exportLedgerForMigration を選んで実行
 *   2. 「途中で終わりました」と出たら exportLedgerResume を実行（6分の実行制限があるため）
 *   3. 「完了」と出たら、できたフォルダをドライブからダウンロードして展開し、
 *      node scripts/ledger-to-d1.mjs --bundle <展開したフォルダ> に渡す
 *   途中経過は exportLedgerStatus で見られる。やり直すときは exportLedgerReset。
 *
 * 方針
 *   - 読むだけ。台帳には一切書き込まない。
 *   - doPost には載せない。外から叩ける口は増やさない（エディタで実行できる人だけが使える）。
 *   - 書き出し先は本人だけのフォルダ。共有されていたら止める（Backup.gs と同じ確認）。
 *   - 日付セルは Asia/Tokyo で読む。UTC に寄って前日にずれるのを防ぐ。
 *   - 書き出したファイルには生徒・保護者の個人情報が入る。手元から外へ出さない。
 */
var SW_EXPORT_KEY_ = 'STEPWISE_EXPORT_STATE';
var EXPORT_ROWS_PER_FILE_ = 2000;
var EXPORT_BUDGET_MS_ = 240000; // 1回の実行で使う上限。Apps Script の 6 分より手前で切り上げる

function exportState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SW_EXPORT_KEY_);
  return raw ? JSON.parse(raw) : null;
}

function exportSaveState_(state) {
  PropertiesService.getScriptProperties().setProperty(SW_EXPORT_KEY_, JSON.stringify(state));
  return state;
}

// セルを D1 に入れられる値にする。日付セルは Asia/Tokyo。
function exportCell_(v) {
  if (v instanceof Date) {
    var time = Utilities.formatDate(v, TZ, 'HH:mm:ss');
    return time === '00:00:00' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v;
  return v === null || v === undefined ? '' : String(v);
}

function exportBook_(name) { return name === 'ledger' ? ledger_() : ss_(); }

// 書き出す対象の一覧。空のシートも「0 件」として残し、取り込み側で件数を突き合わせられるようにする
function exportPlan_() {
  var plan = [];
  [['app', ss_()], ['ledger', ledger_()]].forEach(function (pair) {
    pair[1].getSheets().forEach(function (sh) {
      plan.push({ book: pair[0], sheet: sh.getName(), total: Math.max(0, sh.getLastRow() - 1), done: 0 });
    });
  });
  return plan;
}

// 1 シート分の 1 かたまりを書き出す。戻り値は書いた行数
function exportChunk_(folder, entry) {
  var sh = exportBook_(entry.book).getSheetByName(entry.sheet);
  if (!sh) return 0;
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return 0;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
  var take = Math.max(0, Math.min(EXPORT_ROWS_PER_FILE_, entry.total - entry.done));
  var rows = take ? sh.getRange(2 + entry.done, 1, take, lastCol).getValues().map(function (row) { return row.map(exportCell_); }) : [];
  var part = Math.floor(entry.done / EXPORT_ROWS_PER_FILE_);
  var name = entry.book + '.' + entry.sheet + (entry.total > EXPORT_ROWS_PER_FILE_ ? '.p' + part : '') + '.json';
  var payload = { book: entry.book, sheet: entry.sheet, headers: headers, rows: rows, offset: entry.done };
  folder.createFile(name, JSON.stringify(payload), MimeType.PLAIN_TEXT);
  return rows.length;
}

function exportStep_() {
  var state = exportState_();
  if (!state || state.status !== 'running') return { ok: false, message: '書き出しが始まっていません。exportLedgerForMigration を実行してください' };
  var folder = backupPrivate_(DriveApp.getFolderById(state.folder));
  var started = Date.now();
  var wrote = 0;
  var chunks = 0; // この実行で書いたかたまりの数。1つも書いていないうちは打ち切らない
  //（打ち切ると、再開のたびに「すでに終わったシート」を見て何も進まなくなる）
  var spent = function () { return chunks > 0 && Date.now() - started > EXPORT_BUDGET_MS_; };
  for (var i = 0; i < state.plan.length; i++) {
    var entry = state.plan[i];
    while (entry.done < entry.total || (entry.total === 0 && !entry.emitted)) {
      wrote += exportChunk_(folder, entry);
      chunks++;
      if (entry.total === 0) { entry.emitted = true; break; }
      entry.done = Math.min(entry.total, entry.done + EXPORT_ROWS_PER_FILE_);
      if (spent()) { exportSaveState_(state); return exportProgress_(state, wrote, false); }
    }
    if (spent()) { exportSaveState_(state); return exportProgress_(state, wrote, false); }
  }
  state.status = 'done';
  state.finished = new Date().toISOString();
  folder.createFile('_manifest.json', JSON.stringify({ startedAt: state.started, finishedAt: state.finished, tz: TZ, sheets: state.plan.map(function (e) { return { book: e.book, sheet: e.sheet, rows: e.total }; }) }), MimeType.PLAIN_TEXT);
  exportSaveState_(state);
  return exportProgress_(state, wrote, true);
}

function exportProgress_(state, wrote, finished) {
  var total = 0, done = 0;
  state.plan.forEach(function (e) { total += e.total; done += e.done; });
  return {
    ok: true,
    status: state.status,
    folder: state.folder,
    folderName: state.folderName,
    sheets: state.plan.length,
    rowsTotal: total,
    rowsDone: done,
    rowsThisRun: wrote,
    message: finished
      ? '完了。ドライブの「' + state.folderName + '」をダウンロードして展開し、scripts/ledger-to-d1.mjs に渡してください'
      : '途中で終わりました（' + done + '/' + total + ' 行）。exportLedgerResume を実行して続けてください',
  };
}

/** 書き出しを始める（エディタから実行）。 */
function exportLedgerForMigration() {
  var prior = exportState_();
  if (prior && prior.status === 'running') return { ok: false, message: '前回の書き出しが途中です。exportLedgerResume で続けるか、exportLedgerReset でやり直してください', folderName: prior.folderName };
  var root = DriveApp.createFolder('ステップワイズ_移行用書き出し_' + new Date().toISOString().replace(/[:.]/g, '-'));
  backupPrivate_(root);
  var state = exportSaveState_({ status: 'running', started: new Date().toISOString(), folder: root.getId(), folderName: root.getName(), plan: exportPlan_() });
  return exportStep_();
}

/** 途中から続ける（エディタから実行）。 */
function exportLedgerResume() { return exportStep_(); }

/** 今どこまで進んだかを見る。 */
function exportLedgerStatus() {
  var state = exportState_();
  if (!state) return { ok: false, message: 'まだ書き出していません' };
  return exportProgress_(state, 0, state.status === 'done');
}

/** やり直せるように記録だけ消す。書き出したフォルダは消さない（消すのは先生が手で行う）。 */
function exportLedgerReset() {
  var state = exportState_();
  PropertiesService.getScriptProperties().deleteProperty(SW_EXPORT_KEY_);
  return { ok: true, message: '記録を消しました。次は exportLedgerForMigration から始められます', keptFolder: state ? state.folderName : '' };
}
