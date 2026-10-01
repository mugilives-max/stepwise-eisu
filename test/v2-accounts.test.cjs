'use strict';
// 作り直し（v2）1段目: スタッフと保護者のログイン、再設定、招待、役割、最初の1人の設定。cf/v2/*.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createD1 } = require('./helpers/d1-harness.cjs');

const T0 = Date.parse('2026-10-02T03:00:00Z');
let clock = T0;
async function fixture({ legacy = true } = {}) {
  const util = await import('../cf/v2/util.mjs');
  util.setPasswordIterationsForTest(1000); // テストを速くするため（本番は 600,000 回）
  const { handleV2 } = await import('../cf/v2/index.mjs');
  const db2 = createD1({ dir: 'migrations-v2' }), db = createD1();
  if (legacy) for (const [k, v] of [['adminToken', 'legacy-teacher-token'], ['adminTokenExp', String(T0 + 86400e3)], ['teacherEmail', 'Owner@Example.invalid']])
    db._sqlite.prepare('insert into config (key, value) values (?, ?)').run(k, v);
  const env = { DB: db, DB2: db2 }, waits = [];
  clock = T0;
  const realNow = Date.now;
  const call = async (route, body = {}) => {
    Date.now = () => clock;
    try {
      const res = await handleV2(new Request('https://api.example.invalid/v2/' + route, { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil: p => waits.push(p) });
      return { status: res.status, ...(await res.json()) };
    } finally { Date.now = realNow; }
  };
  const rows = (sql, ...a) => db2._sqlite.prepare(sql).all(...a);
  const mails = () => rows("select payload, status from effects where kind = 'mail' order by id").map(r => ({ ...JSON.parse(r.payload), status: r.status }));
  const linkFrom = mail => decodeURIComponent(mail.body.match(/#(?:invite|reset)=([^\s]+)/)[1]);
  return { call, rows, mails, linkFrom, util, db2, env };
}
async function owner(f) {
  const boot = await f.call('staff/bootstrap', { legacyToken: 'legacy-teacher-token' });
  assert.equal(boot.ok, true, JSON.stringify(boot));
  const token = decodeURIComponent(boot.inviteUrl.split('#invite=')[1]);
  const r = await f.call('staff/invite/accept', { token, password: 'correct horse battery' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.auth;
}

test('the first account is created only from a device logged into the current admin, and the owner sets the password', async () => {
  const f = await fixture();
  assert.equal((await f.call('staff/bootstrap/status')).available, true);
  assert.equal((await f.call('staff/bootstrap', { legacyToken: 'wrong' })).error.code, 'needLegacyLogin');
  const boot = await f.call('staff/bootstrap', { legacyToken: 'legacy-teacher-token' });
  assert.match(boot.inviteUrl, /^https:\/\/www\.stepwise-education\.jp\/staff\/#invite=iv\./);
  assert.equal(f.mails().length, 0, '最初の1人はメールを送らず、その場で設定する');
  const token = decodeURIComponent(boot.inviteUrl.split('#invite=')[1]);
  assert.deepEqual(await f.call('staff/invite/info', { token }).then(r => [r.name, r.email]), ['代表', 'owner@example.invalid']);
  assert.equal((await f.call('staff/invite/accept', { token, password: 'short' })).error.code, 'weakPassword');
  const acc = await f.call('staff/invite/accept', { token, password: 'correct horse battery' });
  assert.deepEqual(acc.me.roles, ['teacher', 'manager', 'sysadmin']);
  assert.match(acc.auth, /^s2\./);
  assert.equal((await f.call('staff/invite/accept', { token, password: 'correct horse battery' })).error.code, 'expiredLink', 'リンクは1回だけ');
  assert.equal((await f.call('staff/bootstrap/status')).available, false);
  assert.equal((await f.call('staff/bootstrap', { legacyToken: 'legacy-teacher-token' })).error.code, 'already');
  const stored = f.rows('select passHash from staff')[0].passHash;
  assert.match(stored, /^pbkdf2-sha256\$1000\$[a-f0-9]{64}$/);
  assert.equal(f.rows('select count(*) n from sessions')[0].n, 1);
  assert.equal(JSON.stringify(f.rows('select * from sessions')).includes(acc.auth), false, 'トークンそのものは保存しない');
});

test('login works per device, locks after five wrong passwords, and does not reveal unknown emails', async () => {
  const f = await fixture(); await owner(f);
  const a = await f.call('staff/login', { email: 'OWNER@example.invalid', password: 'correct horse battery' });
  const b = await f.call('staff/login', { email: 'owner@example.invalid', password: 'correct horse battery' });
  assert.ok(a.auth && b.auth && a.auth !== b.auth, '端末ごとにログインできる');
  assert.equal((await f.call('staff/me', { auth: a.auth })).me.name, '代表');
  const unknown = await f.call('staff/login', { email: 'nobody@example.invalid', password: 'whatever whatever' });
  const wrong = await f.call('staff/login', { email: 'owner@example.invalid', password: 'wrong password!!' });
  assert.deepEqual([unknown.status, unknown.error.message], [wrong.status, wrong.error.message], 'ない宛先と間違いは同じ答え');
  for (let i = 0; i < 4; i++) await f.call('staff/login', { email: 'owner@example.invalid', password: 'wrong password!!' });
  const locked = await f.call('staff/login', { email: 'owner@example.invalid', password: 'correct horse battery' });
  assert.equal(locked.error.code, 'locked');
  clock += 16 * 60e3;
  assert.equal((await f.call('staff/login', { email: 'owner@example.invalid', password: 'correct horse battery' })).ok, true, '15分たてば入れる');
  await f.call('staff/logout', { auth: a.auth });
  assert.equal((await f.call('staff/me', { auth: a.auth })).error.code, 'needLogin');
  assert.equal((await f.call('staff/me', { auth: b.auth })).ok, true, 'ほかの端末はそのまま');
});

test('password reset by mail: same answer for unknown emails, rate limited, one-time link, other devices signed out', async () => {
  const f = await fixture(); const first = await owner(f);
  const unknown = await f.call('staff/reset/request', { email: 'nobody@example.invalid' });
  const known = await f.call('staff/reset/request', { email: 'owner@example.invalid' });
  assert.equal(unknown.message, known.message);
  assert.equal(f.mails().length, 1);
  await f.call('staff/reset/request', { email: 'owner@example.invalid' });
  assert.equal(f.mails().length, 1, '1分以内は送り直さない');
  const mail = f.mails()[0];
  assert.equal(mail.to, 'owner@example.invalid'); assert.match(mail.subject, /パスワードの再設定/);
  const link = f.linkFrom(mail);
  clock += 31 * 60e3;
  assert.equal((await f.call('staff/reset/confirm', { token: link, password: 'another strong pass' })).error.code, 'expiredLink', '30分で切れる');
  clock += 60e3;
  await f.call('staff/reset/request', { email: 'owner@example.invalid' });
  const fresh = f.linkFrom(f.mails().at(-1));
  const done = await f.call('staff/reset/confirm', { token: fresh, password: 'another strong pass' });
  assert.equal(done.ok, true);
  assert.equal((await f.call('staff/me', { auth: first })).error.code, 'needLogin', '再設定したら前の端末は出し直し');
  assert.equal((await f.call('staff/login', { email: 'owner@example.invalid', password: 'another strong pass' })).ok, true);
});

test('only a system admin manages staff; roles are checked on the server; the last system admin cannot be removed', async () => {
  const f = await fixture(); const auth = await owner(f);
  const inv = await f.call('admin/staff/invite', { auth, name: '福地', email: 'teacher@example.invalid', roles: ['teacher'] });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.match(f.mails().at(-1).body, /パスワードを決めてください/);
  assert.equal((await f.call('admin/staff/invite', { auth, name: '同じ', email: 'TEACHER@example.invalid', roles: ['teacher'] })).error.code, 'duplicate');
  assert.equal((await f.call('admin/staff/invite', { auth, name: 'x', email: 'x@example.invalid', roles: ['boss'] })).error.code, 'badRoles');
  const t = await f.call('staff/invite/accept', { token: f.linkFrom(f.mails().at(-1)), password: 'teacher password 1' });
  assert.deepEqual(t.me.roles, ['teacher']);
  assert.equal((await f.call('admin/staff/list', { auth: t.auth })).error.code, 'forbidden', '講師はスタッフを管理できない');
  const list = (await f.call('admin/staff/list', { auth })).staff;
  const me = list.find(s => s.email === 'owner@example.invalid'), teacher = list.find(s => s.email === 'teacher@example.invalid');
  assert.equal((await f.call('admin/staff/update', { auth, id: me.id, version: me.version, roles: ['teacher', 'manager'] })).error.code, 'lastSysadmin');
  assert.equal((await f.call('admin/staff/update', { auth, id: teacher.id, version: teacher.version + 1, roles: ['teacher', 'manager'] })).error.code, 'conflict', '古い画面からの変更は断る');
  const stop = await f.call('admin/staff/update', { auth, id: teacher.id, version: teacher.version, status: 'stopped' });
  assert.equal(stop.staff.status, 'stopped');
  assert.equal((await f.call('staff/me', { auth: t.auth })).error.code, 'needLogin', '停止したらログインも切れる');
  assert.equal((await f.call('staff/login', { email: 'teacher@example.invalid', password: 'teacher password 1' })).error.code, 'badLogin');
  assert.ok(f.rows("select action from auditLog").map(r => r.action).includes('staffUpdate'), '監査の記録が残る');
});

test('families log in the same way, and test families never get real mail', async () => {
  const f = await fixture();
  const now = new Date(T0).toISOString(), salt = 'fixedsalt';
  const hash = f.util.hashPassword('family password 1', salt);
  f.db2._sqlite.prepare('insert into families (id, name, email, passSalt, passHash, status, testOnly, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('fa_test', '【テスト】家族', 'family@example.invalid', salt, hash, 'active', 1, now, now);
  const r = await f.call('family/login', { email: 'family@example.invalid', password: 'family password 1' });
  assert.match(r.auth, /^f2\./);
  assert.equal((await f.call('staff/me', { auth: r.auth })).error.code, 'needLogin', '保護者のトークンではスタッフの操作はできない');
  await f.call('family/reset/request', { email: 'family@example.invalid' });
  assert.equal(f.mails()[0].status, 'dismissed', 'テスト用の家族にはメールを送らない');
  assert.match(f.mails()[0].body, /https:\/\/www\.stepwise-education\.jp\/family\/#reset=rs\./);
});

test('passwords made by the current system (600,000 rounds) still verify, so families need not register again', async () => {
  const { verifyPassword, hashPassword } = await import('../cf/v2/util.mjs');
  const { pbkdf2Sync } = require('node:crypto');
  const legacy = 'pbkdf2-sha256$2000$' + pbkdf2Sync('今のパスワード123', 'salt-1', 2000, 32, 'sha256').toString('hex');
  assert.equal(verifyPassword('今のパスワード123', 'salt-1', legacy), true);
  assert.equal(verifyPassword('ちがうパスワード', 'salt-1', legacy), false);
  assert.equal(hashPassword('x', 'y', 2000), 'pbkdf2-sha256$2000$' + pbkdf2Sync('x', 'y', 2000, 32, 'sha256').toString('hex'));
});

test('unknown routes and bad bodies are refused without detail', async () => {
  const f = await fixture();
  assert.equal((await f.call('nothing/here')).status, 404);
  const { handleV2 } = await import('../cf/v2/index.mjs');
  const res = await handleV2(new Request('https://x.invalid/v2/staff/login', { method: 'POST', body: '{' }), f.env, null);
  assert.equal(res.status, 400);
  const noDb = await handleV2(new Request('https://x.invalid/v2/staff/login', { method: 'POST', body: '{}' }), {}, null);
  assert.equal(noDb.status, 503);
});
