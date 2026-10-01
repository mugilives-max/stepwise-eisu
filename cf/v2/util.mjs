// v2 の共通の道具。エラーの形、ID・トークン、ハッシュ、時刻。
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

// 利用者に返すエラー。code は画面が分岐に使う短い英字、message はそのまま見せる日本語
export class ApiError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code; this.status = status; this.extra = extra;
  }
}
export const fail = (code, message, status, extra) => { throw new ApiError(code, message, status, extra); };

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const newId = prefix => prefix + '_' + hex(randomBytes(12));
// 推測できない長さのトークン（招待・再設定・ログイン）。prefix で用途が分かるようにする
export const newToken = prefix => prefix + '.' + base64url(randomBytes(32));
export const sha256Hex = text => hex(sha256(new TextEncoder().encode(String(text))));

// 長さに関係なく時間が一定の比較（パスワードのハッシュ・トークン）
export function sameText(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// パスワード: PBKDF2-SHA256。今の保護者のパスワード（Apps Script で作ったもの）と同じ形なので、そのまま移せる。
// Workers の組み込みの PBKDF2 は 10 万回までしか使えないため、純粋な JavaScript で計算する（約 1.3 秒）。
let iterations = 600000;
export const PASSWORD_ITERATIONS = () => iterations;
// テストだけが呼ぶ（本番の処理からは呼ばない）
export function setPasswordIterationsForTest(n) { iterations = n; }

export const newSalt = () => hex(randomBytes(16));
export function hashPassword(pass, salt, count = iterations) {
  return 'pbkdf2-sha256$' + count + '$' + hex(pbkdf2(sha256, String(pass), String(salt), { c: count, dkLen: 32 }));
}
export function verifyPassword(pass, salt, stored) {
  const m = /^pbkdf2-sha256\$(\d+)\$([a-f0-9]{64})$/.exec(String(stored || ''));
  if (!m) return false;
  const count = Number(m[1]);
  if (!(count >= 1 && count <= 2000000)) return false;
  return sameText(hashPassword(pass, salt, count), stored);
}
export function passwordProblem(pass, email) {
  pass = String(pass || '');
  if (pass.length < 12 || pass.length > 128) return 'パスワードは12〜128文字にしてください';
  if (email && pass.toLowerCase() === String(email).toLowerCase()) return 'メールアドレスと同じパスワードは使えません';
  return '';
}

export const normEmail = v => String(v || '').trim().toLowerCase();
export const validEmail = v => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(v || '')) && String(v).length <= 254;
export const iso = ms => new Date(ms).toISOString();

// 監査の記録。お金・権限・ログインに関わる操作は必ず残す
export async function audit(c, action, target = '', detail = {}) {
  await c.db.prepare('insert into auditLog (at, actorKind, actorId, action, target, detail) values (?, ?, ?, ?, ?, ?)')
    .bind(iso(c.now), c.actor ? c.actor.kind : 'system', c.actor ? c.actor.id : '', action, String(target), JSON.stringify(detail)).run();
}
