'use strict';

// D1（正本）→ シート（控え）の写し取り。
//
// 台帳の正本が Worker に移ったので、シートは写しになった。既存の週次バックアップ
// （Backup.gs・日曜 3:00）は「シートを Drive に複製する」作りなので、写しが止まると
// 古い内容を保存しつづける。だから写しは「通ること」より「おかしいときに書かないこと」が要る。
// 合成台帳だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const SYNC_KEY = 'synthetic-sync-key-for-mirror-test';

// D1 を用意し、その /export の中身を返す Apps Script 側のハーネスを作る
async function mirrorSetup(tweak) {
  const seed = createBillingHarness();
  seed.seedSlot({ date: '2026-09-25', start: '17:00', status: 'offered' });
  const p = await createParity(seed);
  const { books } = await import('../cf/lib/sheet-view.mjs');
  const { TABLE_COLUMNS } = await import('../cf/worker/generated/schema.mjs');
  const exported = { ok: true, exportedAt: '2026-09-22T02:00:00.000Z', ...(await books(p.d1, TABLE_COLUMNS)) };
  if (tweak) tweak(exported);

  const asked = [];
  const h = createBillingHarness({
    urlFetch: (url, params) => {
      asked.push(String(url));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(exported) };
    },
  });
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  h.properties.set('WORKER_OWNS_LEDGER', '1');
  return { h, exported, asked, run: () => h.context().mirrorLedgerFromWorker() };
}

test('D1 の台帳をシートへ写す', async () => {
  const { h, run, asked } = await mirrorSetup();
  const before = h.rows('slots').length;
  const out = run();
  assert.ok(out.ok, '写せていない: ' + JSON.stringify(out).slice(0, 200));
  assert.match(asked[0], /\/export$/, '取り寄せ先が違う: ' + asked[0]);
  assert.ok(out.sheets > 20, '写した表が少なすぎる: ' + out.sheets);
  assert.ok(h.rows('slots').length >= before, '授業の表が減っている');
  assert.equal(h.context().mirrorState_().status, 'ok');
});

test('写したあとは、シートが D1 と同じ中身になる', async () => {
  const { h, exported, run } = await mirrorSetup();
  run();
  const sheet = h.spreadsheet.getSheetByName('slots').getDataRange().getValues();
  assert.deepEqual(sheet.map(r => r.map(String)), exported.app.slots.map(r => r.map(v => String(v ?? ''))));
});

test('生徒の表が空なら、シートを書き換えない', async () => {
  const { h, run } = await mirrorSetup(e => { e.app.students = [e.app.students[0]]; });
  const before = h.rows('students').length;
  const out = run();
  assert.equal(out.ok, false, '空の取り寄せで書き換えてしまった');
  assert.match(out.problems.join('/'), /students: 中身が空です/);
  assert.equal(h.rows('students').length, before, 'シートが書き換えられている');
});

test('表の数が前回より減っていたら、シートを書き換えない', async () => {
  const { h, run } = await mirrorSetup(e => { delete e.app.wishes; delete e.app.tasks; });
  h.context().mirrorSaveState_({ status: 'ok', sheets: 99, lastOkAt: '2026-09-21T17:00:00.000Z' });
  const before = h.rows('slots').length;
  const out = run();
  assert.equal(out.ok, false, '表が減っているのに書き換えてしまった');
  assert.match(out.problems.join('/'), /表の数が前回より減っています/);
  assert.equal(h.rows('slots').length, before, 'シートが書き換えられている');
});

test('取り寄せに失敗したら、シートを書き換えず記録を残す', async () => {
  const h = createBillingHarness({ urlFetch: () => ({ getResponseCode: () => 500, getContentText: () => 'error' }) });
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  const before = h.rows('slots').length;
  const out = h.context().mirrorLedgerFromWorker();
  assert.equal(out.ok, false);
  assert.match(out.problems.join('/'), /HTTP 500/);
  assert.equal(h.rows('slots').length, before, 'シートが書き換えられている');
  const state = h.context().mirrorState_();
  assert.equal(state.status, 'failed');
  assert.equal(state.failures, 1, '失敗の回数が数えられていない');
});

test('失敗が続いても、毎日は知らせない', async () => {
  const h = createBillingHarness({ urlFetch: () => ({ getResponseCode: () => 500, getContentText: () => '' }) });
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  // context() は呼ぶたびに作り直されるので、同じ入れ物を持ち回る
  const gas = h.context();
  const failures = [];
  for (let i = 0; i < 9; i++) { gas.mirrorLedgerFromWorker(); failures.push(h.effects.filter(e => e.kind === 'email').length); }
  // 1 回目と 7 回目だけ増える＝知らせは 2 通
  assert.deepEqual(failures, [1, 1, 1, 1, 1, 1, 2, 2, 2], '知らせる回数が想定と違う: ' + JSON.stringify(failures));
  assert.equal(gas.mirrorState_().failures, 9);
});

test('正本が Worker に移ったあとは、シートを押し戻さない', async () => {
  const sent = [];
  const h = createBillingHarness({
    urlFetch: (url, params) => { sent.push(String(url)); return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; },
  });
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  h.properties.set('WORKER_OWNS_LEDGER', '1');
  h.context().syncTouch_('slots');
  assert.equal(h.context().syncPush_(), null, '押し戻そうとしている');
  assert.deepEqual(sent, [], 'Worker へ送ってしまった: ' + JSON.stringify(sent));
});
