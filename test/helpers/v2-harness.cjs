'use strict';
// 作り直し（v2）のテストの土台。今の台帳（DB）と新しい台帳（DB2）をメモリの SQLite で用意し、/v2/ を呼ぶ。
// パスワードの計算はテストを速くするため 1000 回にする（本番は 600,000 回）。
const assert = require('node:assert/strict');
const { createD1 } = require('./d1-harness.cjs');

const T0 = Date.parse('2026-10-02T03:00:00Z');

async function createV2({ legacyConfig = true } = {}) {
  const util = await import('../../cf/v2/util.mjs');
  util.setPasswordIterationsForTest(1000);
  const { handleV2 } = await import('../../cf/v2/index.mjs');
  const db = createD1(), db2 = createD1({ dir: 'migrations-v2' });
  if (legacyConfig) for (const [k, v] of [['adminToken', 'legacy-teacher-token'], ['adminTokenExp', String(T0 + 86400e3)], ['teacherEmail', 'owner@example.invalid']])
    db._sqlite.prepare('insert into config (key, value) values (?, ?)').run(k, v);
  const env = { DB: db, DB2: db2 }, h = { clock: T0, env, db, db2, util };
  h.call = async (route, body = {}) => {
    const realNow = Date.now; Date.now = () => h.clock;
    try {
      const res = await handleV2(new Request('https://api.example.invalid/v2/' + route, { method: 'POST', body: JSON.stringify(body) }), env, null);
      return { status: res.status, ...(await res.json()) };
    } finally { Date.now = realNow; }
  };
  h.ok = async (route, body) => { const r = await h.call(route, body); assert.equal(r.ok, true, route + ' ' + JSON.stringify(r)); return r; };
  h.rows = (sql, ...a) => db2._sqlite.prepare(sql).all(...a);
  h.mails = () => h.rows("select payload, status, error from effects where kind = 'mail' order by id").map(r => ({ ...JSON.parse(r.payload), status: r.status, error: r.error }));
  h.linkFrom = mail => decodeURIComponent(mail.body.match(/#(?:invite|reset)=([^\s]+)/)[1]);
  // 代表（3つの役割）でログインしたトークン
  h.owner = async () => {
    const boot = await h.ok('staff/bootstrap', { legacyToken: 'legacy-teacher-token' });
    return (await h.ok('staff/invite/accept', { token: decodeURIComponent(boot.inviteUrl.split('#invite=')[1]), password: 'correct horse battery' })).auth;
  };
  // 指定した役割のスタッフを招待して、ログインしたトークンを返す
  h.staffWith = async (auth, roles, email) => {
    await h.ok('admin/staff/invite', { auth, name: roles.join('+'), email, roles });
    return (await h.ok('staff/invite/accept', { token: h.linkFrom(h.mails().at(-1)), password: 'staff password 123' })).auth;
  };
  return h;
}

module.exports = { createV2, T0 };
