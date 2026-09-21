'use strict';

// Worker の入口（cf/worker/read.mjs）が GAS と同じ JSON を返すかを見る。
// 前の並走テスト（parity-reads）は「GAS のコードを D1 の上で動かしても同じか」を見た。
// こちらは「Worker が実際に呼ばれたときの応答」まで含めて同じかを見る。
// 台帳は合成（【テスト】生徒）だけ。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

// Worker のコードは gas/*.gs から作った束を読む。テストの前に作り直しておく
test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

function ledgerWithContent() {
  const h = createBillingHarness();
  const offered = h.seedSlot({ date: '2026-09-25', start: '17:00', subject: '英語' });
  h.seedSlot({ date: '2026-09-01', status: 'booked', done: true });
  h.seedPlan();
  h.seedPayment({ '年月': '2026-08' });
  assert.ok(!h.accept(offered.id).error);
  return h;
}

test('Worker の読み取りは GAS と同じ JSON を返す', async () => {
  const p = await createParity(ledgerWithContent());

  await p.compareWorker('生徒マイページ',
    h => h.context().studentState_('synthetic-link-a'),
    { action: 'state', k: 'synthetic-link-a' });

  await p.compareWorker('管理画面のホーム',
    h => h.admin('kanriDashboard', { from: 'kanri', view: 'home' }),
    { action: 'admin', op: 'kanriDashboard', token: TEACHER_TOKEN, from: 'kanri', view: 'home' });

  await p.compareWorker('管理画面の生徒ページ（概要）',
    h => h.admin('kanriStudent', { studentId: 'test-a', section: 'overview', from: 'kanri', view: 'students' }),
    { action: 'admin', op: 'kanriStudent', token: TEACHER_TOKEN, studentId: 'test-a', section: 'overview', from: 'kanri', view: 'students' });

  await p.compareWorker('管理画面の生徒ページ（請求）',
    h => h.admin('kanriStudent', { studentId: 'test-a', section: 'billing', from: 'kanri', view: 'students' }),
    { action: 'admin', op: 'kanriStudent', token: TEACHER_TOKEN, studentId: 'test-a', section: 'billing', from: 'kanri', view: 'students' });

  await p.compareWorker('請求の下書き',
    h => h.admin('billingPreview', { studentId: 'test-a', ym: '2026-09', from: 'kanri', view: 'students' }),
    { action: 'admin', op: 'billingPreview', token: TEACHER_TOKEN, studentId: 'test-a', ym: '2026-09', from: 'kanri', view: 'students' });

  assert.deepEqual(p.diffs, [], 'GAS と Worker で結果が違う:\n' + p.diffs.join('\n'));
});

test('ログインしていない読み取りは断る。書き込みは Worker では扱わない', async () => {
  const p = await createParity(createBillingHarness());

  const bad = await p.worker({ action: 'admin', op: 'kanriStudent', token: 'wrong-token', studentId: 'test-a' });
  assert.deepEqual(bad, { error: 'ログインし直してください', badAuth: true });

  // 対応していない操作は null。呼び出し側はこれを見て GAS に回す
  for (const body of [
    { action: 'offer', token: TEACHER_TOKEN },
    { action: 'admin', op: 'planLineSave', token: TEACHER_TOKEN },
    { action: 'accept', k: 'synthetic-link-a' },
    { action: 'familyData' },
  ]) assert.equal(await p.worker(body), null, JSON.stringify(body) + ' は Worker が引き受けない');

  // 生徒の専用コードが違えば中身は返らない
  const unknown = await p.worker({ action: 'state', k: 'not-a-real-code' });
  assert.equal(unknown.me, null);
  assert.deepEqual(unknown.slots, []);
});

test('読み取りの途中で台帳に書こうとしたら、黙って進まず止まる', async () => {
  const p = await createParity(createBillingHarness());
  const { createRuntime } = await import('../cf/worker/read.mjs');
  const gas = await createRuntime(p.env, { now: p.source.now() });

  // ensureSchema_ は列の追加や請求IDの埋め直しをする（＝書き込み）。Worker では呼ばないが、
  // 呼んでしまったときに黙って壊れないことを確かめる
  assert.throws(() => gas.sheet_('slots').appendRow(['x']), /書き込めません/);
  assert.throws(() => gas.ss_().insertSheet('新しいシート'), /書き込めません/);
  assert.throws(() => gas.addLog_('見本'), /書き込めません/);

  // メール送信やカレンダーなど、読み取りに要らないものは触れない
  const { createServices } = await import('../cf/lib/gas-services.mjs');
  const services = createServices({ books: { app: {}, ledger: {} } });
  assert.throws(() => services.MailApp.sendEmail('a', 'b', 'c'), /書き込めません/);
  assert.throws(() => services.CalendarApp.getDefaultCalendar(), /書き込めません/);
  assert.throws(() => services.DriveApp.createFile('x', 'y'), /書き込めません/);
  assert.throws(() => services.UrlFetchApp.fetch('https://example.invalid'), /書き込めません/);
});
