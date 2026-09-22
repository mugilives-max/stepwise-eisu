// D1（正本）→ シート（控え）の写し取り。
//
// 台帳の正本は Worker（D1）へ移ったので、シートは「先生が見るための写し」になった。
// 毎日写し直しておくと、次の二つが同時に満たせる。
//   * 先生がいつものシートで最新の台帳を見られる
//   * 既存の週次バックアップ（Backup.gs・日曜 3:00）が、そのまま新しい台帳の控えになる
// そのため週次バックアップより前（毎日 2:00）に走らせる。
//
// 写しは全面の上書きなので、取り寄せた内容がおかしいときは一切書かない。
// 見るのは「表の数が前回より減っていないか」と「必ず中身がある表が空になっていないか」。
// 判定に引っかかったらシートはそのままにして、先生に知らせる。

var MIRROR_STATE_KEY_ = 'STEPWISE_MIRROR_STATE';
// 運用中に空になることがない表。ここが空なら取り寄せ側の異常とみなす
var MIRROR_REQUIRED_SHEETS_ = ['students', 'slots'];
var MIRROR_HOUR_ = 2;

function mirrorProperties_() { return PropertiesService.getScriptProperties(); }
function mirrorState_() {
  var raw = mirrorProperties_().getProperty(MIRROR_STATE_KEY_);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function mirrorSaveState_(state) { mirrorProperties_().setProperty(MIRROR_STATE_KEY_, JSON.stringify(state)); }

// Worker から台帳を取り寄せる
function mirrorFetch_() {
  if (!syncEnabled_()) return { error: 'WORKER_SYNC_KEY を設定してください' };
  var url = syncUrl_().replace(/\/sync$/, '/export');
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ key: syncKey_() }), muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) return { error: '取り寄せに失敗しました（HTTP ' + res.getResponseCode() + '）' };
  try { return { data: JSON.parse(res.getContentText()) }; }
  catch (e) { return { error: '取り寄せた内容を読めませんでした' }; }
}

// 取り寄せた内容を書いてよいか。理由の一覧を返す（空なら書いてよい）
function mirrorProblems_(data, prior) {
  var problems = [];
  if (!data || typeof data !== 'object') return ['取り寄せた内容が空です'];
  var books = [data.app, data.ledger];
  var names = [];
  for (var i = 0; i < books.length; i++) {
    if (!books[i] || typeof books[i] !== 'object') return ['取り寄せた内容の形が違います'];
    names = names.concat(Object.keys(books[i]));
  }
  if (!names.length) return ['取り寄せた内容に表がありません'];
  if (prior && prior.sheets && names.length < prior.sheets) {
    problems.push('表の数が前回より減っています（前回 ' + prior.sheets + ' → 今回 ' + names.length + '）');
  }
  for (var j = 0; j < names.length; j++) {
    var name = names[j], values = (data.app || {})[name] || (data.ledger || {})[name];
    if (!values || !values.length || !values[0] || !values[0].length) problems.push(name + ': 見出しがありません');
    else if (MIRROR_REQUIRED_SHEETS_.indexOf(name) >= 0 && values.length < 2) problems.push(name + ': 中身が空です');
  }
  return problems;
}

// 1 つのシートに写す。書式は残し、中身だけ入れ替える
function mirrorWriteSheet_(book, name, values) {
  var sheet = book.getSheetByName(name) || book.insertSheet(name);
  var width = 0;
  for (var i = 0; i < values.length; i++) width = Math.max(width, values[i].length);
  if (!width) return 0;
  if (values.length > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  if (width > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  // 消すのは「今ある中身」の範囲だけ。空の列まで触ると、そこが使用済みの扱いになる
  var last = sheet.getLastRow(), lastColumn = Math.max(width, sheet.getLastColumn());
  if (last) sheet.getRange(1, 1, last, lastColumn).clearContent();
  sheet.getRange(1, 1, values.length, width).setValues(values.map(function (row) {
    var out = [];
    for (var c = 0; c < width; c++) out.push(row[c] === undefined || row[c] === null ? '' : row[c]);
    return out;
  }));
  return Math.max(0, values.length - 1);
}

function mirrorWrite_(data) {
  var wrote = 0, rows = 0;
  [['app', ss_()], ['ledger', ledger_()]].forEach(function (pair) {
    var sheets = data[pair[0]] || {};
    Object.keys(sheets).forEach(function (name) {
      var values = sheets[name];
      if (!values || !values.length) return;
      rows += mirrorWriteSheet_(pair[1], name, values);
      wrote++;
    });
  });
  return { sheets: wrote, rows: rows };
}

function mirrorNotify_(state) {
  // 毎日知らせると埋もれるので、失敗しはじめた日と、そのあとは 7 日おきだけ
  if (state.failures !== 1 && state.failures % 7 !== 0) return;
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      '[ステップワイズ] シートへの写しが ' + state.failures + ' 回続けて止まっています',
      'D1 の台帳をシートへ写す処理が止まっています。台帳そのものは Worker 側で動いています。\n\n'
      + '理由: ' + (state.problems || []).join(' / ') + '\n'
      + '最後に成功した時刻: ' + (state.lastOkAt || 'なし') + '\n\n'
      + 'シートは古いままなので、週次バックアップも古い内容を保存します。\n'
      + 'スクリプトエディタで ledgerMirrorStatus を実行すると、今の状態を確認できます。');
  } catch (e) { /* 知らせられなくても写しの判断は変えない */ }
}

/** 毎日のトリガーから呼ばれる。手で実行してもよい。 */
function mirrorLedgerFromWorker() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, message: '他の処理と重なりました' };
  try {
    var prior = mirrorState_() || {};
    var got = mirrorFetch_();
    var problems = got.error ? [got.error] : mirrorProblems_(got.data, prior);
    if (problems.length) {
      var failed = { status: 'failed', problems: problems, failures: (prior.failures || 0) + 1,
        at: new Date().toISOString(), lastOkAt: prior.lastOkAt || '', sheets: prior.sheets || 0 };
      mirrorSaveState_(failed);
      mirrorNotify_(failed);
      return { ok: false, problems: problems, message: 'シートは変更していません' };
    }
    var result = mirrorWrite_(got.data);
    mirrorSaveState_({ status: 'ok', at: new Date().toISOString(), lastOkAt: new Date().toISOString(),
      sheets: result.sheets, rows: result.rows, exportedAt: got.data.exportedAt || '', failures: 0, problems: [] });
    return { ok: true, sheets: result.sheets, rows: result.rows, message: 'D1 の台帳をシートへ写しました' };
  } finally { lock.releaseLock(); }
}

/** スクリプトエディタから 1 回だけ実行する。毎日 2:00 の予約を作る。 */
function setupLedgerMirror() {
  if (!syncEnabled_()) return { ok: false, message: 'WORKER_SYNC_KEY を先に設定してください' };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'mirrorLedgerFromWorker') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('mirrorLedgerFromWorker').timeBased().atHour(MIRROR_HOUR_).everyDays(1).inTimezone('Asia/Tokyo').create();
  return { ok: true, schedule: '毎日 ' + MIRROR_HOUR_ + ':00 Asia/Tokyo', message: '週次バックアップ（日曜 3:00）より前に走ります' };
}

/** スクリプトエディタから実行して、写しの状態を見る。 */
function ledgerMirrorStatus() {
  var state = mirrorState_();
  var installed = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'mirrorLedgerFromWorker'; });
  return { installed: installed, state: state || 'まだ一度も走っていません' };
}
