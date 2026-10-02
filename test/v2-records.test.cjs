'use strict';
// 作り直し（v2）4段目: 授業記録・宿題・引き継ぎメモ、今の台帳からの写し。cf/v2/records.mjs・migrate-records.mjs
// 時計は 2026-10-02 12:00（日本時間）から始まる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const teacherAuth = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  const teacher = (await h.ok('staff/me', { auth: teacherAuth })).me;
  const make = async (date, start, staffId = teacher.id, subject = '数学') => {
    await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date, start, minutes: 60, subject, deliveryMode: 'in_person', staffId, force: true });
    const l = h.rows('select * from lessons where date = ? and start = ?', date, start)[0];
    await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
    return h.rows('select * from lessons where id = ?', l.id)[0];
  };
  return { h, auth, kid, parent, teacherAuth, teacher, make, k: new URL(kid.link).searchParams.get('k') };
}

test('a teacher writes a draft, then publishes; families see only the published version and the homework', async () => {
  const { h, auth, parent, teacherAuth, make, k } = await world();
  const l = await make('2026-10-02', '09:00'); await make('2026-10-09', '17:00');
  const ctx = await h.ok('records/lesson', { auth: teacherAuth, lessonId: l.id });
  assert.equal(ctx.record, null); assert.equal(ctx.nextSameSubject.date, '2026-10-09');
  const draft = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, range: '一次関数', comment: '下書きのコメント', staffNotes: { understanding: '4', memo: '集中していた' }, homework: [{ title: 'ワーク p.10-12', material: 'ワーク', dueMode: 'nextLesson', dueSubject: '数学' }] });
  assert.equal(draft.record.status, 'draft');
  assert.equal((await h.ok('family/learning', { auth: parent })).records.length, 0, '下書きは見せない');
  assert.equal((await h.ok('family/learning', { auth: parent })).homework.length, 0, '下書きの宿題も見せない');
  const hwId = (await h.ok('records/lesson', { auth: teacherAuth, lessonId: l.id })).homework[0].id;
  assert.equal((await h.call('records/save', { auth: teacherAuth, lessonId: l.id, version: draft.record.version, comment: '', publish: true })).error.code, 'needComment');
  const pub = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, version: draft.record.version, range: '一次関数', comment: 'よくできました', parentMessage: '次回は小テストです', staffNotes: { memo: '集中していた' }, homework: [{ id: hwId, title: 'ワーク p.10-13', dueMode: 'nextLesson', dueSubject: '数学' }], publish: true });
  assert.equal(pub.record.status, 'published');
  assert.equal(h.rows('select status from lessons where id = ?', l.id)[0].status, 'done', '公開すると実施済み');
  const fam = await h.ok('family/learning', { auth: parent });
  assert.deepEqual([fam.records[0].comment, fam.records[0].parentMessage, fam.records[0].staffNotes], ['よくできました', '次回は小テストです', undefined], '講師用のメモは見せない');
  assert.deepEqual([fam.homework[0].title, fam.homework[0].due], ['ワーク p.10-13', '2026-10-09'], '期限は次の数学の授業の日');
  await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, version: pub.record.version, range: '一次関数', comment: '直している途中', homework: [{ id: hwId, title: 'ワーク p.10-13', dueMode: 'nextLesson', dueSubject: '数学' }] });
  assert.equal((await h.ok('family/learning', { auth: parent })).records[0].comment, 'よくできました', '公開したあとで直しても、もう一度公開するまでは前の版のまま');
  assert.equal((await h.ok('student/learning', { k })).records.length, 1);
});

test('homework: done reported by the student or parent, confirmed or sent back by the teacher', async () => {
  const { h, auth, parent, teacherAuth, make, k } = await world();
  const l = await make('2026-10-02', '09:00');
  await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, comment: '記録', homework: [{ title: '音読', dueMode: 'none' }], publish: true });
  const hw = (await h.ok('student/learning', { k })).homework[0];
  await h.ok('student/homework/report', { k, id: hw.id });
  assert.equal((await h.ok('homework/reported', { auth: teacherAuth })).homework.length, 1);
  const cur = h.rows('select * from homework where id = ?', hw.id)[0];
  assert.equal((await h.call('homework/review', { auth: teacherAuth, id: hw.id, version: cur.version, action: 'redo' })).error.code, 'needNote');
  await h.ok('homework/review', { auth: teacherAuth, id: hw.id, version: cur.version, action: 'redo', note: '後半をもう一度' });
  const back = (await h.ok('family/learning', { auth: parent })).homework[0];
  assert.deepEqual([back.status, back.reviewNote], ['open', '後半をもう一度']);
  await h.ok('family/homework/report', { auth: parent, id: hw.id });
  await h.ok('family/homework/report', { auth: parent, id: hw.id, undo: true });
  await h.ok('family/homework/report', { auth: parent, id: hw.id });
  const again = h.rows('select * from homework where id = ?', hw.id)[0];
  await h.ok('homework/review', { auth, id: hw.id, version: again.version, action: 'confirm' });
  assert.equal((await h.call('family/homework/report', { auth: parent, id: hw.id, undo: true })).error.code, 'badStatus', '確認したあとは取り消せない');
});

