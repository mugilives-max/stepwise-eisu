// 台帳（スプレッドシート）の書き出しを D1 に入れる。
//
// 入力は「書き出しの束(bundle)」: シート 1 枚につき 1 つの
//   { book:'app'|'ledger', sheet:'slots', headers:[...], rows:[[...]], offset:0 }
// という形。どの手段で書き出したか（手作業の CSV でも、GAS からの取得でも）に依らない。
//
// 値の直し方は D1 のスキーマ自身から決める（pragma table_info 相当）。型表を二重に持たない。
//   INTEGER 列  … '' はその列の既定値、'true'/'false' は 1/0、それ以外は数値
//   INTEGER 可空 … '' は NULL（0 と区別する列だけこの形にしてある）
//   TEXT 列     … 文字列。先頭の ' は Sheets の文字列化の名残なので剥がす
// 何度流しても同じ結果になる（主キーで置き換える）。

const BOOL_TEXT = new Map([['true', 1], ['false', 0], ['TRUE', 1], ['FALSE', 0], ['はい', 1], ['いいえ', 0]]);

// GAS が読まない「人が見るための表」。台帳にはあるが業務データの正本ではないので取り込まない。
// 移行後はスプレッドシート側を D1 から書き出して作り直す対象（docs/D1_MIGRATION.md 段階 D）。
//   一覧 … 授業（slots）を日付・生徒・科目で並べただけの一覧
export const VIEW_SHEETS = ['一覧'];

// Sheets は =+@- で始まる文字列の前に ' を足して数式化を防ぐ。読むときは剥がす。
export function unquoteCell(value) {
  return typeof value === 'string' && value.length > 1 && value[0] === "'" && '=+@-'.includes(value[1]) ? value.slice(1) : value;
}

// スプレッドシートの「時刻だけ」のセルは 1899-12-30 という基準日で保存される。
// 古い書き出し（この基準日を落とさなかったもの）でも HH:MM になるようここでも直す。
// GAS 側の normTime_ と同じ結果にそろえる。
const TIME_EPOCH = /^1899-12-30[ T](\d{2}:\d{2})(:\d{2})?$/;
export function unepochTime(value) {
  const m = typeof value === 'string' ? TIME_EPOCH.exec(value) : null;
  return m ? m[1] : value;
}

