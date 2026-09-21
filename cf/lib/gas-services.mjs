// GAS のコードに渡す「Google のサービス」の代わり。読み取り専用。
//
// 台帳は D1 から作った値の入れ物で、書き込みはすべて例外にする。読み取りのつもりの経路が
// うっかり書こうとしたら、黙って何もしないのではなく、その場で止めて気づけるようにする。
// （GAS には ensureSchema_ や一度きりの移行処理のように、読みながら書く経路がある。
//   Worker ではそれらを呼ばない。呼んでしまったらここで落ちる。）

class ReadOnlyLedger extends Error {}

function refuse(what) {
  throw new ReadOnlyLedger('Worker の読み取りでは台帳に書き込めません: ' + what);
}

function range(sheet, row, column, rows, columns) {
  const values = () => Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => sheet.values[row + r - 1]?.[column + c - 1] ?? ''));
  return {
    getValues: values,
    getDisplayValues: () => values().map(r => r.map(v => (v === null || v === undefined ? '' : String(v)))),
    getValue: () => values()[0][0],
    getNumRows: () => rows,
    getNumColumns: () => columns,
    getFormulas: () => values().map(r => r.map(() => '')),
    setValues: () => refuse('Range.setValues'),
    setValue: () => refuse('Range.setValue'),
    setNumberFormat: () => refuse('Range.setNumberFormat'),
    setNumberFormats: () => refuse('Range.setNumberFormats'),
    clearContent: () => refuse('Range.clearContent'),
  };
}

function sheetOf(name, values) {
  const sheet = {
    values,
    getName: () => name,
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(0, ...values.map(r => r.length)),
    getMaxColumns: () => Math.max(26, sheet.getLastColumn()),
    getRange: (row, column, rows = 1, columns = 1) => range(sheet, row, column, rows, columns),
    getDataRange: () => range(sheet, 1, 1, Math.max(1, values.length), Math.max(1, sheet.getLastColumn())),
    appendRow: () => refuse('Sheet.appendRow'),
    deleteRow: () => refuse('Sheet.deleteRow'),
    insertColumnsAfter: () => refuse('Sheet.insertColumnsAfter'),
    setFrozenRows: () => refuse('Sheet.setFrozenRows'),
  };
  return sheet;
}

export function readOnlyBook(sheets) {
  const map = new Map(Object.entries(sheets).map(([name, values]) => [name, sheetOf(name, values)]));
  return {
    getId: () => 'read-only',
    getSheetByName: name => map.get(name) || null,
    getSheets: () => [...map.values()],
    insertSheet: name => refuse('Spreadsheet.insertSheet(' + name + ')'),
  };
}

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
export function createServices({ books, properties = {}, now = null }) {
  const cache = new Map();
  // 時計。既定は実時刻。now を渡すとその時刻で固定する（並走テスト用）
  const Clock = now === null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const app = readOnlyBook(books.app || {});
  const ledger = readOnlyBook(books.ledger || {});
  return {
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
      // 読み取りの経路では使わない。使う経路（保護者のログインなど）を移すときに実装する
      computeDigest: () => refuse('Utilities.computeDigest'),
      computeHmacSha256Signature: () => refuse('Utilities.computeHmacSha256Signature'),
      computeHmacSignature: () => refuse('Utilities.computeHmacSignature'),
      base64Encode: () => refuse('Utilities.base64Encode'),
      base64EncodeWebSafe: () => refuse('Utilities.base64EncodeWebSafe'),
      base64Decode: () => refuse('Utilities.base64Decode'),
      newBlob: () => refuse('Utilities.newBlob'),
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
    Session: { getEffectiveUser: () => ({ getEmail: () => '' }) },
    Logger: { log() {} },
    console: { log() {}, warn() {}, error() {} },
    MailApp: forbidden('MailApp'),
    CalendarApp: forbidden('CalendarApp'),
    DriveApp: forbidden('DriveApp'),
    ScriptApp: forbidden('ScriptApp'),
    UrlFetchApp: forbidden('UrlFetchApp'),
    HtmlService: forbidden('HtmlService'),
  };
}

export { ReadOnlyLedger };
