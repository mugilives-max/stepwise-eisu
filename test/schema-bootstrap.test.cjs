'use strict';

// 作り直した台帳・複製直後の台帳で ensureSchema_ が列見出しを揃えるか。
// ensureSchema_ の「列を足すだけ」のヘルパーは対象シートが無いと黙って何もしないので、
// シート作成より先に呼ぶと列が欠ける。ensureSchema_ は結果を6時間キャッシュするため、
// 欠けたままその台帳に残る。並び順の回帰をここで止める。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./gas-harness.cjs');

const headers = (h, name) => (h.spreadsheet.getSheetByName(name)?.values[0] || []).map(String);

test('events シートが無い台帳でも1リクエストで kind 列まで作られる', () => {
  const h = createHarness();
  assert.equal(h.spreadsheet.getSheetByName('events'), null, '前提: events シートはまだ無い');
  h.admin('state');
  assert.deepEqual(headers(h, 'events'), ['id', 'studentId', 'date', 'dateTo', 'title', 'createdAt', 'kind'],
    'events.kind が無いと生徒画面のテスト日カウントダウン(kind === "test")が出ない');
});

test('plans / wishes シートが無い台帳でも列見出しが揃う', () => {
  const h = createHarness();
  for (const name of ['plans', 'wishes']) assert.equal(h.spreadsheet.getSheetByName(name), null, '前提: ' + name + ' はまだ無い');
  h.admin('state');
  assert.deepEqual(headers(h, 'plans'),
    ['id', 'studentId', 'ym', 'subject', 'count', 'status', 'proposedAt', 'approvedAt', 'approvedVia', 'memo', 'kind']);
  assert.deepEqual(headers(h, 'wishes'),
    ['id', 'studentId', 'date', 'start', 'end', 'note', 'createdAt', 'kind', 'deliveryMode', 'duration', 'availability']);
});

test('students / slots が無い台帳でも列見出しが揃う', () => {
  const h = createHarness({ omitSheets: ['students', 'slots'] });
  h.admin('state');
  assert.deepEqual(headers(h, 'students'),
    ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly', 'parentToken', 'parentExp', 'deliveryMode']);
  assert.deepEqual(headers(h, 'slots'),
    ['id', 'date', 'start', 'min', 'status', 'studentId', 'done', 'eventId', 'meetUrl', 'subject', 'req', 'deliveryMode', 'kind']);
});

// ensureSchema_ に足したヘルパーが「作成より前」に紛れ込むのを防ぐ。
// 列を足すだけのヘルパーは、対象シートを作るヘルパーより後に呼ぶ。
test('ensureSchema_ は列を足すヘルパーを対象シートの作成より後に呼ぶ', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../gas/Code.gs'), 'utf8');
  const body = source.slice(source.indexOf('function ensureSchema_()'));
  const order = body.slice(0, body.indexOf('\n}')).match(/ensure[A-Za-z]+_\(\)/g).map(x => x.slice(0, -2));
  const at = name => order.indexOf(name);
  // 列を足すだけのヘルパー -> そのシートを作るヘルパー
  const needs = {
    ensureEventKindCol_: 'ensureEventsSheet_',
    ensurePlanStatusCols_: 'ensurePlansSheet_',
    ensureWishKindHeader_: 'ensureWishesSheet_',
    ensureParentHeaders_: 'ensureSchedulingSchema_',
    ensureEmailHeader_: 'ensureSchedulingSchema_',
    ensureCodeHeader_: 'ensureSchedulingSchema_',
    ensureFeeHeaders_: 'ensureSchedulingSchema_',
    ensureReqHeader_: 'ensureSchedulingSchema_',
    ensureMeetHeader_: 'ensureSchedulingSchema_',
    ensureSubjectHeader_: 'ensureSchedulingSchema_',
    ensureKindColumns_: 'ensureSchedulingSchema_',
  };
  for (const [column, creator] of Object.entries(needs)) {
    assert.ok(at(column) >= 0, 'ensureSchema_ に ' + column + ' が無い');
    assert.ok(at(creator) >= 0, 'ensureSchema_ に ' + creator + ' が無い');
    assert.ok(at(creator) < at(column), creator + ' は ' + column + ' より先に呼ぶ');
  }
});
