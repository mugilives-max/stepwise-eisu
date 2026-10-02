'use strict';
// 作り直し（v2）6段目: 成績（試験・科目ごと・全体・振り返り・成績票）。cf/v2/grades.mjs
// 時計は 2026-10-02 12:00（日本時間）から始まる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', grade: '中2', baseRate30: 1500 })).student;
  const other = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const teacherAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  const teacher = (await h.ok('staff/me', { auth: teacherAuth })).me;
  // 講師が一郎さんの数学を担当している
  await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date: '2026-10-05', start: '17:00', minutes: 60, subject: '数学', deliveryMode: 'in_person', staffId: teacher.id, force: true });
  const k = h.rows('select linkCode from students where id = ?', kid.id)[0].linkCode;
  const exam = async (extra = {}) => (await h.ok('grades/exams/save', { auth, studentId: kid.id, kind: 'regular', name: '1学期期末テスト', date: '2026-07-05', ...extra })).examId;
  return { h, auth, fam, kid, other, parent, teacherAuth, teacher, k, exam };
}

test('managers record everything; teachers see and enter only their subjects plus the total', async () => {
  const { h, auth, kid, other, teacherAuth, exam } = await world();
  const id = await exam({ kind: 'mock', name: '第1回 全県模試', totalDeviation: 58.4 });
  await h.ok('grades/scores/save', { auth, examId: id, scores: [{ subject: '数学', score: 72, max: 100, deviation: 60.1 }, { subject: '英語', score: 65, max: 100, deviation: 55 }] });
  assert.equal((await h.call('grades/scores/save', { auth, examId: id, scores: [{ subject: '国語', score: 120, max: 100 }] })).error.code, 'badNumber', '満点を超える点数は断る');
  await h.ok('grades/reviews/save', { auth, examId: id, good: '計算が速くなった', issues: '英作文', nextSteps: '毎日1題の英作文' });
  const m = (await h.ok('grades/student', { auth, studentId: kid.id })).exams[0];
  assert.deepEqual([m.total.score, m.total.max, m.total.fromSubjects, m.total.deviation], [137, 200, true, 58.4], '全体が空なら科目の合計');
  assert.equal(m.judgments, undefined, '志望校判定は持たない');
  const t = (await h.ok('grades/student', { auth: teacherAuth, studentId: kid.id }));
  assert.deepEqual(t.subjects, ['数学']);
  assert.deepEqual(t.exams[0].scores.map(s => s.subject), ['数学'], 'ほかの科目の点数は見せない');
  assert.deepEqual(t.exams[0].otherSubjects, ['英語']);
  assert.equal(t.exams[0].total.score, 137, '合計は見せる');
  assert.deepEqual(t.exams[0].review, { issues: '英作文', nextSteps: '毎日1題の英作文', version: 1 }, '良かった点は見せない（課題と次の対策）');
  assert.equal((await h.call('grades/scores/save', { auth: teacherAuth, examId: id, scores: [{ subject: '英語', score: 80, max: 100 }] })).error.code, 'forbidden', '担当でない科目は入力できない');
  await h.ok('grades/scores/save', { auth: teacherAuth, examId: id, scores: [{ subject: '数学', score: 75, max: 100 }] });
  assert.equal(h.rows("select score from examScores where subject = '数学'")[0].score, 75);
  await h.ok('grades/reviews/save', { auth: teacherAuth, examId: id, version: 1, issues: '英作文と証明', nextSteps: '証明の型を覚える' });
  assert.equal(h.rows('select good from examReviews')[0].good, '計算が速くなった', '講師が直しても良かった点は消えない');
  assert.equal((await h.call('grades/student', { auth: teacherAuth, studentId: other.id })).error.code, 'forbidden', '担当でない生徒は見られない');
  assert.equal((await h.call('grades/exams/save', { auth: teacherAuth, id, version: h.rows('select version from exams')[0].version, totalScore: 999 })).ok, true);
  assert.equal(h.rows('select totalScore from exams')[0].totalScore, null, '講師は全体の数を変えられない');
  assert.equal((await h.call('grades/exams/save', { auth, studentId: kid.id, kind: 'regular', name: '未来', date: '2026-12-01' })).error.code, 'badDate');
  const ov = await h.ok('grades/overview', { auth: teacherAuth });
  assert.deepEqual(ov.students.map(s => s.name), ['架空 一郎']);
});

test('families see everything with lesson counts; students see scores, next steps and the days to the next test', async () => {
  const { h, auth, kid, parent, k, exam } = await world();
  const id = await exam();
  await h.ok('grades/scores/save', { auth, examId: id, scores: [{ subject: '数学', score: 80, max: 100, average: 61.2, rank: 12, rankOf: 150 }] });
  await h.ok('grades/reviews/save', { auth, examId: id, good: 'よい', issues: '課題', nextSteps: '次はこれ' });
  await h.ok('family/events/add', { auth: parent, studentId: kid.id, kind: 'test', date: '2026-10-20', dateTo: '2026-10-21', title: '2学期中間テスト' });
  const fam = (await h.ok('family/grades', { auth: parent })).students.find(s => s.id === kid.id);
  assert.deepEqual([fam.exams[0].scores[0].rank, fam.exams[0].review.good], [12, 'よい']);
  assert.deepEqual([fam.nextTest.title, fam.nextTest.days], ['2学期中間テスト', 18]);
  assert.ok(fam.lessons[0], '試験ごとに、その前の授業の回数');
  const st = await h.ok('student/grades', { k });
  assert.deepEqual(st.exams[0].review, { nextSteps: '次はこれ' }, '生徒には次の対策だけ');
  assert.equal(st.nextTest.days, 18);
});

