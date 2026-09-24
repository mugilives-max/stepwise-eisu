'use strict';

// D1 移行（段階 A）の検証。
//  1. cf/migrations の表と列が、GAS が実際に作るシートの見出しと一致すること
//  2. 台帳の中身を書き出して D1 に取り込めること。件数が合い、何度流しても同じ結果になること
//  3. 値の直し方（真偽・空欄・数式よけの ' ）が仕様どおりであること
// 実データは使わない。GAS ハーネスの合成台帳だけで完結する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./gas-harness.cjs');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const d1h = require('./helpers/d1-harness.cjs');

const lib = () => import('../cf/lib/import.mjs');

// 見出しはあるが D1 にだけある列と、その理由。
// 空のときは、作り直した台帳の見出しが D1 の列と過不足なく一致している。
const D1_ONLY = {};

// 台帳の 2 冊を「書き出しの束」にする。実際の書き出し経路（手作業でも GAS からでも）と同じ形。
function bundleOf(h) {
  const parts = [];
  for (const [book, label] of [[h.spreadsheet, 'app'], [h.ledger, 'ledger']]) {
    for (const [name, sheet] of book.sheets) {
      const values = sheet.values || [];
      parts.push({
        book: label,
        sheet: name,
        headers: (values[0] || []).map(String),
        rows: values.slice(1).map(row => row.map(cell => (cell instanceof Date ? cell.toISOString().slice(0, 10) : cell))),
        offset: 0,
      });
    }
  }
  return parts;
}

test('cf/migrations の表と列が GAS のシートの見出しと一致する', async () => {
  const h = createHarness();
  h.admin('state');
  const d1 = d1h.createD1();
  const missing = [];
  const diffs = [];
  for (const [book, label] of [[h.spreadsheet, 'app'], [h.ledger, 'ledger']]) {
    for (const [name, sheet] of book.sheets) {
      const headers = (sheet.values[0] || []).map(String).filter(x => x !== '');
      const cols = d1h.columns(d1, name).filter(c => !c.startsWith('_') && c !== 'rowid_');
      if (!cols.length) { missing.push(`${label}:${name}`); continue; }
      const shared = cols.slice(0, headers.length);
      if (JSON.stringify(shared) !== JSON.stringify(headers)) diffs.push(`${label}:${name}\n  シート: ${JSON.stringify(headers)}\n  D1    : ${JSON.stringify(cols)}`);
      const extra = cols.slice(headers.length);
      assert.deepEqual(extra, D1_ONLY[name] || [], `${name} の D1 にだけある列は理由付きで D1_ONLY に載せる`);
    }
  }
  assert.deepEqual(missing, [], 'シートに対応する D1 の表が無い');
  assert.deepEqual(diffs, [], '列の並びがシートと違う:\n' + diffs.join('\n'));
});

test('計画中の業務表と内部表がすべて作られ、索引が張られている', () => {
  const d1 = d1h.createD1();
  const tables = d1h.tables(d1);
  // 業務 51 表 + 仕組み側 6 表（取り込み記録・台帳の版・版の見張り・付随処理の控え・文章解析回数・通知の宛先）
  assert.equal(tables.length, 57);
  for (const name of ['_importRuns', '_ledger', '_guard', '_effects', '_nl_usage', 'pushSubs']) assert.ok(tables.includes(name), '仕組みの表が無い: ' + name);
  for (const name of ['slots', 'planLines', 'familyAccounts', 'familyProfiles', 'studentPermissions', 'studentNames', 'lessonRecords', '入金管理', '生徒台帳'])
    assert.ok(tables.includes(name), '表が無い: ' + name);
  const indexes = d1h.indexes(d1).map(i => i.name);
  for (const name of ['slots_student_date', 'events_student_dateTo', 'planLines_student_status', 'familyLinks_student', 'lessonRecords_slot', 'log_time', '_nl_usage_scope_created'])
    assert.ok(indexes.includes(name), '索引が無い: ' + name);
});

