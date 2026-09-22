'use strict';

// プッシュ通知の登録と送信。
//
// 気をつけるのは二つ。
//   * 登録できるのは本人だけ。endpoint は「知っていればその端末に通知を送れる」値なので、
//     他人の端末を自分に結びつけたり、応答から読み取れたりしてはいけない
//   * 通知が送れなくても、台帳の処理は止めない
// 合成台帳（【テスト】生徒）だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.atob) globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const K = 'synthetic-link-a';
// RFC 8291 の例の端末鍵（実在の端末ではない）
const DEVICE = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

async function vapidEnv(d1) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey);
  const { bytesToB64url } = await import('../cf/lib/webpush.mjs');
  return {
    DB: d1, NL_ENABLED: '0', WRITE_MODE: 'worker',
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_PUBLIC_KEY: bytesToB64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    VAPID_SUBJECT: 'https://www.stepwise-education.jp',
  };
}

async function setup() {
  const h = createBillingHarness();
  const p = await createParity(h);
  return { h, p, env: await vapidEnv(p.d1) };
}

const sub = (endpoint = 'https://push.example.invalid/device-a') => ({ endpoint, ...DEVICE });

test('通知が使えるかどうかと公開鍵は、誰でも聞ける', async () => {
  const { env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const res = await handlePush({ action: 'pushInfo' }, env);
  assert.equal(res.enabled, true);
  assert.equal(res.publicKey, env.VAPID_PUBLIC_KEY);
});

test('鍵が設定されていなければ、使えないと答える', async () => {
  const { p } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const res = await handlePush({ action: 'pushInfo' }, { DB: p.d1 });
  assert.equal(res.enabled, false);
  assert.equal(res.publicKey, '');
});

test('生徒は、自分の専用リンクで端末を登録できる', async () => {
  const { p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const res = await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);
  assert.equal(res.ok, true);
  assert.equal(res.subscribed, true);
  assert.ok(!JSON.stringify(res).includes('push.example.invalid'), '応答に宛先が出ている');
  const row = await p.d1.prepare('select ownerKind, owner from pushSubs').first();
  assert.deepEqual(row, { ownerKind: 'student', owner: 'test-a' });
});

test('専用リンクが違えば、登録できない', async () => {
  const { p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const res = await handlePush({ action: 'pushSubscribe', k: 'synthetic-not-a-link', subscription: sub() }, env);
  assert.equal(res.badCode, true, '知らない鍵で登録できてしまう: ' + JSON.stringify(res).slice(0, 140));
  const n = await p.d1.prepare('select count(*) as n from pushSubs').first();
  assert.equal(Number(n.n), 0);
});

test('登録内容の形がおかしければ、受け付けない', async () => {
  const { p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  for (const bad of [
    { endpoint: 'http://push.example.invalid/x', ...DEVICE },     // 暗号化されていない経路
    { endpoint: 'https://push.example.invalid/x', p256dh: 'short', auth: DEVICE.auth },
    { endpoint: 'https://push.example.invalid/x', p256dh: DEVICE.p256dh, auth: '' },
    null,
  ]) {
    const res = await handlePush({ action: 'pushSubscribe', k: K, subscription: bad }, env);
    assert.equal(res.errorCode, 'badSubscription', '通してしまう: ' + JSON.stringify(bad).slice(0, 80));
  }
  const n = await p.d1.prepare('select count(*) as n from pushSubs').first();
  assert.equal(Number(n.n), 0);
});

test('同じ端末を別の人が使っても、前の結びつきは残らない', async () => {
  const { h, p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const other = h.rows('students').find(s => String(s.id) !== 'test-a');
  assert.ok(other && other.code, '前提: 合成台帳に別の生徒がいる');

  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);
  await handlePush({ action: 'pushSubscribe', k: String(other.code), subscription: sub() }, env);
  const rows = await p.d1.prepare('select ownerKind, owner from pushSubs').all();
  assert.equal(rows.results.length, 1, '同じ端末が二重に登録されている');
  assert.equal(rows.results[0].owner, String(other.id), '前の持ち主のままになっている');
});

test('登録を外せる。他人の端末は外せない', async () => {
  const { h, p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const other = h.rows('students').find(s => String(s.id) !== 'test-a');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);

  await handlePush({ action: 'pushUnsubscribe', k: String(other.code), subscription: sub() }, env);
  assert.equal(Number((await p.d1.prepare('select count(*) as n from pushSubs').first()).n), 1, '他人に外されている');

  const out = await handlePush({ action: 'pushUnsubscribe', k: K, subscription: sub() }, env);
  assert.equal(out.subscribed, false);
  assert.equal(Number((await p.d1.prepare('select count(*) as n from pushSubs').first()).n), 0);
});

test('端末は数を限って覚える（古いものから落とす）', async () => {
  const { p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  for (let i = 0; i < 13; i++) {
    await handlePush({ action: 'pushSubscribe', k: K, subscription: sub('https://push.example.invalid/device-' + i) }, env);
  }
  const n = await p.d1.prepare('select count(*) as n from pushSubs').first();
  assert.equal(Number(n.n), 10, '端末が際限なく溜まる');
});

// ---- 送信 ----

function captureSends() {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: init.body });
    return { status: sent.length === 1 ? 201 : 201 };
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}

test('先生が案内を出すと、その生徒の端末に届く', async () => {
  const { p, env } = await setup();
  const { handlePush, deliverNotice } = await import('../cf/worker/push.mjs');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);

  const cap = captureSends();
  let out;
  try {
    out = await deliverNotice(env, { action: 'admin', op: 'offer', token: TEACHER_TOKEN, studentId: 'test-a' }, { ok: true, added: 3 });
  } finally { cap.restore(); }

  assert.equal(out.sent, 1, '送られていない');
  assert.equal(cap.sent.length, 1);
  assert.equal(cap.sent[0].url, 'https://push.example.invalid/device-a');
  assert.match(cap.sent[0].headers.Authorization, /^vapid t=/, '身元の署名が付いていない');
  assert.equal(cap.sent[0].headers['Content-Encoding'], 'aes128gcm');
  assert.ok(!Buffer.from(cap.sent[0].body).includes(Buffer.from('案内')), '本文が暗号化されていない');
});

test('案内を出していないときは、送らない', async () => {
  const { env } = await setup();
  const { handlePush, deliverNotice } = await import('../cf/worker/push.mjs');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);
  const cap = captureSends();
  try {
    for (const [body, result] of [
      [{ action: 'admin', op: 'offer', studentId: 'test-a' }, { ok: true, added: 0 }],
      [{ action: 'admin', op: 'offer', studentId: 'test-a' }, { error: '重なる授業があります' }],
      [{ action: 'admin', op: 'deleteSlot', studentId: 'test-a' }, { ok: true }],
      [{ action: 'wishMany', k: K }, { ok: true }],
    ]) {
      assert.equal((await deliverNotice(env, body, result)).sent, 0, '送ってしまう: ' + JSON.stringify(body).slice(0, 60));
    }
  } finally { cap.restore(); }
  assert.deepEqual(cap.sent, []);
});

