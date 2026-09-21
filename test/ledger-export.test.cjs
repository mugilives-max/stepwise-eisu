'use strict';

// 移行用の書き出し（gas/Export.gs）の検証。
// エディタから手で実行する関数なので doPost は通らない。ドライブと台帳は作り物で、
// Google の実サービスにはつながない。実データは使わない。
// 最後に cf/lib/import.mjs へ通し、「書き出し → 取り込み」が実際につながることまで見る。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const d1h = require('./helpers/d1-harness.cjs');

function formatDate(date, timezone, format) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, t => ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second }[t]));
}

function sheet(name, values) {
  return {
    name, values,
    getName: () => name,
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(0, ...values.map(r => r.length)),
    getRange(row, col, rows, cols) {
      return { getValues: () => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => values[row + r - 1]?.[col + c - 1] ?? '')) };
    },
  };
}

function fixture(options = {}) {
  const files = new Map();
  let sequence = 0;
  function folder(name, access = 'PRIVATE') {
    const id = 'folder-' + (++sequence);
    const f = {
      id, name, access, children: [],
      getId: () => id, getName: () => name,
      getSharingAccess: () => f.access, getEditors: () => f.editors || [], getViewers: () => f.viewers || [],
      createFile(fileName, body) { const file = { name: fileName, body }; f.children.push(file); return file; },
    };
    files.set(id, f);
    return f;
  }

  // 台帳は 2 冊。日付セル・真偽・数値・数式よけの ' を混ぜてある
  const app = [
    sheet('students', [['id', 'name', 'active', 'rate30'], ['test-a', '【テスト】あ', true, 1500], ['test-b', '【テスト】い', false, '']]),
    sheet('slots', [['id', 'date', 'start', 'min', 'status', 'studentId', 'done'],
      // 日本時間の 9/25。UTC に直すと 9/24 になるので、ずれたらここで落ちる
      ['s1', new Date('2026-09-24T15:00:00Z'), '17:00', 60, 'booked', 'test-a', true]]),
    // 時刻だけのセルは 1899-12-30 という基準日で入る。HH:MM に直せないと予定表が壊れる
    sheet('teacherOff', [['id', 'date', 'note', 'start', 'end'],
      ['t1', new Date('2026-09-24T15:00:00Z'), '', new Date('1899-12-30T11:30:00+09:00'), new Date('1899-12-30T12:00:00+09:00')]]),
    sheet('events', [['id', 'studentId', 'date', 'dateTo', 'title', 'createdAt', 'kind']]),
    sheet('log', [['time', 'message']].concat(
      Array.from({ length: options.logRows ?? 3 }, (_, i) => [new Date('2026-09-20T01:00:00Z'), '記録' + i]))),
  ];
  const ledger = [sheet('入金管理', [['年月', '生徒ID', '請求額', '請求ID'], ['2026-08', 'test-a', 4500, 'inv-1']])];
  const book = list => ({ getSheets: () => list, getSheetByName: n => list.find(s => s.getName() === n) || null });

  const props = {};
  const context = {
    Date, JSON, Error, Math, String, Number, Array, Object, TZ: 'Asia/Tokyo',
    ss_: () => book(app), ledger_: () => book(ledger),
    Utilities: { formatDate, computeDigest: () => [], DigestAlgorithm: { SHA_256: 'sha256' } },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    DriveApp: { Access: { PRIVATE: 'PRIVATE' }, createFolder: n => folder(n), getFolderById: id => files.get(id) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
  };
  vm.createContext(context);
  // backupPrivate_（共有されていないことの確認）を借りるので Backup.gs も読む
  vm.runInContext(fs.readFileSync('gas/Backup.gs', 'utf8'), context);
  vm.runInContext(fs.readFileSync('gas/Export.gs', 'utf8'), context);
  return { c: context, files, props, app, ledger };
}

function written(h) {
  const state = JSON.parse(h.props.STEPWISE_EXPORT_STATE);
  return h.files.get(state.folder).children;
}

test('書き出しは台帳を読むだけで、シートごとに 1 ファイルと控えを作る', () => {
  const h = fixture();
  const res = h.c.exportLedgerForMigration();
  assert.equal(res.ok, true);
  assert.equal(res.status, 'done');
  assert.equal(res.sheets, 6, '2冊あわせて 6 シート');
  assert.match(res.message, /完了/);

  const names = written(h).map(f => f.name).sort();
  assert.deepEqual(names, ['_manifest.json', 'app.events.json', 'app.log.json', 'app.slots.json', 'app.students.json', 'app.teacherOff.json', 'ledger.入金管理.json']);

  const students = JSON.parse(written(h).find(f => f.name === 'app.students.json').body);
  assert.deepEqual(students.headers, ['id', 'name', 'active', 'rate30']);
  assert.deepEqual(students.rows, [['test-a', '【テスト】あ', true, 1500], ['test-b', '【テスト】い', false, '']]);
  assert.equal(students.offset, 0);

  // 空のシートも 0 件として残す（取り込み側で件数を突き合わせられるように）
  const empty = JSON.parse(written(h).find(f => f.name === 'app.events.json').body);
  assert.deepEqual(empty.rows, []);
  const offSheet = JSON.parse(written(h).find(f => f.name === 'app.teacherOff.json').body);
  assert.deepEqual(offSheet.headers, ['id', 'date', 'note', 'start', 'end']);

  const manifest = JSON.parse(written(h).find(f => f.name === '_manifest.json').body);
  assert.equal(manifest.tz, 'Asia/Tokyo');
  assert.deepEqual(manifest.sheets.find(s => s.sheet === 'students'), { book: 'app', sheet: 'students', rows: 2 });
});

test('日付セルは日本時間で読む（UTC に寄って前日にならない）', () => {
  const h = fixture();
  h.c.exportLedgerForMigration();
  const slots = JSON.parse(written(h).find(f => f.name === 'app.slots.json').body);
  assert.equal(slots.rows[0][1], '2026-09-25', '9/25 0:00 JST は 9/25 のまま');
  const log = JSON.parse(written(h).find(f => f.name === 'app.log.json').body);
  assert.equal(log.rows[0][0], '2026-09-20 10:00:00', '時刻が入っている日付は日時として残す');

  // 時刻だけのセル（1899-12-30 が基準日）は HH:MM にする
  const off = JSON.parse(written(h).find(f => f.name === 'app.teacherOff.json').body);
  assert.deepEqual(off.rows[0].slice(3), ['11:30', '12:00'], '時刻だけのセルは基準日を落として HH:MM にする');
  assert.equal(off.rows[0][1], '2026-09-25', '同じ行の日付は日付のまま');
});

test('古い書き出しに基準日が残っていても取り込みで HH:MM に直す', async () => {
  const { normalizeCell, unepochTime } = await import('../cf/lib/import.mjs');
  assert.equal(unepochTime('1899-12-30 07:30:00'), '07:30');
  assert.equal(unepochTime('1899-12-30T17:00'), '17:00');
  assert.equal(unepochTime('2026-09-25 17:00:00'), '2026-09-25 17:00:00', 'ふつうの日時は触らない');
  assert.equal(normalizeCell('1899-12-30 09:00:00', { type: 'TEXT' }), '09:00');
});

test('行が多いシートは分割し、途中で終わっても続きから再開できる', () => {
  const h = fixture({ logRows: 2500 });
  h.c.EXPORT_BUDGET_MS_ = -1; // 1 かたまり書いたら必ず打ち切る
  let res = h.c.exportLedgerForMigration();
  assert.equal(res.status, 'running');
  assert.match(res.message, /exportLedgerResume/);

  const status = h.c.exportLedgerStatus();
  assert.equal(status.rowsTotal, 2505, '全体の行数を把握している');
  assert.ok(status.rowsDone < status.rowsTotal);

  for (let i = 0; i < 20 && res.status === 'running'; i++) res = h.c.exportLedgerResume();
  assert.equal(res.status, 'done', '続きを実行すれば最後まで終わる');
  assert.equal(res.rowsDone, 2505);

  const parts = written(h).filter(f => f.name.startsWith('app.log.')).map(f => f.name).sort();
  assert.deepEqual(parts, ['app.log.p0.json', 'app.log.p1.json'], '2000 行ごとに分ける');
  const p1 = JSON.parse(written(h).find(f => f.name === 'app.log.p1.json').body);
  assert.equal(p1.offset, 2000);
  assert.equal(p1.rows.length, 500);
});

test('共有されているフォルダには書き出さない', () => {
  const h = fixture();
  const original = h.c.DriveApp.createFolder;
  h.c.DriveApp.createFolder = n => { const f = original(n); f.access = 'ANYONE'; return f; };
  assert.throws(() => h.c.exportLedgerForMigration(), /owner-only/);
});

test('途中の書き出しがあるときは新しく始めず、reset すれば始められる', () => {
  const h = fixture({ logRows: 2500 });
  h.c.EXPORT_BUDGET_MS_ = -1;
  h.c.exportLedgerForMigration();
  const again = h.c.exportLedgerForMigration();
  assert.equal(again.ok, false);
  assert.match(again.message, /途中です/);
  const reset = h.c.exportLedgerReset();
  assert.equal(reset.ok, true);
  h.c.EXPORT_BUDGET_MS_ = 240000;
  assert.equal(h.c.exportLedgerForMigration().status, 'done');
});

test('書き出したものがそのまま D1 に取り込める', async () => {
  const { importBundle } = await import('../cf/lib/import.mjs');
  const h = fixture();
  h.c.exportLedgerForMigration();
  const parts = written(h).filter(f => f.name !== '_manifest.json').map(f => JSON.parse(f.body));
  const d1 = d1h.createD1();
  const result = await importBundle(d1, parts, { source: 'export-test' });
  assert.deepEqual(result.tables.flatMap(t => t.errors), [], '取り込めない表がある');
  assert.ok(result.ok, '件数が合わない: ' + JSON.stringify(result.tables.filter(t => !t.matches)));

  const rows = await d1.prepare('select id, date, start, min, done from slots').all();
  assert.deepEqual(rows.results, [{ id: 's1', date: '2026-09-25', start: '17:00', min: 60, done: 1 }], '日付と真偽がそのまま D1 に入る');
  const invoice = await d1.prepare('select "年月", "請求額" from "入金管理"').first();
  assert.deepEqual(invoice, { '年月': '2026-08', '請求額': 4500 }, '塾管理台帳も同じ経路で入る');
});
