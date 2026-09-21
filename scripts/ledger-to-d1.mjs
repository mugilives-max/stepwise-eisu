// 台帳の書き出しをテスト用 D1（手元の SQLite ファイル）に取り込む。
//
//   node scripts/ledger-to-d1.mjs --bundle <書き出しフォルダ> [--db <出力.sqlite>] [--sql <出力.sql>] [--reset]
//
// 書き出しフォルダに入れるもの（どちらでもよい。混在も可）
//   app.slots.json      … { "sheet":"slots", "headers":[...], "rows":[[...]], "offset":0 }
//   ledger.入金管理.csv … 1 行目が見出しの CSV（スプレッドシートの「CSV をダウンロード」そのまま）
//   ファイル名は <app|ledger>.<シート名>.<json|csv>
//
// 何もネットワークへ送らない。読むのは指定したフォルダ、書くのは指定した SQLite ファイルだけ。
// 本番 D1 へは入れない（--sql で出した SQL を wrangler で流す運用にする。docs/D1_MIGRATION.md）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { importBundle, quoteIdent } from '../cf/lib/import.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'cf', 'migrations');

function args(argv) {
  const out = { bundle: '', db: path.join(ROOT, '.wrangler', 'test-d1.sqlite'), sql: '', reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--sql') out.sql = argv[++i];
    else if (a === '--reset') out.reset = true;
    else throw new Error('知らない引数です: ' + a);
  }
  if (!out.bundle) throw new Error('--bundle に書き出しフォルダを指定してください');
  return out;
}

// RFC4180 の CSV。改行とカンマを含むセル、"" の連続に対応する
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readBundle(dir) {
  const parts = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const m = /^(app|ledger)\.(.+)\.(json|csv)$/.exec(name);
    if (!m) { if (/\.(json|csv)$/.test(name) && !name.startsWith('_')) console.warn('  名前が <app|ledger>.<シート>.<json|csv> でないので飛ばします: ' + name); continue; }
    const [, book, sheet, ext] = m;
    if (ext === 'json') {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const list = Array.isArray(data) ? data : [data];
      for (const p of list) parts.push({ book: p.book || book, sheet: p.sheet || sheet, headers: p.headers || [], rows: p.rows || [], offset: p.offset || 0 });
    } else {
      const rows = parseCsv(fs.readFileSync(full, 'utf8'));
      parts.push({ book, sheet, headers: (rows[0] || []).map(String), rows: rows.slice(1), offset: 0 });
    }
  }
  return parts;
}

// node:sqlite を D1 と同じ形で使う（cf/lib/import.mjs は D1 の binding しか知らない）
function d1Over(db) {
  const stmt = (sql, bound) => ({
    bind: (...a) => stmt(sql, a),
    async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
    async all() { return { results: db.prepare(sql).all(...bound).map(r => ({ ...r })), success: true, meta: {} }; },
    async run() { const r = db.prepare(sql).run(...bound); return { success: true, meta: { changes: Number(r.changes || 0) } }; },
  });
  return {
    prepare: sql => stmt(sql, []),
    async batch(list) { db.exec('begin'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('commit'); return out; } catch (e) { db.exec('rollback'); throw e; } },
    async exec(sql) { db.exec(sql); return { count: 0 }; },
  };
}

function migrate(db) {
  const applied = db.prepare("select count(*) as n from sqlite_master where type='table' and name='students'").get();
  if (Number(applied.n) > 0) return [];
  const names = fs.readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort();
  for (const n of names) db.exec(fs.readFileSync(path.join(MIGRATIONS, n), 'utf8'));
  return names;
}

// 本番 D1 へ流すための SQL。値は SQLite のリテラルに直す
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function emitSql(db, file) {
  const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name <> '_importRuns' order by name").all().map(r => r.name);
  const out = [];
  for (const t of tables) {
    const rows = db.prepare(`select * from ${quoteIdent(t)}`).all();
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    out.push(`-- ${t}: ${rows.length} 行`);
    for (const r of rows) out.push(`INSERT OR REPLACE INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(c => sqlLiteral(r[c])).join(', ')});`);
  }
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return out.length;
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (!fs.existsSync(opt.bundle)) throw new Error('書き出しフォルダがありません: ' + opt.bundle);
  fs.mkdirSync(path.dirname(opt.db), { recursive: true });
  if (opt.reset && fs.existsSync(opt.db)) fs.rmSync(opt.db);

  const parts = readBundle(opt.bundle);
  if (!parts.length) throw new Error('取り込めるファイルがありません（<app|ledger>.<シート>.<json|csv>）');
  console.log(`書き出し: ${parts.length} シート分を ${opt.bundle} から読みました`);

  const db = new DatabaseSync(opt.db);
  const applied = migrate(db);
  if (applied.length) console.log('スキーマを作りました: ' + applied.join(', '));

  const result = await importBundle(d1Over(db), parts, { source: path.basename(opt.bundle) });

  const width = Math.max(...result.tables.map(t => t.table.length), 6);
  console.log('\n' + '表'.padEnd(width) + '  書き出し  D1     判定');
  for (const t of result.tables.sort((a, b) => a.table.localeCompare(b.table))) {
    const mark = t.errors.length ? '×' : t.skipped ? '対象外' : t.matches ? 'ok' : '不一致';
    console.log(t.table.padEnd(width) + '  ' + String(t.skipped ? '-' : t.imported).padStart(7) + '  ' + String(t.skipped ? '-' : t.stored).padStart(6) + '  ' + mark + (t.note ? '（' + t.note + '）' : ''));
    for (const e of t.errors) console.log('   ! ' + e);
    if (t.skippedColumns.length) console.log('   ! D1 に無い列を飛ばしました: ' + t.skippedColumns.join(', '));
  }

  if (opt.sql) {
    const lines = emitSql(db, opt.sql);
    console.log(`\n本番 D1 用の SQL を書きました: ${opt.sql}（${lines} 行）`);
    console.log('  流すとき: npx wrangler d1 execute DB --config cf/wrangler.jsonc --remote --file ' + opt.sql);
  }
  db.close();

  console.log('\n' + (result.ok ? '取り込み完了。件数はすべて一致しています。' : '件数の合わない表があります。上の一覧を確認してください。'));
  console.log('取り込み先: ' + opt.db);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('失敗: ' + (e && e.message || e)); process.exitCode = 1; });
}
