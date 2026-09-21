'use strict';

// GAS が書いたあと、その内容が Worker（D1）にも伝わることを確かめる。
// 実際の通信はせず、GAS の UrlFetchApp を差し替えて Worker の /sync を直接呼ぶ。
// 台帳は合成（【テスト】生徒）だけ。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

const SYNC_URL = 'https://api.example.invalid/sync';
const SYNC_KEY = 'synthetic-sync-key-for-tests-only';

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

// GAS からの送信を受け取って Worker の /sync に渡す差し替え。実際の通信はしない。
// GAS は同期的に呼ぶので、D1 への反映は後から settle() で待つ。
function collector(envRef) {
  const calls = [];
  let failing = false;
  return {
    calls,
    fail(on) { failing = on; },
    urlFetch(url, params) {
      const body = JSON.parse(params.payload);
      if (failing) return { getResponseCode: () => 500, getContentText: () => 'ng' };
      // D1 への反映は settle() のときに行う（送信時にはまだ env が揃っていないことがある）
      calls.push({ url, body, sheets: body.sheets.map(s => s.sheet), envRef });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    },
  };
}

async function settle(calls) {
  const { handleSync } = await import('../cf/worker/sync.mjs');
  const out = [];
  for (const c of calls) out.push(await handleSync(c.body, c.envRef.env));
  return out;
}

// 同期の設定を入れた台帳と、その送信先をひとまとめに用意する
async function connected(build) {
  const envRef = {};
  const sink = collector(envRef);
  const h = createBillingHarness({ urlFetch: sink.urlFetch });
  h.properties.set('WORKER_SYNC_URL', SYNC_URL);
  h.properties.set('WORKER_SYNC_KEY', SYNC_KEY);
  if (build) build(h);
  const p = await createParity(h);
  envRef.env = { ...p.env, SYNC_KEY };
  // 準備の段階でもスキーマ整備で書き込みが起き、その分の同期が走る。
  // ここまでを流しきってから数え始める（本番でも同じことが起きるだけで害はない）
  await settle(sink.calls);
  sink.calls.length = 0;
  return { p, sink };
}

test('設定が無ければ何も送らない（今までどおり動く）', async () => {
  const sink = collector({ env: {} });
  const h = createBillingHarness({ urlFetch: sink.urlFetch });
  const p = await createParity(h);
  p.source.admin('addOff', { date: '2026-09-30', start: '', end: '', note: '見本' });
  assert.deepEqual(sink.calls, [], 'URL と鍵が未設定なら送信しない');
});

test('書き込むと、変わったシートだけが Worker に届く', async () => {
  const { p, sink } = await connected();

  const added = p.source.admin('addOff', { date: '2026-09-30', start: '', end: '', note: '見本' });
  assert.ok(!added.error, added.error || '');
  assert.equal(sink.calls.length, 1, '1 回の書き込みにつき 1 回だけ送る');
  const sent = sink.calls[0].sheets;
  assert.ok(sent.includes('teacherOff'), '書いたシートが入っている');
  assert.ok(sent.includes('log'), '記録のシートも一緒に送られる');
  // 目印は「書き込み用にシートを取った」時点で付くので、応答を組み立てる途中で
  // 読んだだけのシートが少し混じる。多めに送っても内容は同じなので害はない。
  // 大事なのは台帳ぜんぶを毎回送らないこと。
  assert.ok(sent.length <= 5, '送るのは一部のシートだけ: ' + sent.join(','));
  assert.ok(p.source.spreadsheet.sheets.size > 20, '台帳にはもっと多くのシートがある');
  const results = await settle(sink.calls);
  assert.ok(results[0].payload.ok, JSON.stringify(results[0].payload));

  // 届いたあと、Worker の読み取りに反映されている
  const dash = await p.worker({ action: 'admin', op: 'kanriDashboard', token: TEACHER_TOKEN, from: 'kanri', view: 'home' });
  const off = (dash.data.teacherOff || []).filter(x => x.date === '2026-09-30');
  assert.equal(off.length, 1, '登録した休みが Worker の応答に出る');
});

test('消した行は D1 からも消える', async () => {
  let slot = null;
  const { p, sink } = await connected(h => { slot = h.seedSlot({ date: '2026-09-25', start: '17:00' }); });

  const before = await p.d1.prepare('select count(*) as n from slots where id = ?').bind(slot.id).first();
  assert.equal(Number(before.n), 1, '消す前は D1 にある');

  const declined = p.source.request({ action: 'decline', slotId: slot.id, k: 'synthetic-link-a' });
  assert.ok(!declined.error, declined.error || '');
  await settle(sink.calls);

  const after = await p.d1.prepare('select count(*) as n from slots where id = ?').bind(slot.id).first();
  assert.equal(Number(after.n), 0, '断られた案内は D1 からも消える');
});

test('鍵が違えば受け付けない', async () => {
  const { handleSync } = await import('../cf/worker/sync.mjs');
  const { p } = await connected();
  const one = [{ book: 'app', sheet: 'slots', headers: ['id'], rows: [] }];

  const wrong = await handleSync({ key: 'wrong', sheets: one }, { ...p.env, SYNC_KEY });
  assert.equal(wrong.status, 403);
  const short = await handleSync({ key: 'too-short', sheets: one }, { ...p.env, SYNC_KEY: 'too-short' });
  assert.equal(short.status, 403, '鍵が短すぎる設定では受け付けない');
  const none = await handleSync({ key: SYNC_KEY, sheets: one }, { ...p.env });
  assert.equal(none.status, 403, 'Worker 側に鍵が無ければ受け付けない');
  const unknown = await handleSync({ key: SYNC_KEY, sheets: [{ book: 'app', sheet: '知らないシート', headers: ['a'], rows: [] }] }, { ...p.env, SYNC_KEY });
  assert.equal(unknown.status, 500);
  assert.match(unknown.payload.errors[0], /対応する表がありません/);
});

test('送信に失敗したら覚えておき、次の書き込みでまとめて送り直す', async () => {
  const { p, sink } = await connected();
  sink.fail(true);
  p.source.admin('addOff', { date: '2026-09-29', start: '', end: '', note: '見本' });
  assert.deepEqual(sink.calls, [], 'この時点では届いていない');

  sink.fail(false);
  p.source.admin('addOff', { date: '2026-09-28', start: '', end: '', note: '見本' });
  assert.equal(sink.calls.length, 1);
  assert.ok(sink.calls[0].sheets.includes('teacherOff'), '取りこぼしたシートが次の書き込みで送られる');
  await settle(sink.calls);

  const rows = await p.d1.prepare("select count(*) as n from teacherOff where date in ('2026-09-28','2026-09-29')").first();
  assert.equal(Number(rows.n), 2, '取りこぼした分も含めて D1 に入る');
});