test('台帳を書き出して D1 に取り込むと件数が一致し、二度流しても増えない', async () => {
  const { importBundle } = await lib();
  // 【テスト】生徒だけの合成台帳。予定・計画・請求（2冊目の台帳）に中身が入る
  const h = createBillingHarness();
  const offered = h.seedSlot({ date: '2026-09-25', start: '17:00', subject: '英語' });
  h.seedSlot({ date: '2026-09-01', status: 'booked', done: true });
  h.seedPlan();
  h.seedPayment({ '年月': '2026-08' }); // 9月の請求を先に立てると確定が止まるので前月にする
  const accepted = h.accept(offered.id); // 生徒が確定するところまで通し、記録系の表にも行を作る
  assert.ok(!accepted.error, '見本の確定が通らない: ' + (accepted.error || ''));
  const d1 = d1h.createD1();

  const parts = bundleOf(h);
  const first = await importBundle(d1, parts, { source: 'test-fixture' });
  const unknown = first.tables.filter(t => t.errors.length);
  assert.deepEqual(unknown.map(t => t.table + ': ' + t.errors.join()), [], '取り込めなかった表がある');
  assert.ok(first.ok, '件数が合わない: ' + JSON.stringify(first.tables.filter(t => !t.matches)));

  // 0 件どうしの一致では確かめたことにならないので、中身のある表を名指しで見る
  for (const [table, expected] of [['students', h.rows('students').length], ['slots', h.rows('slots').length],
    ['plans', h.rows('plans').length], ['入金管理', h.rows('入金管理', h.ledger).length], ['acceptWrites', h.rows('acceptWrites').length]]) {
    assert.ok(expected > 0, table + ' の見本が空です');
    const row = await d1.prepare(`select count(*) as n from "${table}"`).first();
    assert.equal(Number(row.n), expected, table + ' の件数が台帳と一致する');
  }

  // 真偽と数値が型どおりに入っているか（実施済みの授業が 1 件ある）
  const done = await d1.prepare('select id, done, min from slots where done = 1').all();
  assert.equal(done.results.length, 1, '実施済みの授業が 1 件');
  assert.equal(done.results[0].min, 60);

  const slots = await d1.prepare('select count(*) as n from slots').first();

  // 同じ束をもう一度: 主キーで置き換わるので増えない
  const second = await importBundle(d1, parts, { source: 'test-fixture' });
  assert.ok(second.ok);
  const again = await d1.prepare('select count(*) as n from slots').first();
  assert.equal(Number(again.n), Number(slots.n), '二度目の取り込みで行が増えない');

  const runs = await d1.prepare('select count(*) as n from _importRuns').first();
  assert.equal(Number(runs.n), 2, '取り込みの記録が残る');
});

test('真偽・空欄・数式よけの値が仕様どおりに直る', async () => {
  const { importBundle, normalizeCell, unquoteCell } = await lib();
  const d1 = d1h.createD1();
  await importBundle(d1, [
    // students.active は TRUE/FALSE、slots.done は '' と TRUE が混ざる
    { book: 'app', sheet: 'students', headers: ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly', 'parentToken', 'parentExp', 'deliveryMode'], rows: [
      ['s1', '【テスト】あ', true, '', 'c1', 1500, '', '', '', ''],
      ['s2', '【テスト】い', 'false', '', 'c2', '', '', '', '', ''],
    ] },
    { book: 'app', sheet: 'familyLinks', headers: ['id', 'familyId', 'studentId', 'active', 'linkedAt', 'updatedAt'], rows: [
      ['l1', 'f1', 's1', 'true', '', ''],
      ['l2', 'f1', 's2', 'false', '', ''],
    ] },
    { book: 'app', sheet: 'lessonKinds', headers: ['name', 'standardMin', 'standardFee', 'active', 'sortOrder', 'updatedAt'], rows: [
      ['通常', '', '', 'true', 1, ''],
      ['演習', 90, 0, 'true', 2, ''],
    ] },
  ], { source: 'types' });

  const s = await d1.prepare('select id, active, rate30, monthly from students order by id').all();
  assert.deepEqual(s.results, [
    { id: 's1', active: 1, rate30: 1500, monthly: null },
    { id: 's2', active: 0, rate30: null, monthly: null },
  ], "TRUE/'false' は 1/0 に、空欄の金額は NULL（0 と区別する。GAS 側に空欄と 0 を分ける判定がある）");

  const l = await d1.prepare('select id, active from familyLinks order by id').all();
  assert.deepEqual(l.results, [{ id: 'l1', active: 1 }, { id: 'l2', active: 0 }]);

  const k = await d1.prepare('select name, standardMin, standardFee from lessonKinds order by sortOrder').all();
  assert.deepEqual(k.results, [
    { name: '通常', standardMin: null, standardFee: null },
    { name: '演習', standardMin: 90, standardFee: 0 },
  ], "'' は NULL、0 は 0 のまま（区別が要る列）");

  // 数式よけの ' は剥がす。ふつうの ' で始まる文は触らない
  assert.equal(unquoteCell("'=SUM(A1)"), '=SUM(A1)');
  assert.equal(unquoteCell("'-5"), '-5');
  assert.equal(unquoteCell("'ふつうの文"), "'ふつうの文");
  assert.equal(normalizeCell('', { type: 'INTEGER', notNull: false, defaultValue: 0 }), null, '数値列の空欄は NULL');
  assert.equal(normalizeCell('0', { type: 'INTEGER', notNull: false, defaultValue: 0 }), 0, '0 は 0 のまま');
});

test('D1 に無い見出しは取り込まず、見つからない表は理由を返す', async () => {
  const { importSheet } = await lib();
  const d1 = d1h.createD1();
  const added = await importSheet(d1, { book: 'app', sheet: 'teacherOff', headers: ['id', 'date', 'note', 'start', 'end', '新しい列'], rows: [['t1', '2026-09-25', '', '', '', 'x']] });
  assert.deepEqual(added.skippedColumns, ['新しい列'], '見出しが増えたら取り込まずに知らせる');
  assert.equal(added.rows, 1);
  const none = await importSheet(d1, { book: 'app', sheet: '知らないシート', headers: ['a'], rows: [['1']] });
  assert.equal(none.rows, 0);
  assert.match(none.errors[0], /対応する表がありません/);
});
