'use strict';

// 並走テストの土台。
//
// 同じ台帳を「スプレッドシート」と「D1」の two 通りで用意し、GAS の読み取り処理を
// 両方で動かして、返る JSON が 1 文字も違わないことを確かめるために使う。
//
// 移行の方針: GAS の計算は素の JavaScript で、Google に依存しているのはシートを読む所だけ。
// そこを D1 に差し替えれば同じコードがそのまま動く。作り直さないので、返す JSON が
// 変わらないことを「比べて確かめる」のではなく「同じコードだから」で担保できる。
// この土台は、その差し替え（cf/lib/sheet-view.mjs）が忠実かどうかを見張る。
//
// 注意している落とし穴:
//   * 台帳に入らない設定値（Script Properties）は別に渡す。渡さないと、D1 側だけが
//     「一度きりの移行処理」を実行してしまい、結果が変わる。本番の Worker でも同じで、
//     読み取りでは ensureSchema_ / 移行処理を絶対に走らせない。
//   * スキーマ整備（列の追加や請求IDの埋め直し）が片側だけで走ると差が出るので、
//     書き出す前に台帳側でも走らせて条件をそろえる。

const { createHarness } = require('../gas-harness.cjs');
const d1h = require('./d1-harness.cjs');

const SCHEMA_CACHE_KEYS = ['schemaOk4', 'schemaOk21', 'schemaOk23'];

// 台帳2冊を「書き出しの束」にする（gas/Export.gs が作るものと同じ形）
function bundleOf(harness) {
  const parts = [];
  for (const [book, label] of [[harness.spreadsheet, 'app'], [harness.ledger, 'ledger']]) {
    for (const [name, sheet] of book.sheets) {
      const values = (sheet.values || []).map(row => row.map(cell => (cell instanceof Date ? cell.toISOString() : cell)));
      parts.push({ book: label, sheet: name, headers: (values[0] || []).map(String), rows: values.slice(1), offset: 0 });
    }
  }
  return parts;
}

/**
 * 台帳を持つハーネスを受け取り、D1 経由で作り直した同じ台帳のハーネスを返す。
 * 戻り値の compare(label, fn) で、両方に同じ処理を流して JSON を比べられる。
 */
async function createParity(source) {
  const { importBundle } = await import('../../cf/lib/import.mjs');
  const { books } = await import('../../cf/lib/sheet-view.mjs');

  // スキーマ整備を台帳側でも一度走らせてから写す（片側だけ走ると差になる）
  for (const key of SCHEMA_CACHE_KEYS) source.cache.remove(key);
  source.admin('state');

  const d1 = d1h.createD1();
  const imported = await importBundle(d1, bundleOf(source), { source: 'parity' });
  const failures = imported.tables.filter(t => t.errors.length || !t.matches);
  if (failures.length) throw new Error('台帳を D1 に写せない: ' + JSON.stringify(failures.map(t => t.table)));

  const view = await books(d1);
  const mirror = createHarness({
    sheets: view.app,
    ledgerSheets: view.ledger,
    properties: Object.fromEntries(source.properties),
  });

  const diffs = [];
  function compare(label, fn) {
    const run = harness => { try { return JSON.stringify(JSON.parse(JSON.stringify(fn(harness)))); } catch (e) { return '例外: ' + (e && e.message || e); } };
    const a = run(source), b = run(mirror);
    if (a !== b) {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      diffs.push(`${label}\n  台帳側: ${a.slice(Math.max(0, i - 60), i + 80)}\n  D1側  : ${b.slice(Math.max(0, i - 60), i + 80)}`);
      return false;
    }
    if (a === 'undefined' || a === 'null' || a.length < 3) diffs.push(`${label}: 中身のない結果を比べている（${a}）`);
    return true;
  }

  return { d1, mirror, source, compare, diffs, imported };
}

module.exports = { createParity, bundleOf };
