'use strict';
// 作り直し（v2）2段目: 家族・生徒の管理、保護者・生徒から見た自分の情報、今の台帳からの写し。cf/v2/people.mjs・migrate-identity.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test('a classroom manager registers a family first, then its children; a teacher-only account cannot', async () => {
  const h = await createV2(); const auth = await h.owner();
  const teacher = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  assert.equal((await h.call('admin/families/list', { auth: teacher })).error.code, 'forbidden');
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', guardianName: '架空 花子', email: 'Parent@Example.invalid', phone: '090-0000-0000' })).family;
  assert.deepEqual([fam.status, fam.email, fam.hasPassword], ['invited', 'parent@example.invalid', false]);
  assert.equal((await h.call('admin/families/create', { auth, name: '別の家', email: 'parent@example.invalid' })).error.code, 'duplicate');
  assert.equal((await h.call('admin/students/create', { auth, familyId: fam.id })).error.code, 'needName');
  const a = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', grade: '中2', baseRate30: 1500, deliveryMode: 'online' })).student;
  const b = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '二郎', grade: '小6' })).student;
  assert.equal(a.name, '架空 一郎'); assert.match(a.link, /^https:\/\/www\.stepwise-education\.jp\/student\/\?k=/);
  assert.notEqual(a.link, b.link, '専用リンクは生徒ごとに違う');
  const list = (await h.ok('admin/families/list', { auth })).families;
  assert.deepEqual(list[0].students.map(s => s.givenName), ['一郎', '二郎']);
  assert.equal((await h.call('admin/students/create', { auth, familyId: fam.id, familyName: 'x', baseRate30: -1 })).error.code, 'badRate');
});

test('edits use the version shown on screen, a student can move to another family, and a new link stops the old one', async () => {
  const h = await createV2(); const auth = await h.owner();
  const f1 = (await h.ok('admin/families/create', { auth, name: '一の家' })).family, f2 = (await h.ok('admin/families/create', { auth, name: '二の家' })).family;
  const s = (await h.ok('admin/students/create', { auth, familyId: f1.id, familyName: '架空', givenName: '太郎' })).student;
  const up = (await h.ok('admin/students/update', { auth, id: s.id, version: s.version, grade: '高1', status: 'paused' })).student;
  assert.deepEqual([up.grade, up.status, up.version], ['高1', 'paused', s.version + 1]);
  assert.equal((await h.call('admin/students/update', { auth, id: s.id, version: s.version, grade: '高2' })).error.code, 'conflict');
  const moved = (await h.ok('admin/students/move', { auth, id: s.id, version: up.version, familyId: f2.id })).student;
  assert.equal(moved.familyId, f2.id);
  const code = new URL(moved.link).searchParams.get('k');
  assert.equal((await h.ok('student/me', { k: code })).me.name, '架空 太郎');
  const renewed = (await h.ok('admin/students/newLink', { auth, id: s.id, version: moved.version })).student;
  assert.equal((await h.call('student/me', { k: code })).error.code, 'badLink', '前のリンクは使えない');
  assert.equal((await h.ok('student/me', { k: new URL(renewed.link).searchParams.get('k') })).me.name, '架空 太郎');
  assert.deepEqual(h.rows("select action from auditLog where action like 'student%' order by id").map(r => r.action), ['studentCreate', 'studentUpdate', 'studentMove', 'studentNewLink']);
});

test('parents are invited by mail, but before the switch-over no mail is actually sent to families', async () => {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 });
  const inv = await h.ok('admin/families/invite', { auth, id: fam.id });
  assert.match(inv.inviteUrl, /\/family\/#invite=iv\./); assert.equal(inv.mailHeld, true);
  const mail = h.mails().at(-1);
  assert.deepEqual([mail.status, mail.error], ['dismissed', 'まだ切り替え前のため送らない']);
  const acc = await h.ok('family/invite/accept', { token: h.linkFrom(mail), password: 'family password 1' });
  const kids = (await h.ok('family/students', { auth: acc.auth })).students;
  assert.deepEqual(kids.map(k => k.name), ['架空 一郎']);
  assert.equal(kids[0].baseRate30, undefined, '保護者・生徒には料金や先生用の情報を出さない');
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', ?)").run(new Date(h.clock).toISOString());
  await h.ok('family/reset/request', { email: 'parent@example.invalid' });
  assert.equal(h.mails().at(-1).status, 'pending', '切り替えたあとは送る');
  const stopped = (await h.ok('admin/families/update', { auth, id: fam.id, version: (await h.ok('admin/families/get', { auth, id: fam.id })).family.version, status: 'stopped' })).family;
  assert.equal(stopped.status, 'stopped');
  assert.equal((await h.call('family/students', { auth: acc.auth })).error.code, 'needLogin', '停止したらログインも切れる');
});

