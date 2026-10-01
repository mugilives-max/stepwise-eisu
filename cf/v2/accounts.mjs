// スタッフと家族（保護者）のログイン。作りは両方で同じにする（今は先生だけが弱い方式だった）。
// - パスワードは PBKDF2（util.mjs）。端末ごとにログインを保つ（sessions）。
// - 5 回続けて間違えると 15 分ロック。メールアドレスがあるかどうかは答え方で分からないようにする。
// - 再設定・招待はメールのリンク。リンクのトークンそのものは保存しない（SHA-256 だけ）。
import { fail, newToken, sha256Hex, hashPassword, verifyPassword, passwordProblem, newSalt, normEmail, iso, audit } from './util.mjs';

export const SITE = 'https://www.stepwise-education.jp';
export async function isLive(c) { const r = await c.db.prepare("select value from settings where key = 'live'").first(); return !!r && r.value === '1'; }
const SESSION_MS = 30 * 86400e3;
const SESSIONS_PER_SUBJECT = 20;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3;
const RESET_MS = 30 * 60e3, INVITE_MS = 7 * 86400e3;

// 種類ごとの違い（表・トークンの頭・画面の場所・目的の名前）
export const KINDS = {
  staff: { table: 'staff', prefix: 's2', page: '/staff/', reset: 'staffReset', invite: 'staffInvite', label: 'スタッフ' },
  family: { table: 'families', prefix: 'f2', page: '/family/', reset: 'familyReset', invite: 'familyInvite', label: '保護者' },
};

async function issueSession(c, kind, subjectId) {
  const token = newToken(KINDS[kind].prefix);
  await c.db.prepare('insert into sessions (tokenHash, kind, subjectId, createdAt, lastSeenAt, expiresAt, userAgent) values (?, ?, ?, ?, ?, ?, ?)')
    .bind(sha256Hex(token), kind, subjectId, iso(c.now), iso(c.now), iso(c.now + SESSION_MS), String(c.userAgent || '').slice(0, 200)).run();
  // 端末が増えすぎたら古いものから外す
  const old = await c.db.prepare('select tokenHash from sessions where kind = ? and subjectId = ? order by lastSeenAt desc limit -1 offset ?').bind(kind, subjectId, SESSIONS_PER_SUBJECT).all();
  if (old.results.length) await c.db.batch(old.results.map(r => c.db.prepare('delete from sessions where tokenHash = ?').bind(r.tokenHash)));
  return token;
}

export async function revokeSessions(c, kind, subjectId, keepHash = '') {
  await c.db.prepare('delete from sessions where kind = ? and subjectId = ? and tokenHash <> ?').bind(kind, subjectId, keepHash).run();
}

// ログイン中か確かめる。返すのは本人の行（停止中・期限切れは null）
export async function readSession(c, kind, token) {
  token = String(token || '');
  if (!token.startsWith(KINDS[kind].prefix + '.') || token.length > 100) return null;
  const hash = sha256Hex(token);
  const s = await c.db.prepare('select * from sessions where tokenHash = ? and kind = ?').bind(hash, kind).first();
  if (!s || s.expiresAt <= iso(c.now)) return null;
  const who = await c.db.prepare(`select * from ${KINDS[kind].table} where id = ?`).bind(s.subjectId).first();
  if (!who || who.status !== 'active') return null;
  // 使っている端末は期限を延ばす（1 時間に 1 回だけ書く）
  if (Date.parse(s.lastSeenAt) < c.now - 3600e3) await c.db.prepare('update sessions set lastSeenAt = ?, expiresAt = ? where tokenHash = ?').bind(iso(c.now), iso(c.now + SESSION_MS), hash).run();
  return { ...who, sessionHash: hash };
}

