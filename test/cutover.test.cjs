'use strict';

// 台帳の正本が Worker に移ったあとの振る舞い。
//   * Apps Script は台帳への書き込みを断る（二重に書くと正本が 2 つになるため）
//   * 読み取りと付随処理の代行は続ける
//   * MCP は Apps Script が Worker へ中継するので、MCP サーバーの設定を変えずに使える
// 合成台帳（【テスト】生徒）だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN, MCP_KEY } = require('./gas-harness.cjs');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const SYNC_KEY = 'synthetic-sync-key-for-cutover-test';
const K = 'synthetic-link-a';

// 切り替え後の台帳。Apps Script からの中継先を、この D1 につないだ Worker にする
async function afterCutover() {
  const relayed = [];
  const h = createBillingHarness({
    urlFetch: (url, params) => {
      const body = JSON.parse(params.payload);
      relayed.push({ url: String(url), body });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(relayed.at(-1).reply || { ok: true, relayed: true }) };
    },
  });
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  h.seedSlot({ date: '2026-09-25', start: '17:00', status: 'offered' });
  const p = await createParity(h);
  h.properties.set('WORKER_OWNS_LEDGER', '1'); // ここから Apps Script は書かない
  relayed.length = 0; // 準備の段階で走った同期は数えない
  return { h, p, relayed, env: { ...p.env, SYNC_KEY, WRITE_MODE: 'worker' } };
}

test('切り替え後、Apps Script は台帳への書き込みを断る', async () => {
  const { h } = await afterCutover();
  for (const [label, body] of [
    ['生徒の授業不可', { action: 'blockSet', k: K, add: ['2026-09-26'], removeIds: [] }],
    ['生徒の予定共有', { action: 'eventAddMany', k: K, ranges: [{ date: '2026-09-27', dateTo: '2026-09-27' }], title: 'x' }],
    ['先生の授業案内', { action: 'admin', op: 'offer', token: TEACHER_TOKEN, studentId: 'test-a', items: [] }],
    ['先生の計画保存', { action: 'admin', op: 'planLineSave', token: TEACHER_TOKEN, studentId: 'test-a' }],
    ['保護者のログイン', { action: 'familyLogin', email: 'x@example.invalid', pass: 'y' }],
  ]) {
    const r = h.request(body);
    assert.equal(r.errorCode, 'ledgerMoved', label + ' が Apps Script で処理されてしまう: ' + JSON.stringify(r).slice(0, 120));
    assert.equal(r.refresh, true, label + ': 画面に再読み込みを促す');
  }
  assert.equal(h.rows('blocked').length, 0, '断った操作で台帳が変わっていない');
});

test('切り替え後も、読み取りと付随処理の代行は Apps Script で通る', async () => {
  const { h } = await afterCutover();
  const dash = h.request({ action: 'admin', op: 'kanriDashboard', token: TEACHER_TOKEN });
  assert.ok(dash.ok, '管理画面の読み取りは通る: ' + JSON.stringify(dash).slice(0, 120));
  const card = h.request({ action: 'admin', op: 'kanriStudent', token: TEACHER_TOKEN, studentId: 'test-a', section: 'overview' });
  assert.ok(card.ok, '生徒ページの読み取りは通る');
  // 付随処理の代行は鍵が要る
  const denied = h.request({ action: 'effects', key: 'wrong', items: [] });
  assert.equal(denied.badAuth, true);
});

test('MCP は Apps Script が Worker へ中継するので使い続けられる', async () => {
  const { h, relayed, env } = await afterCutover();
  const { handleRead } = await import('../cf/worker/read.mjs');
  const { runWrite } = await import('../cf/worker/write.mjs');

  const res = h.request({ action: 'admin', op: 'mcpStudents', mcpKey: MCP_KEY });
  assert.equal(relayed.length, 1, 'MCP の呼び出しが中継される');
  assert.match(relayed[0].url, /\/proxy$/, '中継先: ' + relayed[0].url);
  assert.equal(relayed[0].body.key, SYNC_KEY, '中継は同期の鍵で認証する');
  assert.equal(relayed[0].body.mcpKey, MCP_KEY, 'MCP の鍵は Apps Script から渡す（Worker には置かない）');
  assert.deepEqual(relayed[0].body.request.op, 'mcpStudents');
  assert.ok(res.relayed, '中継先の応答がそのまま返る');

  // 中継された中身を Worker 側で実行すると、ちゃんと答えが返る
  const inner = relayed[0].body.request;
  const scoped = { ...env, MCP_KEY: relayed[0].body.mcpKey };
  const viaWorker = (await handleRead(inner, scoped)) ?? (await runWrite(inner, scoped, { now: h.now() })).result;
  assert.ok(viaWorker && !viaWorker.error, 'Worker 側で MCP が通る: ' + JSON.stringify(viaWorker).slice(0, 140));
  assert.ok(Array.isArray(viaWorker.students), '生徒の一覧が返る');
});

test('中継の鍵が無ければ中継しない', async () => {
  const { h, relayed } = await afterCutover();
  h.properties.delete('WORKER_SYNC_KEY');
  const r = h.request({ action: 'admin', op: 'mcpStudents', mcpKey: MCP_KEY });
  assert.deepEqual(relayed, [], '鍵が無いのに外へ送っている');
  assert.match(String(r.error), /中継の設定がありません/);
});
