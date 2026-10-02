'use strict';
// 作り直し（v2）: ファイルの置き場所（すべての領域で共通）。cf/v2/files.mjs
// だれが開けるか・中身の確かめ・鍵の期限・お金の書類の保存期間・片づけ。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function world() {
  const h = await createV2(); const auth = await h.owner();
  const famA = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'a@example.invalid' })).family;
  const famB = (await h.ok('admin/families/create', { auth, name: '見本家', email: 'b@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: famA.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const login = async fam => (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const a = await login(famA), b = await login(famB);
  const teacherAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  const teacher = (await h.ok('staff/me', { auth: teacherAuth })).me;
  const files = await import('../cf/v2/files.mjs');
  const c = { env: h.env, db: h.env.DB2, now: h.clock, effects: [], actor: { kind: 'system', id: 'test' } };
  return { h, auth, famA, famB, kid, a, b, teacherAuth, teacher, files, c };
}
const pdf = n => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 7)]);

test('who can open what is decided by the kind of file, in one place', async () => {
  const { h, auth, famA, kid, a, b, teacherAuth, teacher, files, c } = await world();
  const inv = await files.putGenerated(c, { category: 'invoice', familyId: famA.id, refType: 'invoice', refId: 'iv_x', name: '請求書 2026年9月.pdf', mime: 'application/pdf', bytes: pdf(50) });
  const pay = await files.putGenerated(c, { category: 'payStatement', staffId: teacher.id, refType: 'payrollMonth', refId: 'pm_x', name: '支払明細.pdf', mime: 'application/pdf', bytes: pdf(50) });
  const k = h.rows('select linkCode from students where id = ?', kid.id)[0].linkCode;
  const can = async (body, id) => (await h.call('files/link', { ...body, id })).ok === true;
  assert.deepEqual([await can({ auth }, inv), await can({ auth: a }, inv), await can({ auth: b }, inv), await can({ auth: teacherAuth }, inv), await can({ k }, inv)], [true, true, false, false, false], '請求書: 教室管理者とその家族だけ');
  assert.deepEqual([await can({ auth }, pay), await can({ auth: teacherAuth }, pay), await can({ auth: a }, pay)], [true, true, false], '支払明細: 教室管理者とその講師だけ');
  assert.equal((await h.call('files/link', { id: inv })).error.code, 'needLogin');
  const row = h.rows('select * from files where id = ?', inv)[0];
  assert.equal(row.retainUntil, '2033-10-02', 'お金の書類は7年');
  assert.equal(h.env.FILES._m.has('f/' + inv), true, '置き場所の名前は番号だけ（名前や家族を入れない）');
  assert.equal((await h.call('files/delete', { auth, id: inv })).error.code, 'retained');
  assert.equal((await h.call('files/delete', { auth: a, id: inv })).error.code, 'forbidden');
});

test('uploads are checked: the declared type must match the contents, the size must match, and keys expire', async () => {
  const { h, kid, a } = await world();
  const fake = Buffer.from('<html>not a pdf</html>');
  let st = await h.ok('family/grades/upload', { auth: a, studentId: kid.id, name: 'x.pdf', mime: 'application/pdf', size: fake.length });
  const r = await h.raw('POST', st.uploadUrl, fake);
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'badType', '中身が PDF でなければ断る');
  st = await h.ok('family/grades/upload', { auth: a, studentId: kid.id, name: 'y.pdf', mime: 'application/pdf', size: 999 });
  assert.equal((await (await h.raw('POST', st.uploadUrl, pdf(10))).json()).error.code, 'badSize');
  st = await h.ok('family/grades/upload', { auth: a, studentId: kid.id, name: 'z.pdf', mime: 'application/pdf', size: pdf(10).length });
  h.clock += 11 * 60e3;
  assert.equal((await h.raw('POST', st.uploadUrl, pdf(10))).status, 403, '送る鍵は10分');
  assert.equal((await h.call('family/grades/upload', { auth: a, studentId: kid.id, name: 'big.pdf', mime: 'application/pdf', size: 30 * 1024 * 1024 })).error.code, 'tooLarge');
  // 送られなかった行は翌日に片づける
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  const res = await runV2Scheduled(h.env, h.clock + 2 * 86400e3);
  assert.equal(res.files.removed, 3);
  assert.equal(h.rows("select count(*) n from files where status = 'pending'")[0].n, 0);
  assert.equal(h.rows('select count(*) n from examFiles')[0].n, 0);
});

test('an opening link works for five minutes and then stops', async () => {
  const { h, auth, famA, files, c } = await world();
  const id = await files.putGenerated(c, { category: 'contract', familyId: famA.id, name: '受講規約への同意.pdf', mime: 'application/pdf', bytes: pdf(20) });
  const link = await h.ok('files/link', { auth, id });
  const ok = await h.raw('GET', link.url);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal((await h.raw('GET', link.url)).status, 200, '5分のあいだは何度でも（PDF の表示のため）');
  h.clock += 6 * 60e3;
  assert.equal((await h.raw('GET', link.url)).status, 403);
  assert.equal((await h.raw('GET', 'files/get?t=nonsense')).status, 403);
  assert.equal((await h.raw('POST', 'files/get?t=x')).status, 405);
});
