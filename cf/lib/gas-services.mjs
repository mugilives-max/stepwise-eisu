// GAS のコードに渡す「Google のサービス」の代わり。読み取り専用。
//
// 台帳は D1 から作った値の入れ物で、書き込みはすべて例外にする。読み取りのつもりの経路が
// うっかり書こうとしたら、黙って何もしないのではなく、その場で止めて気づけるようにする。
// （GAS には ensureSchema_ や一度きりの移行処理のように、読みながら書く経路がある。
//   Worker ではそれらを呼ばない。呼んでしまったらここで落ちる。）

import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

class ReadOnlyLedger extends Error {}

// GAS は 0〜255 ではなく符号付き（-128〜127）のバイトを返す。同じ形にそろえる
const signedBytes = buffer => Array.from(buffer, v => (v > 127 ? v - 256 : v));
// GAS の引数は文字列か符号付きバイト列
const toBytes = value => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.map(v => (v + 256) % 256)));
const algorithmName = algorithm => (String(algorithm || 'sha256').toLowerCase().includes('256') ? 'sha256' : String(algorithm).toLowerCase());

function refuse(what) {
  throw new ReadOnlyLedger('Worker の読み取りでは台帳に書き込めません: ' + what);
}

// 書き込みを許すかどうかは本ごとに決める。許した場合は値を書き換え、
// 触ったシートの名前を控える（あとでその分だけ D1 へ流す）。
function range(sheet, row, column, rows, columns, write) {
  const read = () => Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => sheet.values[row + r - 1]?.[column + c - 1] ?? ''));
  const put = values => {
    if (!write) return refuse('Range.setValues');
    if (values.length !== rows || values.some(r => r.length !== columns)) throw new Error('Range dimensions do not match values');
    values.forEach((r, ri) => r.forEach((value, ci) => {
      const target = row + ri - 1;
      sheet.values[target] ||= [];
      // Sheets は文字列化の目印にした先頭の ' を取り込む
      sheet.values[target][column + ci - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
    }));
    write();
    return null;
  };
  return {
    getValues: read,
    getDisplayValues: () => read().map(r => r.map(v => (v === null || v === undefined ? '' : String(v)))),
    getValue: () => read()[0][0],
    getNumRows: () => rows,
    getNumColumns: () => columns,
    getFormulas: () => read().map(r => r.map(() => '')),
    setValues(values) { put(values); return this; },
    setValue(value) { put(Array.from({ length: rows }, () => Array(columns).fill(value))); return this; },
    setNumberFormat() { return write ? this : refuse('Range.setNumberFormat'); },
    setNumberFormats() { return write ? this : refuse('Range.setNumberFormats'); },
    clearContent() { put(Array.from({ length: rows }, () => Array(columns).fill(''))); return this; },
  };
}

function sheetOf(name, values, write) {
  const sheet = {
    values,
    getName: () => name,
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(0, ...values.map(r => r.length)),
    getMaxColumns: () => Math.max(26, sheet.getLastColumn()),
    getRange: (row, column, rows = 1, columns = 1) => range(sheet, row, column, rows, columns, write),
    getDataRange: () => range(sheet, 1, 1, Math.max(1, values.length), Math.max(1, sheet.getLastColumn()), write),
    appendRow(row) { if (!write) return refuse('Sheet.appendRow'); values.push([...row]); write(); return sheet; },
    deleteRow(row) { if (!write) return refuse('Sheet.deleteRow'); values.splice(row - 1, 1); write(); return sheet; },
    insertColumnsAfter() { return write ? sheet : refuse('Sheet.insertColumnsAfter'); },
    setFrozenRows() { return write ? sheet : refuse('Sheet.setFrozenRows'); },
  };
  return sheet;
}

/**
 * 台帳 1 冊。onWrite を渡すと書き込みを許し、触ったシート名をその関数へ知らせる。
 * 渡さなければ読み取り専用（書こうとしたら例外）。
 */
export function bookOf(sheets, onWrite) {
  const map = new Map();
  const touch = name => (onWrite ? () => onWrite(name) : null);
  for (const [name, values] of Object.entries(sheets)) map.set(name, sheetOf(name, values, touch(name)));
  return {
    getId: () => 'ledger',
    getSheetByName: name => map.get(name) || null,
    getSheets: () => [...map.values()],
    insertSheet(name) {
      if (!onWrite) return refuse('Spreadsheet.insertSheet(' + name + ')');
      if (map.has(name)) throw new Error('Sheet already exists: ' + name);
      const sheet = sheetOf(name, [], touch(name));
      map.set(name, sheet);
      onWrite(name);
      return sheet;
    },
  };
}

export const readOnlyBook = sheets => bookOf(sheets, null);

// 触られたら、どのサービスの何を呼んだのかを名指しで止める
function forbidden(service) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => refuse(service + '.' + String(prop));
    },
  });
}

function formatDate(date, timezone, format) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return format.replace(/yyyy|MM|dd|HH|mm|ss|M|d/g, token => ({
    yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second,
    M: String(+parts.month), d: String(+parts.day),
  })[token]);
}

/**
 * GAS に渡すサービス一式を作る。
 *   books      … { app: {シート名: 値}, ledger: {…} }（cf/lib/sheet-view.mjs の books()）
 *   properties … 台帳に入らない設定値。読み取りだけ。書こうとしたら止める
 */
/**
 * GAS に渡すサービス一式を作る。
 *   mutable … true にすると台帳に書ける。触ったシート名は戻り値の touched に入る
 *   record  … true にすると Google のサービス（メール・カレンダー等）を止めずに、
 *             呼ばれた記録だけ残す。「この書き込みは Google を使うか」の調査に使う
 */