export async function login(c, kind, { email, password }) {
  const k = KINDS[kind], mail = normEmail(email), pass = String(password || '');
  const generic = () => fail('badLogin', 'メールアドレスかパスワードが違います', 401);
  if (!mail || !pass || pass.length > 128) generic();
  const who = await c.db.prepare(`select * from ${k.table} where email = ?`).bind(mail).first();
  if (who && who.lockUntil && who.lockUntil > iso(c.now)) fail('locked', '続けて間違えたため、しばらくログインできません。15分ほどしてからもう一度試すか、パスワードを再設定してください', 429);
  // ない宛先でも同じだけ計算して、答えの速さで有無が分からないようにする
  const ok = who && who.passHash ? verifyPassword(pass, who.passSalt, who.passHash) : (hashPassword(pass, 'x'), false);
  if (!ok || who.status !== 'active') {
    if (who && who.status === 'active') {
      const count = Number(who.failCount || 0) + 1;
      await c.db.prepare(`update ${k.table} set failCount = ?, lockUntil = ? where id = ?`).bind(count >= LOCK_AFTER ? 0 : count, count >= LOCK_AFTER ? iso(c.now + LOCK_MS) : '', who.id).run();
      if (count >= LOCK_AFTER) { c.actor = { kind, id: who.id }; await audit(c, 'loginLocked', who.id); }
    }
    generic();
  }
  if (who.failCount || who.lockUntil) await c.db.prepare(`update ${k.table} set failCount = 0, lockUntil = '' where id = ?`).bind(who.id).run();
  c.actor = { kind, id: who.id };
  await audit(c, 'login', who.id);
  return { token: await issueSession(c, kind, who.id), who };
}

export async function logout(c, kind, token) {
  const s = await readSession(c, kind, token);
  if (s) await c.db.prepare('delete from sessions where tokenHash = ?').bind(s.sessionHash).run();
  return {};
}

export async function changePassword(c, kind, me, { current, next }) {
  if (!verifyPassword(String(current || ''), me.passSalt, me.passHash)) fail('badPassword', '今のパスワードが違います', 400);
  const problem = passwordProblem(next, me.email); if (problem) fail('weakPassword', problem);
  const salt = newSalt();
  await c.db.prepare(`update ${KINDS[kind].table} set passSalt = ?, passHash = ?, updatedAt = ?, version = version + 1 where id = ?`).bind(salt, hashPassword(next, salt), iso(c.now), me.id).run();
  await revokeSessions(c, kind, me.id, me.sessionHash); // ほかの端末は出し直し
  await audit(c, 'passwordChange', me.id);
  return {};
}

// 招待・再設定のリンクを作ってメールを積む。返すのはリンク（招待はコピーして渡せるように画面にも出す）
export async function issueChallenge(c, kind, purpose, who, mail) {
  const k = KINDS[kind], token = newToken(purpose === k.invite ? 'iv' : 'rs');
  const ms = purpose === k.invite ? INVITE_MS : RESET_MS;
  // 同じ目的の古いリンクは使えなくする
  await c.db.prepare("update authChallenges set usedAt = ? where purpose = ? and subjectId = ? and usedAt = ''").bind(iso(c.now), purpose, who.id).run();
  await c.db.prepare('insert into authChallenges (id, purpose, subjectId, email, tokenHash, expiresAt, createdAt) values (?, ?, ?, ?, ?, ?, ?)')
    .bind(sha256Hex(token).slice(0, 24), purpose, who.id, who.email, sha256Hex(token), iso(c.now + ms), iso(c.now)).run();
  const url = SITE + k.page + '#' + (purpose === k.invite ? 'invite' : 'reset') + '=' + encodeURIComponent(token);
  // 切り替え（settings の live = '1'）より前は、保護者あてのメールは実際には送らない（写した本番のデータで試している間に、本物の保護者へ届かないように）
  const held = kind === 'family' && !(await isLive(c));
  if (mail) c.effects.push({ kind: 'mail', to: who.email, name: 'ステップワイズ英数教室', subject: mail.subject, body: mail.body(url), testOnly: !!who.testOnly, audience: kind, held });
  return url;
}