// 今の台帳に、写す元のデータを入れる（架空の名前・アドレスだけ）
function seedLegacy(h) {
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  const legacyHash = 'pbkdf2-sha256$1000$' + require('node:crypto').pbkdf2Sync('legacy family pass', 'legacy-salt', 1000, 32, 'sha256').toString('hex');
  q("insert into students (id, name, active, code, rate30, deliveryMode) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500, 'online')");
  q("insert into students (id, name, active, code, rate30, deliveryMode) values ('s2', '架空 二郎', 1, 'code-two-xxxxxxxx', 0, '')");
  q("insert into students (id, name, active, code, rate30, deliveryMode) values ('s3', '【テスト】生徒', 1, 'code-test-xxxxxxx', 1000, 'in_person')");
  q("insert into students (id, name, active, code, rate30, deliveryMode) values ('s4', 'ひとり 三郎', 0, 'code-solo-xxxxxxx', 1200, '')");
  q("insert into studentNames (id, familyName, givenName) values ('s1', '架空', '一郎')");
  q(`insert into "生徒台帳" ("生徒ID", "氏名", "ふりがな", "学年", "学校", "保護者名", "保護者連絡先", "入塾日", "状態", "科目", "備考") values ('s1', '架空 一郎', 'かくう いちろう', '中2', '架空中学校', '架空 花子', '090-0000-0000', '2025/4/1', '在籍', '数学・英語', 'メモ')`);
  q(`insert into "生徒台帳" ("生徒ID", "氏名", "状態") values ('s2', '架空 二郎', '休会')`);
  q("insert into familyAccounts (id, label, status, email, passSalt, passHash, testOnly) values ('A', '架空 一郎さんのグループ', 'active', 'parent@example.invalid', 'legacy-salt', ?, 0)", legacyHash);
  q("insert into familyAccounts (id, label, status, email, testOnly) values ('T', '【テスト】家族', 'pending', '', 1)");
  q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1), ('l2', 'A', 's2', 1), ('l3', 'T', 's3', 1)");
  q("insert into familyProfiles (id, familyName, givenName) values ('A', '架空', '花子')");
}

test('the copy from the current ledger keeps families, children, links and parent passwords, and can be redone', async () => {
  const h = await createV2(); const auth = await h.owner(); seedLegacy(h);
  const teacher = await h.staffWith(auth, ['manager'], 'manager@example.invalid');
  assert.equal((await h.call('admin/migrate/identity/preview', { auth: teacher })).error.code, 'forbidden', '写すのはシステム管理者だけ');
  const pre = await h.ok('admin/migrate/identity/preview', { auth });
  assert.equal(h.rows('select count(*) n from families')[0].n, 0, '見るだけでは書かない');
  const kaku = pre.families.find(f => f.legacyId === 'A');
  assert.deepEqual([kaku.name, kaku.guardianName, kaku.phone, kaku.status, kaku.hasPassword], ['架空家', '架空 花子', '090-0000-0000', 'active', true]);
  assert.deepEqual(kaku.students.map(s => [s.name, s.status, s.baseRate30]), [['架空 一郎', 'enrolled', 1500], ['架空 二郎', 'paused', 0]]);
  assert.equal(kaku.students[0].enrolledOn, '2025-04-01'); assert.equal(kaku.students[0].familyKana, 'かくう');
  assert.ok(pre.problems.some(p => p.includes('ひとり 三郎') && p.includes('新しい家族')));
  assert.ok(pre.problems.some(p => p.includes('架空 二郎') && p.includes('0円')));
  assert.equal(pre.families.find(f => f.legacyId === 'T').testOnly, true);
  assert.equal((await h.call('admin/migrate/identity/apply', { auth })).error.code, 'needConfirm');
  const done = await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  assert.deepEqual([done.families, done.students], [3, 4]);
  // 保護者は今のパスワードのままログインでき、子どもが見える。生徒は今の専用リンクのまま使える
  const fam = await h.ok('family/login', { email: 'parent@example.invalid', password: 'legacy family pass' });
  assert.deepEqual((await h.ok('family/students', { auth: fam.auth })).students.map(s => s.name), ['架空 一郎', '架空 二郎']);
  assert.equal((await h.ok('student/me', { k: 'code-one-xxxxxxxx' })).me.name, '架空 一郎');
  assert.equal((await h.call('student/me', { k: 'code-solo-xxxxxxx' })).error.code, 'badLink', '退会した生徒のリンクは使えない');
  // 写し直し: 同じ結果になり、写した家族のログインは切れる（新しい仕組みで作った家族は残る）
  const mine = (await h.ok('admin/families/create', { auth, name: '新しく作った家' })).family;
  await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  assert.equal(h.rows('select count(*) n from students')[0].n, 4);
  assert.equal(h.rows('select count(*) n from families')[0].n, 4);
  assert.ok(h.rows('select id from families').some(r => r.id === mine.id));
  assert.equal((await h.call('family/students', { auth: fam.auth })).error.code, 'needLogin');
  // 新しい仕組みで作った生徒が写した家族にいるときは、消してしまわないように止める
  await h.ok('admin/students/create', { auth, familyId: 'fa_A', familyName: '新', givenName: '生徒' });
  assert.equal((await h.call('admin/migrate/identity/apply', { auth, confirm: true })).error.code, 'mixed');
});