test('teachers write only their own lessons; records wait until the lesson day; managers can void with a reason', async () => {
  const { h, auth, teacherAuth, make } = await world();
  const owner = (await h.ok('staff/me', { auth })).me;
  const mine = await make('2026-10-02', '09:00'), others = await make('2026-10-02', '11:00', owner.id), future = await make('2026-10-05', '17:00');
  assert.equal((await h.call('records/lesson', { auth: teacherAuth, lessonId: others.id })).error.code, 'forbidden');
  assert.equal((await h.call('records/save', { auth: teacherAuth, lessonId: future.id, comment: 'x' })).error.code, 'future');
  const pending = await h.ok('records/pending', { auth: teacherAuth });
  assert.deepEqual(pending.lessons.map(l => l.start), ['09:00'], '講師の記録待ちは自分の担当だけ');
  const r = (await h.ok('records/save', { auth: teacherAuth, lessonId: mine.id, comment: '記録', publish: true })).record;
  assert.equal((await h.call('records/void', { auth: teacherAuth, id: r.id, version: r.version, reason: 'x' })).error.code, 'forbidden');
  await h.ok('records/void', { auth, id: r.id, version: r.version, reason: '別の生徒の記録だった' });
  assert.equal((await h.call('records/save', { auth, lessonId: mine.id, version: r.version + 1, comment: 'x' })).error.code, 'void');
});

test('handover notes reach the next teacher, who can mark them read', async () => {
  const { h, auth, kid, teacherAuth, make } = await world();
  const l = await make('2026-10-09', '17:00');
  await h.ok('handover/add', { auth, studentId: kid.id, body: '分数の計算が苦手。前回は約分から確認した' });
  assert.equal((await h.ok('records/pending', { auth: teacherAuth })).unreadHandover, 1);
  h.clock = Date.parse('2026-10-09T18:30:00+09:00');
  const ctx = await h.ok('records/lesson', { auth: teacherAuth, lessonId: l.id });
  assert.deepEqual([ctx.handover.length, ctx.handover[0].read, ctx.handover[0].authorName], [1, false, '代表']);
  await h.ok('handover/read', { auth: teacherAuth, id: ctx.handover[0].id });
  assert.equal((await h.ok('records/lesson', { auth: teacherAuth, lessonId: l.id })).handover[0].read, true);
  assert.equal((await h.ok('records/pending', { auth: teacherAuth })).unreadHandover, 0);
});

test('the copy from the current ledger keeps records, the published version, private notes and homework states', async () => {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500)");
  q("insert into familyAccounts (id, label, status) values ('A', 'x', 'pending')"); q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1)");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('a', '2026-09-20', '17:00', 60, 'booked', 's1', 'true', '数学', 'in_person')");
  q("insert into lessonRecords (id, studentId, slotId, lessonDate, subject, content, progress, nextFocus, status, reportJson, revision) values ('r1', 's1', 'a', '2026-09-20', '数学', '直したコメント', '', '分数', 'active', ?, 2)", JSON.stringify({ actualUnit: '一次関数', understanding: '3', parentMessage: '連絡' }));
  q("insert into lessonPublicSnapshots (id, recordId, studentId, slotId, revision, content, reportJson, publishedAt) values ('r1:1', 'r1', 's1', 'a', 1, '公開したコメント', ?, '2026-09-20T10:00:00Z')", JSON.stringify({ actualUnit: '一次関数' }));
  q("insert into lessonPrivateNotes (recordId, teacherNote) values ('r1', '先生だけのメモ')");
  q("insert into tasks (id, studentId, type, title, due, sourceRecordId, dueMode, doneAt, reviewedAt) values ('t1', 's1', '宿題', 'ワーク', '', 'r1', 'nextLesson', '2026-09-22', '2026-09-23'), ('t2', 's1', '持ち物', '辞書', '2026-10-01', '', 'date', '', '')");
  q("insert into lessonPreparations (id, slotId, studentId, body, lessonDate, subject) values ('p1', 'a', 's1', '約分から確認する', '2026-09-20', '数学')");
  await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  assert.equal((await h.call('admin/migrate/records/apply', { auth, confirm: true })).error.code, 'noLessons');
  await h.ok('admin/migrate/schedule/apply', { auth, confirm: true });
  const pre = await h.ok('admin/migrate/records/preview', { auth });
  assert.deepEqual([pre.records.total, pre.records.published, pre.homework.total, pre.homework.confirmed, pre.handover], [1, 1, 2, 1, 1]);
  await h.ok('admin/migrate/records/apply', { auth, confirm: true });
  const r = h.rows('select * from lessonRecords')[0];
  assert.deepEqual([r.status, r.range, r.comment, JSON.parse(r.publishedJson).comment], ['published', '一次関数', '直したコメント', '公開したコメント']);
  assert.deepEqual(JSON.parse(r.staffNotes), { understanding: '3', nextFocus: '分数', memo: '先生だけのメモ' });
  assert.deepEqual(h.rows('select kind, status, dueMode, dueDate from homework order by id').map(x => [x.kind, x.status, x.dueMode, x.dueDate]), [['homework', 'confirmed', 'nextLesson', ''], ['item', 'open', 'date', '2026-10-01']]);
  await h.ok('admin/migrate/records/apply', { auth, confirm: true });
  assert.equal(h.rows('select count(*) n from homework')[0].n, 2, '写し直しても増えない');
});