test('score sheets go to the shared file store, wait for import, and only the right people can open them', async () => {
  const { h, auth, kid, parent, k } = await world();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(991, 1)]);
  assert.equal((await h.call('family/grades/upload', { auth: parent, studentId: kid.id, name: 'a.exe', mime: 'application/x-msdownload', size: 3 })).error.code, 'badType');
  const st = await h.ok('family/grades/upload', { auth: parent, studentId: kid.id, name: '中間 個票.pdf', mime: 'application/pdf', size: pdf.length, note: '2学期中間' });
  assert.match(st.uploadUrl, /^files\/put\?t=ft\./);
  assert.equal((await h.ok('grades/overview', { auth })).files.length, 0, '中身が届くまでは一覧に出ない');
  const put = await h.raw('POST', st.uploadUrl, pdf);
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal((await h.raw('POST', st.uploadUrl, pdf)).status, 403, '送る鍵は1回だけ');
  assert.match(h.mails().at(-1).subject, /成績票/);
  const ov = await h.ok('grades/overview', { auth });
  assert.deepEqual(ov.files.map(f => [f.name, f.status, f.uploadedByKind]), [['中間 個票.pdf', 'new', 'family']]);
  const link = await h.ok('files/link', { auth, id: st.fileId });
  const got = await h.raw('GET', link.url);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), pdf);
  assert.equal((await h.ok('files/link', { auth: parent, id: st.fileId })).name, '中間 個票.pdf', '保護者も開ける');
  assert.equal((await h.call('files/link', { k, id: st.fileId })).error.code, 'notFound', '生徒は自分が送ったものだけ');
  // 生徒の写真
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 2)]);
  const mine = await h.ok('student/grades/upload', { k, name: 'photo.jpg', mime: 'image/jpeg', size: jpg.length });
  assert.equal((await h.raw('POST', mine.uploadUrl, jpg)).status, 200);
  assert.equal((await h.ok('student/grades', { k })).files.length, 1);
  assert.ok((await h.ok('files/link', { k, id: mine.fileId })).url);
  await h.ok('grades/files/resolve', { auth, id: st.fileId, status: 'imported' });
  assert.deepEqual((await h.ok('grades/overview', { auth })).files.map(f => f.name), ['photo.jpg'], '取り込んだら一覧から外れる');
  assert.equal((await h.ok('family/grades', { auth: parent })).students.find(s => s.id === kid.id).files.length, 2);
});

test('tests shared by families wait for results until recorded or marked as no result, and reminders go out only after the switch-over', async () => {
  const { h, auth, kid, parent, teacherAuth, teacher } = await world();
  await h.ok('family/events/add', { auth: parent, studentId: kid.id, kind: 'test', date: '2026-10-05', dateTo: '2026-10-06', title: '2学期中間テスト' });
  const ev = h.rows("select id from sharedEvents where kind = 'test'")[0].id;
  h.clock = Date.parse('2026-10-07T12:00:00+09:00');
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  assert.equal((await runV2Scheduled(h.env, Date.parse('2026-10-07T00:10:00+09:00'))).tests.skipped, 'notLive');
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', '')").run();
  const before = h.mails().length;
  assert.equal((await runV2Scheduled(h.env, Date.parse('2026-10-07T00:10:00+09:00'))).tests.tests, 1);
  const sent = h.mails().slice(before).map(m => m.to);
  assert.ok(sent.includes('owner@example.invalid') && sent.includes('teacher@example.invalid'), '教室管理者と担当の講師に');
  assert.equal((await h.ok('grades/overview', { auth: teacherAuth })).pendingTests.length, 1);
  const id = (await h.ok('grades/exams/save', { auth: teacherAuth, studentId: kid.id, kind: 'regular', name: '2学期中間テスト', date: '2026-10-06', eventId: ev })).examId;
  assert.equal((await h.ok('grades/overview', { auth })).pendingTests.length, 0, '試験を作ると待ちから外れる');
  await h.ok('grades/exams/delete', { auth, id, version: 1 });
  await h.ok('grades/tests/skip', { auth: teacherAuth, eventId: ev });
  assert.equal((await h.ok('grades/overview', { auth })).pendingTests.length, 0, '「結果なし」でも外れる');
  assert.equal((await h.ok('grades/student', { auth, studentId: kid.id })).exams.length, 0, '「結果なし」は成績に出ない');
  assert.ok(teacher);
});