// 日付そのもの（GAS のコードが new Date() で書いた値）は、書き出しと同じ形にそろえる。
// そのまま String() にすると地域表記（Mon Sep 07 2026 ...）になり、取り込んだ台帳と形が変わる。
const TOKYO = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function dateCell(value) {
  const p = Object.fromEntries(TOKYO.formatToParts(value).map(x => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`, time = `${p.hour}:${p.minute}:${p.second}`;
  if (day === '1899-12-30') return `${p.hour}:${p.minute}`;       // 時刻だけのセル
  return time === '00:00:00' ? day : `${day} ${time}`;
}

export function normalizeCell(value, column) {
  const raw = value instanceof Date ? dateCell(value) : unquoteCell(value);
  if (column.type === 'INTEGER') {
    if (raw === '' || raw === null || raw === undefined) return column.notNull ? column.defaultValue : null;
    if (raw === true) return 1;
    if (raw === false) return 0;
    if (typeof raw === 'string' && BOOL_TEXT.has(raw)) return BOOL_TEXT.get(raw);
    const n = Number(raw);
    if (!Number.isFinite(n)) return column.notNull ? column.defaultValue : null;
    return Math.trunc(n);
  }
  if (raw === null || raw === undefined) return '';
  if (raw === true) return 'true';
  if (raw === false) return 'false';
  return unepochTime(String(raw));
}

// D1/SQLite から表の列とその既定値を読む。
// Worker では PRAGMA を実行できないので、呼び出し側が列の情報を渡す（cf/worker/generated/schema.mjs）。
export async function readTableColumns(db, table, known) {
  if (known && known[table]) return known[table];
  return readTableColumnsViaPragma(db, table);
}

async function readTableColumnsViaPragma(db, table) {
  const { results } = await db.prepare(`pragma table_info(${quoteIdent(table)})`).all();
  return results.map(r => ({
    name: String(r.name),
    type: String(r.type || '').toUpperCase().startsWith('INT') ? 'INTEGER' : 'TEXT',
    notNull: Number(r.notnull) === 1,
    isPk: Number(r.pk) > 0,
    defaultValue: defaultOf(r.dflt_value),
  }));
}

function defaultOf(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  return 0;
}

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export async function tableExists(db, table) {
  const row = await db.prepare("select name from sqlite_master where type='table' and name = ?").bind(table).first();
  return !!row;
}

/** 束を 1 つ取り込む。戻り値は {table, inserted, skippedColumns, errors}。 */
export async function importSheet(db, part, opts = {}) {
  const table = String(part.sheet || '');
  const syncedAt = opts.syncedAt || new Date().toISOString();
  const out = { table, book: String(part.book || 'app'), rows: 0, skippedColumns: [], errors: [], skipped: false };
  const ignore = opts.ignoreSheets || VIEW_SHEETS;
  if (ignore.indexOf(table) >= 0) {
    out.skipped = true;
    out.note = '人が見るための表なので取り込まない';
    return out;
  }
  if (!(await tableExists(db, table))) {
    out.errors.push(`D1 にこのシートに対応する表がありません: ${table}`);
    return out;
  }
  const columns = await readTableColumns(db, table, opts.schema);
  const byName = new Map(columns.map(c => [c.name, c]));
  const headers = (part.headers || []).map(String);

  // シートにあって D1 に無い列は取り込まない（見出しの追加は移行の見直しが要る）
  const used = [];
  headers.forEach((h, i) => {
    if (h === '') return;
    const col = byName.get(h);
    if (!col) { out.skippedColumns.push(h); return; }
    used.push({ index: i, column: col });
  });

  // 主キーが無い表（log / mcpLog / 台帳の履歴系）は連番で入れる
  const hasOwnPk = columns.some(c => c.isPk && c.name !== 'rowid_');
  const target = used.map(u => u.column.name).concat(['_syncedAt', '_sheetRow']);
  const placeholders = target.map(() => '?').join(', ');
  const verb = hasOwnPk ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
  const sql = `${verb} ${quoteIdent(table)} (${target.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;

  const offset = Number(part.offset || 0);
  const statements = [];
  (part.rows || []).forEach((row, i) => {
    const values = used.map(u => normalizeCell(row[u.index], u.column));
    values.push(syncedAt, 2 + offset + i);
    statements.push(db.prepare(sql).bind(...values));
  });

  const size = Number(opts.batchSize || 200);
  for (let i = 0; i < statements.length; i += size) {
    const chunk = statements.slice(i, i + size);
    try {
      await db.batch(chunk);
      out.rows += chunk.length;
    } catch (e) {
      out.errors.push(`${table}: ${(e && e.message) || e}`);
      break;
    }
  }
  return out;
}

/** 束をまとめて取り込み、件数を突き合わせる。 */
export async function importBundle(db, parts, opts = {}) {
  const started = new Date().toISOString();
  const results = [];
  for (const part of parts) results.push(await importSheet(db, part, { ...opts, syncedAt: opts.syncedAt || started }));

  const byTable = new Map();
  for (const r of results) {
    const cur = byTable.get(r.table) || { table: r.table, book: r.book, imported: 0, errors: [], skippedColumns: [], skipped: false, note: '' };
    cur.imported += r.rows;
    cur.errors.push(...r.errors);
    if (r.skipped) { cur.skipped = true; cur.note = r.note || ''; }
    for (const c of r.skippedColumns) if (!cur.skippedColumns.includes(c)) cur.skippedColumns.push(c);
    byTable.set(r.table, cur);
  }

  const summary = [];
  for (const entry of byTable.values()) {
    if (entry.skipped) { summary.push({ ...entry, stored: null, matches: true }); continue; }
    let stored = null;
    if (await tableExists(db, entry.table)) {
      const row = await db.prepare(`select count(*) as n from ${quoteIdent(entry.table)}`).first();
      stored = row ? Number(row.n) : 0;
    }
    summary.push({ ...entry, stored, matches: stored === entry.imported });
  }
  const finished = new Date().toISOString();
  if (await tableExists(db, '_importRuns')) {
    await db.prepare('insert into _importRuns (startedAt, finishedAt, source, summary) values (?, ?, ?, ?)')
      .bind(started, finished, String(opts.source || ''), JSON.stringify(summary.map(s => ({ t: s.table, n: s.imported, stored: s.stored })))).run();
  }
  return { startedAt: started, finishedAt: finished, tables: summary, ok: summary.every(s => s.matches && !s.errors.length) };
}
