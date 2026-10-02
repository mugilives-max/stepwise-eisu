'use strict';
// 作り直し（v2）9段目: 切り替えのボタン（cf/v2/cutover.mjs）と、今の仕組みを読むだけにする関所（cf/worker/cutover.mjs）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test.before(async () => { const { generate } = await import('../scripts/build-gas-bundle.mjs'); generate(); });

async function legacyWorld() {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500), ('s2', '見本 花子', 1, 'code-two-xxxxxxxx', 1500)");
  q("insert into familyAccounts (id, label, status, email) values ('A', 'x', 'pending', 'a@example.invalid'), ('B', 'y', 'pending', 'b@example.invalid')");
  q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1), ('l2', 'B', 's2', 1)");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode, eventId) values ('a', '2026-10-20', '17:00', 60, 'booked', 's1', '', '英語', 'in_person', 'gcal-a'), ('b', '2026-10-21', '17:00', 60, 'booked', 's2', '', '数学', 'online', '')");
  return { h, auth, q };
}

test('cutover freezes the current system, copies once more, checks, goes live, makes missing calendar events and can invite families', async () => {
  const { h, auth } = await legacyWorld();
  assert.equal((await h.call('admin/cutover/apply', { auth, confirm: 'はい' })).error.code, 'needConfirm');
  const r = await h.ok('admin/cutover/apply', { auth, confirm: '切り替える', sendInvites: true });
  assert.deepEqual([r.live, r.copied.lessons, r.calendarCreated, r.invited], [true, 2, 1, 2], '予定のない決定の授業だけカレンダーを作る');
  assert.equal(h.rows("select value from settings where key = 'live'")[0].value, '1');
  assert.ok(h.db._sqlite.prepare("select value from config where key = 'v2CutoverAt'").get().value, '今の仕組みは読むだけ');
  const cal = h.rows("select payload, status from effects where kind = 'calendarCreate'");
  assert.equal(cal.length, 1); assert.notEqual(cal[0].status, 'dismissed', '切り替えたあとは止めない');
  const invites = h.mails().filter(m => /登録/.test(m.subject));
  assert.equal(invites.length, 2); assert.ok(invites.every(m => m.status !== 'dismissed'), '登録の案内は本当に送る');
  assert.equal((await h.call('admin/cutover/apply', { auth, confirm: '切り替える' })).error.code, 'already');
  assert.equal((await h.call('admin/migrate/all/apply', { auth, confirm: true })).error.code, 'live', '切り替えたあとは写し直さない');
  // 元に戻す
  assert.equal((await h.call('admin/cutover/rollback', { auth, confirm: 'x' })).error.code, 'needConfirm');
  await h.ok('admin/cutover/rollback', { auth, confirm: '元に戻す' });
  assert.equal(h.rows("select value from settings where key = 'live'")[0].value, '0');
  assert.equal(h.db._sqlite.prepare("select count(*) n from config where key = 'v2CutoverAt'").get().n, 0);
});

test('when the check finds a real difference, nothing is switched and the current system stays writable', async () => {
  const { h, auth, q } = await legacyWorld();
  // 写す道具が読めない授業（日付がおかしい）は写されず、照らし合わせで「違う」になる
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('bad', 'いつか', '17:00', 60, 'booked', 's1', '', '英語', 'in_person')");
  const r = await h.call('admin/cutover/apply', { auth, confirm: '切り替える' });
  assert.equal(r.error.code, 'checkFailed');
  assert.match(r.error.message, /授業/);
  assert.equal(h.rows("select count(*) n from settings where key = 'live' and value = '1'")[0].n, 0);
  assert.equal(h.db._sqlite.prepare("select count(*) n from config where key = 'v2CutoverAt'").get().n, 0, '今の仕組みは元のまま');
});

test('the current system refuses writes after the switch but keeps reading, admin login and the health flag', async () => {
  const { h, auth } = await legacyWorld();
  const worker = (await import('../cf/worker/index.mjs')).default;
  const env = { ...h.env, WRITE_MODE: 'worker', ALLOW_ORIGIN: 'https://www.stepwise-education.jp' };
  const post = body => worker.fetch(new Request('https://api.invalid/', { method: 'POST', body: JSON.stringify(body) }), env, { waitUntil() {} }).then(r => r.json());
  const health = async () => (await (await worker.fetch(new Request('https://api.invalid/'), env, { waitUntil() {} })).json()).cutover;
  assert.deepEqual(await health(), { live: false, oldReadOnlySince: '' });
  const before = await post({ action: 'admin', op: 'setFee', token: 'x', studentId: 's1', rate30: 1600 });
  assert.notEqual(before.errorCode, 'movedToV2', '切り替える前は今までどおり');
  await h.ok('admin/cutover/apply', { auth, confirm: '切り替える' });
  const h2 = await health();
  assert.equal(h2.live, true); assert.ok(h2.oldReadOnlySince);
  const after = await post({ action: 'admin', op: 'setFee', token: 'x', studentId: 's1', rate30: 1600 });
  assert.equal(after.errorCode, 'movedToV2', '書き込みは断る');
  const login = await post({ action: 'admin', op: 'login', password: 'wrong' });
  assert.notEqual(login.errorCode, 'movedToV2', '管理画面のログインは通す（読むだけで使うため）');
});