test('登録が消えている端末は、片付ける', async () => {
  const { p, env } = await setup();
  const { handlePush, notify } = await import('../cf/worker/push.mjs');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 410 });
  try { await notify(env, 'student', 'test-a', { title: 'x', body: 'y' }); } finally { globalThis.fetch = original; }
  assert.equal(Number((await p.d1.prepare('select count(*) as n from pushSubs').first()).n), 0, '消えた端末が残っている');
});

test('続けて失敗する端末も、いずれ片付ける', async () => {
  const { p, env } = await setup();
  const { handlePush, notify } = await import('../cf/worker/push.mjs');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 500 });
  try {
    for (let i = 0; i < 5; i++) await notify(env, 'student', 'test-a', { title: 'x', body: 'y' });
  } finally { globalThis.fetch = original; }
  assert.equal(Number((await p.d1.prepare('select count(*) as n from pushSubs').first()).n), 0, '送れない端末が残りつづける');
});

test('通知が送れなくても、台帳の処理は成功したまま', async () => {
  const { h, p, env } = await setup();
  const { handlePush } = await import('../cf/worker/push.mjs');
  const { runWrite } = await import('../cf/worker/write.mjs');
  await handlePush({ action: 'pushSubscribe', k: K, subscription: sub() }, env);

  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('配信サービスに届かない'); };
  let done;
  try {
    done = await runWrite({ action: 'wishMany', k: K, kind: 'ok', dates: ['2026-09-24'], start: '16:00', end: '18:00', note: '', deliveryMode: 'in_person' }, env, { now: h.now() });
  } finally { globalThis.fetch = original; }
  assert.ok(!done.result.error, '通知の都合で書き込みが失敗している: ' + JSON.stringify(done.result).slice(0, 140));
  assert.ok(Number((await p.d1.prepare('select count(*) as n from wishes').first()).n) > 0, '台帳に入っていない');
});