test('teacher-only fields: understanding, pace and homework are chosen from fixed values; pace needs a planned unit; range parts suggest materials', async () => {
  const { h, teacherAuth, make } = await world();
  const l = await make('2026-10-02', '09:00');
  assert.equal((await h.call('records/save', { auth: teacherAuth, lessonId: l.id, comment: 'x', staffNotes: { understanding: 'よい' } })).error.code, 'badChoice', '理解度は5段階から選ぶ');
  const parts = [{ unit: '不定詞', material: 'Keywork', pages: '10-12' }, { unit: '', material: '', pages: '' }];
  const s = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, range: '不定詞 Keywork p.10〜12', rangeParts: parts, comment: 'x', staffNotes: { understanding: '4', pace: 'behind', homeworkReview: 'partial' } });
  assert.deepEqual(s.record.staffNotes, { understanding: '4', homeworkReview: 'partial' }, '予定単元がないときは進度を残さない');
  assert.deepEqual(s.record.rangeParts, [{ unit: '不定詞', material: 'Keywork', pages: '10-12' }], '空の行は捨てる');
  const s2 = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, version: s.record.version, range: 'x', rangeParts: parts, comment: 'x', staffNotes: { plannedUnit: '不定詞', pace: 'onTrack' } });
  assert.equal(s2.record.staffNotes.pace, 'onTrack');
  const next = await make('2026-10-02', '11:00');
  assert.deepEqual((await h.ok('records/lesson', { auth: teacherAuth, lessonId: next.id })).materials, ['Keywork'], 'この生徒で使った教材を候補に出す');
});

test('free text copied from the current ledger stays until it is changed', async () => {
  const { h, teacherAuth, make } = await world();
  const l = await make('2026-10-02', '09:00');
  const s = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, comment: 'x', staffNotes: { understanding: '4' } });
  h.db2._sqlite.prepare('update lessonRecords set staffNotes = ? where id = ?').run(JSON.stringify({ understanding: 'まあまあ' }), s.record.id);
  const kept = await h.ok('records/save', { auth: teacherAuth, lessonId: l.id, version: s.record.version, comment: 'y', staffNotes: { understanding: 'まあまあ' } });
  assert.equal(kept.record.staffNotes.understanding, 'まあまあ');
});

test('a record whose lesson is gone gets a done lesson; copying everything again keeps the order of the steps', async () => {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500)");
  q("insert into familyAccounts (id, label, status) values ('A', 'x', 'pending')"); q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1)");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('a', '2026-09-20', '17:00', 60, 'booked', 's1', 'true', '数学', 'in_person')");
  q("insert into lessonRecords (id, studentId, slotId, lessonDate, lessonStart, lessonMin, subject, content, status, reportJson, revision) values ('r1', 's1', 'a', '2026-09-20', '17:00', 60, '数学', 'ある', 'active', '{}', 1), ('r2', 's1', 'gone', '2026-08-29', '18:00', 90, '', '消えた枠', 'active', '{}', 1)");
  q("insert into events (id, studentId, date, kind, title) values ('e1', 's1', '2026-10-20', 'test', '中間テスト')");
  await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  await h.ok('admin/migrate/schedule/apply', { auth, confirm: true });
  const r = await h.ok('admin/migrate/records/apply', { auth, confirm: true });
  assert.equal(r.records, 2);
  assert.match(r.problems.join(), /実施済みの授業を作って写します/);
  assert.deepEqual({ ...h.rows("select date, start, minutes, subject, status from lessons where legacyId = 'orphan:r2'")[0] }, { date: '2026-08-29', start: '18:00', minutes: 90, subject: '授業', status: 'done' });
  assert.equal((await h.call('admin/migrate/schedule/apply', { auth, confirm: true })).error.code, 'useAll', '記録のあとで予定だけを写し直さない');
  assert.equal((await h.call('admin/migrate/identity/apply', { auth, confirm: true })).error.code, 'useAll');
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('b', '2026-10-05', '17:00', 60, 'booked', 's1', '', '英語', 'in_person')");
  const all = await h.ok('admin/migrate/all/apply', { auth, confirm: true });
  assert.deepEqual([all.identity.students, all.schedule.lessons, all.records.records], [1, 2, 2]);
  assert.deepEqual(h.rows('select count(*) n from lessons')[0].n, 3, '写し直しても増えない（予定2件と、消えた枠の1件）');
  assert.equal(h.rows('select count(*) n from sharedEvents')[0].n, 1);
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', '')").run();
  assert.equal((await h.call('admin/migrate/all/apply', { auth, confirm: true })).error.code, 'live', '切り替えたあとは使えない');
});
