// D1 の最小互換シム。node:sqlite のメモリDBに cf/migrations/*.sql を当て、
// env.DB と同じ形（prepare/bind/first/all/run/batch/exec）を返す。
// これで wrangler を起動せずに node --test から Worker とスキーマを検証できる。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'cf', 'migrations');

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS)) return [];
  return fs.readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()
    .map(n => ({ name: n, sql: fs.readFileSync(path.join(MIGRATIONS, n), 'utf8') }));
}

function meta(started, changes) {
  return { duration: Date.now() - started, changes: changes || 0, last_row_id: 0, rows_read: 0, rows_written: 0 };
}

// 0 件のときでも列名を返せるように、問い合わせ先の表から列名を引く
function columnsOf(db, sql) {
  const m = /from\s+"?([^\s"]+)"?/i.exec(sql);
  if (!m) return [];
  try { return db.prepare(`pragma table_info(${JSON.stringify(m[1]).replace(/"/g, '')})`).all().map(r => r.name); }
  catch (e) { return []; }
}

function statement(db, sql, bound) {
  const withArgs = args => statement(db, sql, args);
  const prep = () => db.prepare(sql);
  return {
    _isSelect: /^\s*select/i.test(sql),
    bind: (...args) => withArgs(args),
    async first(column) {
      const row = prep().get(...bound) || null;
      if (row && column !== undefined) return row[column] === undefined ? null : row[column];
      return row ? { ...row } : null;
    },
    async all() {
      const started = Date.now();
      const results = prep().all(...bound).map(r => ({ ...r }));
      return { results, success: true, meta: meta(started, 0) };
    },
    async run() {
      const started = Date.now();
      const r = prep().run(...bound);
      return { results: [], success: true, meta: { ...meta(started, Number(r.changes || 0)), last_row_id: Number(r.lastInsertRowid || 0) } };
    },
    // D1 と同じく、columnNames を指定すると 1 行目が列名になる
    async raw(options) {
      const rows = prep().all(...bound);
      const names = rows.length ? Object.keys(rows[0]) : columnsOf(db, sql);
      const body = rows.map(r => names.map(n => r[n]));
      return options && options.columnNames ? (names.length ? [names, ...body] : []) : body;
    },
  };
}

// migrate:false で空のDBを作れる（マイグレーション自体を検証するとき用）
function createD1(opts) {
  const db = new DatabaseSync(':memory:');
  db.exec('pragma foreign_keys = on');
  const applied = [];
  if (!opts || opts.migrate !== false) {
    for (const m of migrationFiles()) { db.exec(m.sql); applied.push(m.name); }
  }
  const binding = {
    prepare: sql => statement(db, sql, []),
    // D1 と同じく、select は結果を返し、それ以外は実行結果を返す
    async batch(stmts) {
      const out = [];
      db.exec('begin');
      try { for (const s of stmts) out.push(s._isSelect ? await s.all() : await s.run()); db.exec('commit'); }
      catch (e) { db.exec('rollback'); throw e; }
      return out;
    },
    async exec(sql) { db.exec(sql); return { count: 0, duration: 0 }; },
    _sqlite: db,
    _applied: applied,
  };
  return binding;
}

function tables(d1) {
  return d1._sqlite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'd1_%' order by name").all().map(r => r.name);
}
function columns(d1, table) {
  return d1._sqlite.prepare(`pragma table_info(${JSON.stringify(table).replace(/"/g, '')})`).all().map(r => r.name);
}
function indexes(d1) {
  return d1._sqlite.prepare("select name, tbl_name from sqlite_master where type='index' and name not like 'sqlite_%' order by name").all();
}

module.exports = { createD1, migrationFiles, tables, columns, indexes };
