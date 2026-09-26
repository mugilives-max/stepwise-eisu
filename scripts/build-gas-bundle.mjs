// gas/*.gs を Worker から呼べる 1 つのモジュールにまとめる。
//
// なぜこうするか: GAS の計算（studentState_ など）は素の JavaScript で、Google のサービスに
// 依存しているのはシートを読む所だけ。そこを D1 に差し替えれば同じコードがそのまま動く。
// 作り直さないので、返す JSON が変わらないことをコードの同一性で担保できる。
//
// 出力は cf/worker/generated/gas.mjs（Git には入れない）。wrangler の build.command で
// 毎回作り直すので、gas/*.gs を直したら Worker 側にも自動で反映される。
// 中身は「サービスを受け取って GAS の関数一式を返す入れ物」。1 リクエストに 1 つ作る
// （GAS の実行ごとの状態、MEMO_ などをリクエストごとに分けるため）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAS_DIR = path.join(ROOT, 'gas');
const OUT = path.join(ROOT, 'cf', 'worker', 'generated', 'gas.mjs');

// GAS が使う Google のサービス。Worker 側から同じ名前で渡す。
// 読み取りに要らないものは、呼ばれたら分かるように「使えない」という値を渡す。
export const SERVICE_NAMES = [
  'SpreadsheetApp', 'Utilities', 'CacheService', 'PropertiesService', 'LockService',
  'ContentService', 'MimeType', 'Session', 'MailApp', 'CalendarApp', 'DriveApp',
  'ScriptApp', 'UrlFetchApp', 'Logger', 'HtmlService', 'console',
  // 高度なサービス。カレンダー登録は Calendar.Events.insert を使う
  'Calendar',
  // 時計も差し替えられるようにする（並走テストで GAS 側と同じ時刻に固定するため）
  'Date',
];

export function sourceFiles() {
  return fs.readdirSync(GAS_DIR).filter(n => n.endsWith('.gs'))
    .sort((a, b) => (a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b)));
}

// 先頭が function / var のものを「外から呼べる名前」として集める。
// var は値そのものではなく読み書きできる形で返す（LITE_ のように、呼び出し側が
// 切り替えてから関数を呼ぶものがあるため。値をコピーすると切り替わらない）。
export function topLevelNames(source) {
  const functions = new Set();
  const vars = new Set();
  for (const m of source.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) functions.add(m[1]);
  for (const m of source.matchAll(/^var\s+([A-Za-z_$][\w$]*)/gm)) if (!functions.has(m[1])) vars.add(m[1]);
  const keep = n => !SERVICE_NAMES.includes(n);
  return { functions: [...functions].filter(keep).sort(), vars: [...vars].filter(keep).sort() };
}

export function build() {
  const files = sourceFiles();
  const source = files.map(n => `/* ===== gas/${n} ===== */\n` + fs.readFileSync(path.join(GAS_DIR, n), 'utf8')).join('\n');
  const { functions, vars } = topLevelNames(source);
  const head = `// 自動生成（scripts/build-gas-bundle.mjs）。直接編集しない。元は gas/*.gs。
// 取り込み元: ${files.join(', ')}
/* eslint-disable */
export function createGas(services) {
  ${SERVICE_NAMES.map(n => `var ${n} = services.${n};`).join('\n  ')}
`;
  const members = functions.map(n => `    ${n},`)
    .concat(vars.map(n => `    get ${n}() { return ${n}; }, set ${n}(v) { ${n} = v; },`));
  const tail = `\n  return {\n${members.join('\n')}\n  };\n}\n`;
  return { code: head + source + tail, files, names: functions.concat(vars) };
}

// cf/migrations/*.sql から「表ごとの列」を取り出す。
// Worker では列名を問い合わせで調べられない（D1 は PRAGMA を断る）ので、
// ここで作った表を使う。まとめて 1 回で台帳を読むためにも要る。
export function schemaMap() {
  const dir = path.join(ROOT, 'cf', 'migrations');
  const sql = fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()
    .map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
  const stripped = sql.replace(/--[^\n]*/g, '');
  const out = {}, internal = new Set();
  const table = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\(([\s\S]*?)\n\);/g;
  for (const m of stripped.matchAll(table)) {
    const name = m[1] || m[2];
    const columns = [];
    for (const line of m[3].split('\n')) {
      const t = line.trim();
      if (!t || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(t)) continue;
      const c = /^(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+([A-Za-z]+)([^,]*)/.exec(t);
      if (!c) continue;
      const rest = c[4] || '';
      const def = /DEFAULT\s+(-?\d+)/i.exec(rest);
      columns.push({
        name: c[1] || c[2],
        type: /^INT/i.test(c[3]) ? 'INTEGER' : 'TEXT',
        notNull: /NOT\s+NULL/i.test(rest) || /PRIMARY\s+KEY/i.test(rest),
        isPk: /PRIMARY\s+KEY/i.test(rest),
        defaultValue: def ? Number(def[1]) : 0,
      });
    }
    // シートの写しである表だけを載せる。Worker 自身の表（_ledger, _effects, pushSubs …）は
    // 台帳の読み書きの対象ではないので外す。目印は写しの管理列 _sheetRow
    if (columns.length && columns.some(c => c.name === '_sheetRow')) out[name] = columns;
    else internal.add(name);
  }
  for (const m of stripped.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+(TEXT|INTEGER|REAL)\s+NOT NULL\s+DEFAULT\s+(?:''|(-?\d+))\s*;/gi)) {
    if (internal.has(m[1])) continue;
    if (!out[m[1]]) throw new Error('Unknown table in additive migration: ' + m[1]);
    out[m[1]].push({name:m[2],type:m[3].toUpperCase(),isPk:false,defaultValue:m[4] ? Number(m[4]) : 0});
  }
  return out;
}

export function generate() {
  const { code, files, names } = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const write = (file, body) => {
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (previous !== body) fs.writeFileSync(file, body, 'utf8');
    return previous !== body;
  };
  const schema = schemaMap();
  const schemaFile = path.join(path.dirname(OUT), 'schema.mjs');
  const schemaBody = [
    '// 自動生成（scripts/build-gas-bundle.mjs）。元は cf/migrations/*.sql。',
    '// D1 は PRAGMA を実行できないので、表ごとの列はここから読む。',
    'export const TABLE_SCHEMA = ' + JSON.stringify(schema, null, 2) + ';',
    'export const TABLE_COLUMNS = Object.fromEntries(Object.entries(TABLE_SCHEMA).map(([t, cs]) => [t, cs.map(c => c.name)]));',
    '',
  ].join('\n');
  const changed = write(OUT, code) | write(schemaFile, schemaBody);
  return { out: OUT, files: files.length, names: names.length, bytes: code.length, tables: Object.keys(schema).length, changed: !!changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = generate();
  console.log(`gas/*.gs ${r.files} ファイル・関数 ${r.names} 個を ${path.relative(ROOT, r.out)} にまとめました（${Math.round(r.bytes / 1024)}KB${r.changed ? '' : '・変更なし'}）`);
  console.log(`表ごとの列 ${r.tables} 表を generated/schema.mjs に書きました`);
}