export function createServices({ books, properties = {}, now = null, mutable = false, record = false, effects = false }) {
  const cache = new Map();
  // 時計。既定は実時刻。now を渡すとその時刻で固定する（並走テスト用）
  const Clock = now === null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const touched = new Set();
  const calls = [];
  // effects: メール・カレンダーを「あとで Apps Script に頼む」ために控える。
  // GAS のコードは同期的に結果を待つので、カレンダーには仮の予定 ID（pending-…）を返し、
  // 本物の ID は付随処理が終わってから書き戻す（cf/worker/write.mjs）。
  const queued = [];
  const pendingId = () => 'pending-' + crypto.randomUUID().replace(/-/g, '');
  const onWrite = mutable ? name => touched.add(name) : null;
  const app = bookOf(books.app || {}, onWrite);
  const ledger = bookOf(books.ledger || {}, onWrite);
  // record のときは、止める代わりに「何が呼ばれたか」を残す
  const external = service => (record
    ? new Proxy({}, { get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return (...args) => { calls.push({ service, method: String(prop), args: args.length }); return externalResult(service, String(prop)); };
      } })
    : forbidden(service));
  return {
    _touched: touched,
    _calls: calls,
    _effects: queued,
    _books: books,
    Date: Clock,
    SpreadsheetApp: {
      getActive: () => app,
      getActiveSpreadsheet: () => app,
      openById: () => ledger,
      flush() {},
    },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      DigestAlgorithm: { SHA_256: 'sha256' },
      MacAlgorithm: { HMAC_SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // 保護者ページの読み取りは、セッションの照合で SHA-256 を使う（parentDigest_ → hashPass_）。
      // GAS は符号付きのバイト列を返すので、そこまで同じ形にそろえる。
      computeDigest: (algorithm, data) => signedBytes(createHash(algorithmName(algorithm)).update(toBytes(data)).digest()),
      computeHmacSha256Signature: (data, key) => signedBytes(createHmac('sha256', toBytes(key)).update(toBytes(data)).digest()),
      computeHmacSignature: (algorithm, data, key) => signedBytes(createHmac(algorithmName(algorithm), toBytes(key)).update(toBytes(data)).digest()),
      base64Encode: data => toBytes(data).toString('base64'),
      base64EncodeWebSafe: data => toBytes(data).toString('base64url'),
      base64Decode: data => signedBytes(Buffer.from(String(data), 'base64')),
      newBlob: data => ({ getBytes: () => signedBytes(toBytes(data)) }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: key => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => { cache.set(key, String(value)); },
        remove: key => { cache.delete(key); },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (Object.prototype.hasOwnProperty.call(properties, key) ? String(properties[key]) : null),
        getProperties: () => ({ ...properties }),
        setProperty: () => refuse('PropertiesService.setProperty'),
        deleteProperty: () => refuse('PropertiesService.deleteProperty'),
      }),
    },
    // 読み取りでは排他は要らない（誰も書かない）
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }),
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    // 先生宛ての通知は Session の自分のメールに送る。Worker はそのアドレスを持たないので目印を返し、
    // Apps Script 側が自分の実アドレスに置き換える（先生のメールを Worker に置かない）
    Session: { getEffectiveUser: () => ({ getEmail: () => (effects ? 'TEACHER' : '') }) },
    Logger: { log() {} },
    console: { log() {}, warn() {}, error() {} },
    MailApp: effects
      ? { sendEmail(...args) {
            // (to, subject, body[, options]) と ({to,subject,body,name}) の両方の形がある
            const m = typeof args[0] === 'object' ? args[0] : { to: args[0], subject: args[1], body: args[2], ...(args[3] || {}) };
            queued.push({ kind: 'mail', to: String(m.to || ''), subject: String(m.subject || ''), body: String(m.body || ''), name: String(m.name || '') });
          },
          getRemainingDailyQuota: () => 100 }
      : external('MailApp'),
    CalendarApp: external('CalendarApp'),
    Calendar: effects
      ? { Events: {
            insert(body) { const id = pendingId(); queued.push({ kind: 'calendarCreate', marker: id + '@google.com', body, wantMeet: false }); return { id, iCalUID: id + '@google.com' }; },
            get(_cal, id) { return { id }; },
            patch(body, _cal, id) { const q = queued.find(e => e.kind === 'calendarCreate' && e.marker.startsWith(id + '@')); if (q && body && body.conferenceData) q.wantMeet = true; return {}; },
            remove(_cal, id) { const q = queued.findIndex(e => e.kind === 'calendarCreate' && e.marker.startsWith(id + '@')); if (q >= 0) queued.splice(q, 1); else queued.push({ kind: 'calendarDelete', eventId: String(id) }); return {}; },
          } }
      : record
      ? { Events: { insert: (...a) => { calls.push({ service: 'Calendar', method: 'Events.insert', args: a.length }); return { id: 'recorded-event', iCalUID: 'recorded-event@google.com' }; },
                    get: () => { calls.push({ service: 'Calendar', method: 'Events.get', args: 0 }); return {}; },
                    patch: () => { calls.push({ service: 'Calendar', method: 'Events.patch', args: 0 }); return {}; },
                    remove: () => { calls.push({ service: 'Calendar', method: 'Events.remove', args: 0 }); return {}; } } }
      : forbidden('Calendar'),
    DriveApp: external('DriveApp'),
    ScriptApp: external('ScriptApp'),
    UrlFetchApp: external('UrlFetchApp'),
    HtmlService: external('HtmlService'),
  };
}

// record のときに返す、当たり障りのない値
function externalResult(service, method) {
  if (service === 'MailApp' && method === 'getRemainingDailyQuota') return 100;
  if (service === 'Session') return { getEmail: () => '' };
  return undefined;
}

export { ReadOnlyLedger };
