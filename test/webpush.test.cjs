'use strict';

// Web プッシュの暗号化と署名。
//
// 本文は端末ごとの鍵で暗号化するので、中継する配信サービス（Google / Apple / Mozilla）は
// 中身を読めない。生徒・保護者の名前や予定を通知に載せられるのはこのため。だから
// 「暗号化が仕様どおりか」は、動くかどうかではなく、外に何が出るかの問題になる。
//
// RFC 8291 付録 A の検証値と突き合わせる。自作の実装同士で確かめても意味がないので、
// 仕様書が示す入力と出力をそのまま使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.atob) globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');

// RFC 8291 A.2 の値
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function importAsKeys() {
  const { b64urlToBytes, bytesToB64url } = await import('../cf/lib/webpush.mjs');
  const raw = b64urlToBytes(VECTOR.asPublic);
  const jwk = { kty: 'EC', crv: 'P-256', d: VECTOR.asPrivate,
    x: bytesToB64url(raw.slice(1, 33)), y: bytesToB64url(raw.slice(33, 65)), ext: true };
  return {
    privateKey: await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    publicKey: await webcrypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

test('暗号化した本文が、RFC 8291 の例と一致する', async () => {
  const { encrypt, bytesToB64url } = await import('../cf/lib/webpush.mjs');
  const out = await encrypt(VECTOR.plaintext, VECTOR.uaPublic, VECTOR.auth, {
    salt: VECTOR.salt, localKeys: await importAsKeys(), recordSize: 4096,
  });
  assert.equal(bytesToB64url(out), VECTOR.expected, '仕様の例と違う暗号文になっている');
});

test('端末の鍵でしか開けない（中継する配信サービスは読めない）', async () => {
  const { encrypt, b64urlToBytes } = await import('../cf/lib/webpush.mjs');
  const body = await encrypt(VECTOR.plaintext, VECTOR.uaPublic, VECTOR.auth, { salt: VECTOR.salt, localKeys: await importAsKeys() });
  assert.ok(!Buffer.from(body).includes(Buffer.from('watermelon')), '本文が平文のまま入っている');

  // 端末の秘密鍵で開くと、元の本文に戻ること
  const raw = b64urlToBytes(VECTOR.uaPublic);
  const uaKey = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: VECTOR.uaPrivate,
    x: Buffer.from(raw.slice(1, 33)).toString('base64url'), y: Buffer.from(raw.slice(33, 65)).toString('base64url'), ext: true },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

  const salt = body.slice(0, 16), keyLen = body[20], asPublic = body.slice(21, 21 + keyLen), sealed = body.slice(21 + keyLen);
  const asKey = await webcrypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKey, 256));
  const hk = async (s, ikm, info, len) => {
    const k = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8));
  };
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(raw), Buffer.from(asPublic)]);
  const ikm = await hk(b64urlToBytes(VECTOR.auth), shared, info, 32);
  const cek = await hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const aes = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const opened = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, sealed));
  assert.equal(opened.slice(0, -1).toString('utf8'), VECTOR.plaintext, '端末側で元に戻らない');
});

test('送信のたびに違う暗号文になる（使い捨ての鍵と塩）', async () => {
  const { encrypt, bytesToB64url } = await import('../cf/lib/webpush.mjs');
  const a = bytesToB64url(await encrypt('同じ本文', VECTOR.uaPublic, VECTOR.auth));
  const b = bytesToB64url(await encrypt('同じ本文', VECTOR.uaPublic, VECTOR.auth));
  assert.notEqual(a, b, '毎回同じ暗号文になっている');
});

test('VAPID の署名が、送信先と有効期限を含んだ形になる', async () => {
  const { vapidHeader, bytesToB64url, b64urlToBytes } = await import('../cf/lib/webpush.mjs');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey);
  const publicKey = bytesToB64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const now = Date.UTC(2026, 8, 22, 12, 0, 0);

  const header = await vapidHeader('https://push.example.invalid', 'mailto:teacher@example.invalid', publicKey, jwk.d, now);
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/, '形が違う: ' + header.slice(0, 40));

  const token = header.slice(8, header.indexOf(', k='));
  const [h, c, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://push.example.invalid', '送信先が入っていない');
  assert.equal(claims.sub, 'mailto:teacher@example.invalid');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 60 * 60, '有効期限が 12 時間になっていない');

  const verified = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey,
    b64urlToBytes(s), Buffer.from(h + '.' + c));
  assert.ok(verified, '署名が検証できない');
});

test('送信先が消えていたら、そう分かる形で返す', async () => {
  const { send, bytesToB64url } = await import('../cf/lib/webpush.mjs');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey);
  const vapid = { subject: 'mailto:x@example.invalid', privateKey: jwk.d,
    publicKey: bytesToB64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
  const sub = { endpoint: 'https://push.example.invalid/x', p256dh: VECTOR.uaPublic, auth: VECTOR.auth };

  const original = globalThis.fetch;
  try {
    for (const [status, gone] of [[201, false], [404, true], [410, true], [500, false]]) {
      globalThis.fetch = async () => ({ status });
      const out = await send(sub, 'x', vapid);
      assert.equal(out.gone, gone, 'HTTP ' + status + ' の扱いが違う');
      assert.equal(out.ok, status === 201);
    }
  } finally { globalThis.fetch = original; }
});
