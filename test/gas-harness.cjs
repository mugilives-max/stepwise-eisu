'use strict';

// An isolated Apps Script service double. Production Code.gs is evaluated unchanged
// for every request; sheets, cache and script properties persist between requests.
// No Google credentials, live sheets, network, email or calendar APIs are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

class Range {
  constructor(sheet, row, column, rows = 1, columns = 1) {
    Object.assign(this, { sheet, row, column, rows, columns });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.columns }, (_, c) => this.sheet.values[this.row + r - 1]?.[this.column + c - 1] ?? ''));
  }
  getDisplayValues() { return this.getValues().map(row => row.map(String)); }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    if (values.length !== this.rows || values.some(row => row.length !== this.columns)) throw new Error('Range dimensions do not match values');
    values.forEach((row, r) => row.forEach((value, c) => {
      const target = this.row + r - 1;
      this.sheet.values[target] ||= [];
      // Sheets consumes a leading apostrophe used as a literal-text marker.
      this.sheet.values[target][this.column + c - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
    }));
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setNumberFormat() { return this; }
  clearContent() { return this.setValues(Array.from({ length: this.rows }, () => Array(this.columns).fill(''))); }
}

class Sheet {
  constructor(name, values = []) { this.name = name; this.values = values.map(row => [...row]); }
  getName() { return this.name; }
  getLastRow() { return this.values.length; }
  getLastColumn() { return Math.max(0, ...this.values.map(row => row.length)); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(row, column, rows, columns) { return new Range(this, row, column, rows, columns); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.values.push([...row]); return this; }
  deleteRow(row) { this.values.splice(row - 1, 1); return this; }
  setFrozenRows() { return this; }
  insertColumnsAfter() { return this; }
}

class Spreadsheet {
  constructor(initial = {}) { this.sheets = new Map(Object.entries(initial).map(([name, values]) => [name, new Sheet(name, values)])); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error('Sheet already exists: ' + name);
    const sheet = new Sheet(name); this.sheets.set(name, sheet); return sheet;
  }
}

const STUDENTS = [
  ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly', 'parentToken', 'parentExp'],
  ['test-a', '【テスト】保護者認証A', true, '', 'synthetic-link-a', 1500, '', 'legacy-parent-token-a', '9999999999999'],
  ['test-b', '【テスト】保護者認証B', true, '', 'synthetic-link-b', 1500, '', '', ''],
  ['test-inactive', '【テスト】停止中', false, '', 'synthetic-link-inactive', 1500, '', '', '']
];
const TEACHER_TOKEN = 'synthetic-teacher-token-only-for-test';
const TEACHER_PASSWORD = 'SyntheticTeacherPassword!';
const MCP_KEY = 'synthetic-mcp-key-only-for-test';

function createHarness(options = {}) {
  let now = Date.parse('2026-09-07T04:00:00Z');
  const teacherSalt = 'synthetic-teacher-salt';
  const spreadsheet = new Spreadsheet({
    config: [['key', 'value'], ['passSalt', teacherSalt], ['passHash', crypto.createHash('sha256').update(teacherSalt + ':' + TEACHER_PASSWORD).digest('hex')],
      ['adminToken', TEACHER_TOKEN], ['adminTokenExp', String(now + 90 * 86400000)], ['teacherEmail', 'teacher@example.invalid'],
      ['calendarSync', 'off'], ['emailNotify', 'off'], ['pin', '0000']],
    students: STUDENTS,
    slots: [['id', 'date', 'start', 'min', 'status', 'studentId', 'done', 'eventId', 'meetUrl', 'subject', 'req']],
    blocked: [['id', 'studentId', 'date', 'note', 'start', 'end']],
    log: [['time', 'message']]
  });
  const ledger = new Spreadsheet();
  const cacheValues = new Map();
  const properties = new Map([['MCP_KEY', MCP_KEY]]);
  const effects = [];
  const cache = {
    get(key) { const item = cacheValues.get(key); return item && item.expires > now ? item.value : null; },
    put(key, value, seconds = 600) { cacheValues.set(key, { value: String(value), expires: now + seconds * 1000 }); },
    remove(key) { cacheValues.delete(key); }
  };
  const source = fs.readdirSync(path.resolve(__dirname, '../gas')).filter(name => name.endsWith('.gs'))
    .sort((a, b) => a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b))
    .map(name => fs.readFileSync(path.resolve(__dirname, '../gas', name), 'utf8')).join('\n');
  function context() {
    class ClockDate extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    }
    const signedBytes = data => Array.from(data, v => v > 127 ? v - 256 : v);
    const toBytes = value => typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.map(v => (v + 256) % 256));
    function formatDate(date, timezone, format) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(part => [part.type, part.value]));
      return format.replace(/yyyy|MM|dd|HH|mm|ss|M|d/g, token => ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, M: String(+parts.month), d: String(+parts.day) })[token]);
    }
    const sandbox = {
      Date: ClockDate, TextEncoder, TextDecoder,
      SpreadsheetApp: { getActive: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet, openById: () => ledger, flush() {} },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' }, MacAlgorithm: { HMAC_SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
        getUuid: () => crypto.randomUUID(), formatDate, sleep() {},
        computeDigest: (algorithm, data) => signedBytes(crypto.createHash(algorithm).update(toBytes(data)).digest()),
        computeHmacSha256Signature: (data, key) => signedBytes(crypto.createHmac('sha256', toBytes(key)).update(toBytes(data)).digest()),
        computeHmacSignature: (algorithm, data, key) => signedBytes(crypto.createHmac(algorithm, toBytes(key)).update(toBytes(data)).digest()),
        base64Encode: data => toBytes(data).toString('base64'),
        base64EncodeWebSafe: data => toBytes(data).toString('base64url'),
        base64Decode: data => signedBytes(Buffer.from(data, 'base64')),
        newBlob: data => ({ getBytes: () => signedBytes(toBytes(data)) })
      },
      CacheService: { getScriptCache: () => cache },
      LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
      ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }) },
      PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null, setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
      Logger: { log: (...args) => effects.push({ kind: 'logger', args }) },
      console: { log: (...args) => effects.push({ kind: 'console', args }), warn: (...args) => effects.push({ kind: 'console', args }), error: (...args) => effects.push({ kind: 'console', args }) },
      Session: { getEffectiveUser: () => ({ getEmail: () => 'teacher@example.invalid' }) },
      MailApp: { sendEmail: (...args) => { effects.push({ kind: 'email', args }); throw new Error('Email side effect forbidden in auth tests'); } },
      CalendarApp: { getDefaultCalendar: () => { effects.push({ kind: 'calendar' }); throw new Error('Calendar side effect forbidden in auth tests'); } }
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'gas/Code.gs' });
    // Only the work factor changes for scenario tests. The production KDF and
    // encoding are still executed. A separate test uses the full 600,000 rounds.
    if (options.iterations !== undefined) sandbox.PARENT_PASSWORD_ITERATIONS_ = options.iterations;
    return sandbox;
  }
  function request(req) { return JSON.parse(context().doPost({ postData: { contents: JSON.stringify(req) } }).getContent()); }
  function rows(name, target = spreadsheet) {
    const values = target.getSheetByName(name)?.getDataRange().getValues() || [];
    return values.slice(1).map(row => Object.fromEntries(values[0].map((column, index) => [column, row[index]])));
  }
  function setRow(name, key, value, patch) {
    const sheet = spreadsheet.getSheetByName(name);
    const headers = sheet.values[0];
    const index = sheet.values.findIndex((row, i) => i > 0 && String(row[headers.indexOf(key)]) === String(value));
    if (index < 0) throw new Error('Missing test fixture row: ' + name + ':' + value);
    for (const [column, cell] of Object.entries(patch)) {
      const position = headers.indexOf(column);
      if (position < 0) throw new Error('Missing test fixture column: ' + name + ':' + column);
      sheet.values[index][position] = cell;
    }
  }
  return {
    request, context, rows, setRow, spreadsheet, ledger, effects, cache,
    now: () => now, advance: ms => { now += ms; },
    get: params => JSON.parse(context().doGet({ parameter: params }).getContent()),
    admin: (op, args = {}) => request({ action: 'admin', token: TEACHER_TOKEN, op, ...args }),
    parent: (action, args = {}) => request({ action, k: 'synthetic-link-a', ...args }),
    parentRow: (id = 'test-a') => rows('parents').find(row => row.studentId === id),
    studentRow: (id = 'test-a') => rows('students').find(row => row.id === id)
  };
}

module.exports = { createHarness, TEACHER_TOKEN, TEACHER_PASSWORD, MCP_KEY };
