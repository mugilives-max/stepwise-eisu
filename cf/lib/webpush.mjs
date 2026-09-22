// Web プッシュの送信。仕様は RFC 8291（本文の暗号化）と RFC 8292（VAPID の署名）。
//
// 本文は端末ごとの鍵で暗号化して送る。中継する配信サービス（Google / Apple / Mozilla）は
// 中身を読めない。生徒・保護者の名前や予定を通知に載せられるのは、この暗号化があるため。
//
// 使う鍵は二種類。
//   VAPID … このサーバーの身元。公開鍵は画面に配り、秘密鍵は Secret に置く（送信の署名用）
//   端末鍵 … 購読のときに端末が作る（p256dh / auth）。本文の暗号化に使う
//
// 外部のライブラリは使わない。WebCrypto だけで足りる。

const enc = new TextEncoder();

export function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u16(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
function u32(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * 本文を端末の鍵で暗号化する（aes128gcm・RFC 8291）。
 * 戻り値はそのまま POST の本体になる。
 */
export async function encrypt(plaintext, p256dh, auth, options = {}) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const salt = options.salt ? b64urlToBytes(options.salt) : crypto.getRandomValues(new Uint8Array(16));

  // 送信のたびに使い捨ての鍵組を作り、端末の公開鍵と共有秘密を作る
  const local = options.localKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  // 鍵の由来に両者の公開鍵を混ぜる（すり替えを防ぐ）
  const prkInfo = concat(enc.encode('WebPush: info\0'), uaPublic, localPublic);
  const ikm = await hkdf(authSecret, shared, prkInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const body = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  // 末尾の 0x02 は「これが最後の記録」の印
  const padded = concat(body, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));

  const recordSize = options.recordSize || 4096;
  return concat(salt, u32(recordSize), new Uint8Array([localPublic.length]), localPublic, sealed);
}

/** VAPID の署名（送信先ごとに作る。12 時間で切れる） */
export async function vapidHeader(audience, subject, publicKey, privateKey, now = Date.now()) {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject,
  })));
  const signing = enc.encode(header + '.' + claims);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: privateKey,
    x: bytesToB64url(b64urlToBytes(publicKey).slice(1, 33)),
    y: bytesToB64url(b64urlToBytes(publicKey).slice(33, 65)),
    ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signing));
  return 'vapid t=' + header + '.' + claims + '.' + bytesToB64url(sig) + ', k=' + publicKey;
}

/**
 * 1 件送る。戻り値の gone が true なら、その購読は消えている（登録を消してよい）。
 */
export async function send(subscription, payload, vapid, options = {}) {
  const url = new URL(subscription.endpoint);
  const authorization = await vapidHeader(url.origin, vapid.subject, vapid.publicKey, vapid.privateKey, options.now);
  const body = await encrypt(payload, subscription.p256dh, subscription.auth, options);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl ?? 86400),
      Urgency: options.urgency || 'normal',
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