async function readChallenge(c, purpose, token) {
  token = String(token || '');
  if (!/^(iv|rs)\.[A-Za-z0-9_-]{30,60}$/.test(token)) fail('badLink', 'リンクが正しくありません。メールのリンクを開き直してください', 400);
  const ch = await c.db.prepare('select * from authChallenges where tokenHash = ? and purpose = ?').bind(sha256Hex(token), purpose).first();
  if (!ch || ch.usedAt || ch.expiresAt <= iso(c.now)) fail('expiredLink', 'リンクの期限が切れているか、すでに使われています。もう一度やり直してください', 400);
  return ch;
}

export async function requestReset(c, kind, { email }) {
  const k = KINDS[kind], mail = normEmail(email);
  const who = mail ? await c.db.prepare(`select * from ${k.table} where email = ? and status = 'active'`).bind(mail).first() : null;
  if (who) {
    // 送りすぎない（1 分に 1 回、1 時間に 5 回まで）。超えても答えは同じにする
    const recent = await c.db.prepare('select createdAt from authChallenges where purpose = ? and subjectId = ? and createdAt > ?').bind(k.reset, who.id, iso(c.now - 3600e3)).all();
    const tooSoon = recent.results.some(r => r.createdAt > iso(c.now - 60e3)) || recent.results.length >= 5;
    if (!tooSoon) {
      await issueChallenge(c, kind, k.reset, who, { subject: '【ステップワイズ】パスワードの再設定', body: url => 'パスワードの再設定を受け付けました。30分以内に次のリンクを開き、新しいパスワードを設定してください。\n\n' + url + '\n\n心当たりがない場合は、このメールを破棄してください。パスワードは変わりません。' });
      c.actor = { kind, id: who.id }; await audit(c, 'resetRequested', who.id);
    }
  }
  return { message: '登録されているメールアドレスなら、再設定のメールを送りました。届かないときは迷惑メールのフォルダも確かめてください' };
}

// 再設定・招待の受け入れ（どちらも新しいパスワードを決めてログインする）
async function acceptWithPassword(c, kind, purpose, { token, password }) {
  const k = KINDS[kind], ch = await readChallenge(c, purpose, token);
  const who = await c.db.prepare(`select * from ${k.table} where id = ?`).bind(ch.subjectId).first();
  if (!who || who.status === 'stopped' || who.email !== ch.email) fail('expiredLink', 'リンクの期限が切れているか、すでに使われています。もう一度やり直してください', 400);
  const problem = passwordProblem(password, who.email); if (problem) fail('weakPassword', problem);
  const salt = newSalt();
  await c.db.batch([
    c.db.prepare(`update ${k.table} set passSalt = ?, passHash = ?, status = 'active', failCount = 0, lockUntil = '', updatedAt = ?, version = version + 1 where id = ?`).bind(salt, hashPassword(password, salt), iso(c.now), who.id),
    c.db.prepare('update authChallenges set usedAt = ? where id = ?').bind(iso(c.now), ch.id),
    c.db.prepare('delete from sessions where kind = ? and subjectId = ?').bind(kind, who.id),
  ]);
  c.actor = { kind, id: who.id };
  await audit(c, purpose === k.invite ? 'inviteAccepted' : 'passwordReset', who.id);
  return { token: await issueSession(c, kind, who.id), who: { ...who, status: 'active' } };
}
export const confirmReset = (c, kind, body) => acceptWithPassword(c, kind, KINDS[kind].reset, body);
export const acceptInvite = (c, kind, body) => acceptWithPassword(c, kind, KINDS[kind].invite, body);
export async function inviteInfo(c, kind, { token }) {
  const ch = await readChallenge(c, KINDS[kind].invite, token);
  const who = await c.db.prepare(`select name, email, status from ${KINDS[kind].table} where id = ?`).bind(ch.subjectId).first();
  if (!who || who.status === 'stopped') fail('expiredLink', 'リンクの期限が切れているか、すでに使われています。もう一度やり直してください', 400);
  return { name: who.name, email: who.email };
}
