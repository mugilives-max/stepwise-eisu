// D1 の行を「スプレッドシートが返していた形」に戻す。
//
// なぜ要るか: GAS の計算（studentState_ など）は素の JavaScript で、Google のサービスに
// 依存しているのはシートを読む所だけ。そこを D1 に差し替えられれば、同じコードをそのまま
// 動かせて、返す JSON が変わらないことを計算で保証できる（移す先で作り直さなくてよい）。
//
// 気をつける所は真偽値。台帳では 3 通りの書き方が混在していて、GAS 側の読み方も列ごとに違う。
// D1 では 0/1 に揃えてあるので、戻すときに列ごとの書き方へ直す。間違えると
// 「停止中の生徒が在籍扱いになる」「実施済みの授業が未実施になる」といった形で効く。
import { quoteIdent } from './import.mjs';

// 列ごとの真偽値の書き方。GAS 側の判定と対応する:
//   boolean … `!(String(v)==='false' || v===false)` / `v===true || String(v)==='true'`
//   text    … `String(v)==='true'` の厳密比較（'true' / 'false' の文字列）
//   digit   … `String(v)!=='0'`（'1' / '0' の文字列。行が無ければ全部 on）
export const BOOLEAN_CELLS = {
  'students.active': 'boolean',
  'slots.done': 'boolean',
  'familyLinks.active': 'text',
  'lessonKinds.active': 'text',
  'familyAccounts.testOnly': 'text',
  'familyEmailPrefs.planProposed': 'digit',
  'familyEmailPrefs.invoiceCreated': 'digit',
  'familyEmailPrefs.invoiceVoided': 'digit',
  'studentEmailPrefs.offered': 'digit',
  'studentEmailPrefs.changed': 'digit',
  'studentEmailPrefs.cancelled': 'digit',
  'studentEmailPrefs.cancelDeclined': 'digit',
};

// 塾管理台帳（2冊目）にある表
export const LEDGER_TABLES = ['入金管理', '生徒台帳', '成績推移', '模試', '面談記録'];

// 取り込みの記録など、台帳には無い表
// シートの写しではない、Worker 自身の表。台帳の読み書きの対象にしない
const NOT_A_SHEET = ['_importRuns', '_ledger', '_guard', '_effects', '_nl_usage', 'pushSubs', '_studentDocuments'];

const HIDDEN_COLUMNS = ['_syncedAt', '_sheetRow', 'rowid_'];

function cellOf(table, column, value) {
  // 空欄は空欄のまま戻す。真偽の列でも「未設定」と「false」は別物
  // （slots.done は未実施なら空欄。false を書き戻すと台帳と形が変わる）
  if (value === null || value === undefined) return '';
  const kind = BOOLEAN_CELLS[table + '.' + column];
  if (kind) {
    const on = Number(value) === 1;
    if (kind === 'boolean') return on;
    if (kind === 'text') return on ? 'true' : 'false';
    return on ? '1' : '0';
  }
  return value;
}

export async function tableNames(db) {
  // sqlite_% / d1_% / _cf_% は仕組み側の表。D1 では中身を読もうとすると断られる（SQLITE_AUTH）
  const { results } = await db.prepare(
    "select name from sqlite_master where type='table'" +
    " and name not like 'sqlite_%' and name not like 'd1_%' and name not like '_cf_%'" +
    ' order by name').all();
  return results.map(r => String(r.name)).filter(n => !NOT_A_SHEET.includes(n));
}

/** 1 つの表を、見出し行つきの二次元配列（シートの getValues と同じ形）にする。
 *
 * D1 は PRAGMA を実行できない（`pragma table_info` も `pragma_table_info(...)` も
 * SQLITE_AUTH で断られる）ので、列は呼び出し側から渡してもらう
 * （cf/worker/generated/schema.mjs。cf/migrations から自動生成している）。
 * 渡されなければ問い合わせの結果に付いてくる列名を使う（0 件の表でも取れる）。 */
export async function sheetValues(db, table, knownColumns) {
  const rows = knownColumns
    ? [knownColumns].concat((await db.prepare(orderedSelect(table)).raw()))
    : await db.prepare(orderedSelect(table)).raw({ columnNames: true });
  return shapeRows(table, rows);
}

// _sheetRow はシート上の行番号。並びを元のシートと同じにするために使う
function orderedSelect(table) {
  return `select * from ${quoteIdent(table)} order by _sheetRow`;
}

function shapeRows(table, rows) {
  if (!rows.length) return [];
  const all = rows[0].map(String);
  const keep = all.map((name, i) => [name, i]).filter(([name]) => !HIDDEN_COLUMNS.includes(name));
  if (!keep.length) return [];
  return [keep.map(([name]) => name)]
    .concat(rows.slice(1).map(row => keep.map(([name, i]) => cellOf(table, name, row[i]))));
}

/** 台帳2冊ぶんをまとめて作る。GAS のハーネスや Worker にそのまま渡せる。 */
export async function books(db, tableColumns) {
  // 列が分かっているときは 1 回のまとめ問い合わせで全部読む。
  // 表ごとに問い合わせると D1 では 1 回ごとの往復が効いて、45 表で 180ms ほどかかる。
  if (tableColumns) {
    const names = Object.keys(tableColumns).filter(n => !NOT_A_SHEET.includes(n));
    const answers = await db.batch(names.map(n => db.prepare(orderedSelect(n))));
    const app = {}, ledger = {};
    names.forEach((name, i) => {
      const columns = tableColumns[name];
      const body = (answers[i].results || []).map(row => columns.map(c => row[c]));
      const values = shapeRows(name, [columns].concat(body));
      if (values.length) (LEDGER_TABLES.includes(name) ? ledger : app)[name] = values;
    });
    return { app, ledger };
  }
  const app = {}, ledger = {};
  for (const name of await tableNames(db)) {
    const values = await sheetValues(db, name);
    if (!values.length) continue;
    (LEDGER_TABLES.includes(name) ? ledger : app)[name] = values;
  }
  return { app, ledger };
}
