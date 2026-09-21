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
const NOT_A_SHEET = ['_importRuns'];

const HIDDEN_COLUMNS = ['_syncedAt', '_sheetRow', 'rowid_'];

function cellOf(table, column, value) {
  const kind = BOOLEAN_CELLS[table + '.' + column];
  if (kind) {
    const on = Number(value) === 1;
    if (kind === 'boolean') return on;
    if (kind === 'text') return on ? 'true' : 'false';
    return on ? '1' : '0';
  }
  // '' と 0 を区別する列は NULL で入っている。シート上は空欄だった
  if (value === null || value === undefined) return '';
  return value;
}

export async function tableNames(db) {
  const { results } = await db.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'd1_%' order by name").all();
  return results.map(r => String(r.name)).filter(n => !NOT_A_SHEET.includes(n));
}

/** 1 つの表を、見出し行つきの二次元配列（シートの getValues と同じ形）にする。 */
export async function sheetValues(db, table) {
  const info = await db.prepare(`pragma table_info(${quoteIdent(table)})`).all();
  const columns = info.results.map(r => String(r.name)).filter(c => !HIDDEN_COLUMNS.includes(c));
  if (!columns.length) return [];
  const hasSheetRow = info.results.some(r => String(r.name) === '_sheetRow');
  const order = hasSheetRow ? 'order by _sheetRow' : '';
  const { results } = await db.prepare(`select * from ${quoteIdent(table)} ${order}`).all();
  return [columns].concat(results.map(row => columns.map(c => cellOf(table, c, row[c]))));
}

/** 台帳2冊ぶんをまとめて作る。GAS のハーネスや Worker にそのまま渡せる。 */
export async function books(db) {
  const app = {}, ledger = {};
  for (const name of await tableNames(db)) {
    const values = await sheetValues(db, name);
    if (!values.length) continue;
    (LEDGER_TABLES.includes(name) ? ledger : app)[name] = values;
  }
  return { app, ledger };
}
