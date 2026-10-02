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

test('a record whose lesson is gone is not copied; copying everything again keeps the order of the steps', async () => {
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
  assert.equal(r.records, 1);
  assert.match(r.problems.join(), /授業の枠が消えているため写しません/);
  assert.equal(h.rows("select count(*) n from lessons where legacyId like 'orphan:%'")[0].n, 0);
  assert.equal((await h.call('admin/migrate/schedule/apply', { auth, confirm: true })).error.code, 'useAll', '記録のあとで予定だけを写し直さない');
  assert.equal((await h.call('admin/migrate/identity/apply', { auth, confirm: true })).error.code, 'useAll');
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('b', '2026-10-05', '17:00', 60, 'booked', 's1', '', '英語', 'in_person')");
  const all = await h.ok('admin/migrate/all/apply', { auth, confirm: true });
  assert.deepEqual([all.identity.students, all.schedule.lessons, all.records.records], [1, 2, 1]);
  assert.equal(h.rows('select count(*) n from lessons')[0].n, 2, '写し直しても増えない');
  assert.equal(h.rows('select count(*) n from sharedEvents')[0].n, 1);
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', '')").run();
  assert.equal((await h.call('admin/migrate/all/apply', { auth, confirm: true })).error.code, 'live', '切り替えたあとは使えない');
});

test('homework is checked one by one in the next lesson record: done is confirmed, partial and not done carry over, families see the result', async () => {
  const { h, parent, teacherAuth, make, k } = await world();
  const a = await make('2026-10-02', '09:00'), b = await make('2026-10-09', '17:00'), c3 = await make('2026-10-16', '17:00');
  await h.ok('records/save', { auth: teacherAuth, lessonId: a.id, comment: '一回目', homework: [{ title: 'ワーク p.10', dueMode: 'nextLesson', dueSubject: '数学' }, { title: 'プリント', dueMode: 'nextLesson', dueSubject: '数学' }], publish: true });
  const [w1, w2] = h.rows("select * from homework order by sortOrder, createdAt");
  await h.ok('student/homework/report', { k, id: w1.id });
  h.clock = Date.parse('2026-10-09T09:00:00Z');
  const ctxB = await h.ok('records/lesson', { auth: teacherAuth, lessonId: b.id });
  assert.deepEqual(ctxB.checks.map(x => [x.title, x.status, x.assignedOn]), [['ワーク p.10', 'reported', '2026-10-02'], ['プリント', 'open', '2026-10-02']], '前回までの宿題');
  assert.equal((await h.call('records/save', { auth: teacherAuth, lessonId: b.id, comment: 'x', homeworkChecks: [{ id: w1.id, result: 'maybe' }] })).error.code, 'badChecks');
  const draft = await h.ok('records/save', { auth: teacherAuth, lessonId: b.id, comment: '二回目', staffNotes: { homeworkReview: 'done' }, homework: [{ title: '新しい宿題', dueMode: 'nextLesson', dueSubject: '数学' }], homeworkChecks: [{ id: w1.id, result: 'done' }, { id: w2.id, result: 'notDone' }] });
  assert.equal(draft.record.staffNotes.homeworkReview, 'partial', '「やってきたか」はチェックから決まる');
  const row = id => ({ ...h.rows('select status, checkResult, checkedRecordId from homework where id = ?', id)[0] });
  assert.deepEqual(row(w1.id), { status: 'confirmed', checkResult: 'done', checkedRecordId: draft.record.id });
  assert.deepEqual(row(w2.id), { status: 'open', checkResult: 'notDone', checkedRecordId: draft.record.id }, 'やってこなかったは未完了のまま');
  await h.ok('records/save', { auth: teacherAuth, lessonId: b.id, version: draft.record.version, comment: '二回目', homework: (await h.ok('records/lesson', { auth: teacherAuth, lessonId: b.id })).homework.map(x => ({ id: x.id, title: x.title, dueMode: 'nextLesson', dueSubject: '数学' })), homeworkChecks: [{ id: w1.id, result: 'done' }, { id: w2.id, result: 'notDone' }], publish: true });
  const fam = await h.ok('family/learning', { auth: parent });
  assert.equal(fam.homework.find(x => x.id === w2.id).checkResult, 'notDone', '保護者にも見える');
  assert.equal(fam.homework.find(x => x.id === w1.id).checkedRecordId, fam.records[0].id, 'どの授業でチェックしたか');
  // 同じ記録を開き直すと、チェックしたものも出て付け直せる。外すと確認済みが戻る
  const again = await h.ok('records/lesson', { auth: teacherAuth, lessonId: b.id });
  assert.deepEqual(again.checks.map(x => [x.title, x.checkedHere, x.checkResult]), [['ワーク p.10', true, 'done'], ['プリント', true, 'notDone']]);
  const recB = again.record;
  await h.ok('records/save', { auth: teacherAuth, lessonId: b.id, version: recB.version, comment: '二回目', homework: again.homework.map(x => ({ id: x.id, title: x.title, dueMode: 'nextLesson', dueSubject: '数学' })), homeworkChecks: [{ id: w1.id, result: '' }, { id: w2.id, result: 'notDone' }], publish: true });
  assert.deepEqual(row(w1.id), { status: 'open', checkResult: '', checkedRecordId: '' });
  // 次の授業: 持ち越した宿題と、二回目に出した宿題が出る。前の授業より前の記録には、あとで出した宿題は出ない
  h.clock = Date.parse('2026-10-16T09:00:00Z');
  const ctxC = await h.ok('records/lesson', { auth: teacherAuth, lessonId: c3.id });
  assert.deepEqual(ctxC.checks.map(x => [x.title, x.checkResult, x.checkedHere]), [['ワーク p.10', '', false], ['プリント', 'notDone', false], ['新しい宿題', '', false]]);
  assert.deepEqual((await h.ok('records/lesson', { auth: teacherAuth, lessonId: a.id })).checks, [], '一回目の記録には、その授業で出した宿題もあとの宿題も出ない');
});

test('lessons the same teacher gives at the same time are listed together so the record page can switch between them', async () => {
  const { h, auth, kid, teacherAuth, teacher, make } = await world();
  const fam2 = (await h.ok('admin/families/create', { auth, name: '架空二家', email: 'p2@example.invalid' })).family;
  const kid2 = (await h.ok('admin/students/create', { auth, familyId: fam2.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  const a = await make('2026-10-02', '09:00');
  // 予定の画面では同じ講師の重なりは作れないので、別の時間で作ってから時刻だけ動かす（移行で写した2人同時の授業と同じ形）
  await h.ok('schedule/lessons/create', { auth, studentId: kid2.id, date: '2026-10-02', start: '15:00', minutes: 60, subject: '英語', deliveryMode: 'in_person', staffId: teacher.id, force: true });
  let b = h.rows("select * from lessons where studentId = ? and date = '2026-10-02'", kid2.id)[0];
  await h.ok('schedule/lessons/decide', { auth, id: b.id, version: b.version });
  h.db2._sqlite.prepare("update lessons set start = '09:30' where id = ?").run(b.id); b = h.rows('select * from lessons where id = ?', b.id)[0];
  await make('2026-10-02', '11:00'); // 9:00〜10:30 とは重ならない
  const ctxA = await h.ok('records/lesson', { auth: teacherAuth, lessonId: a.id });
  assert.deepEqual(ctxA.together.map(x => [x.name, x.start]), [['架空 一郎', '09:00'], ['架空 花子', '09:30']]);
  await h.ok('records/save', { auth: teacherAuth, lessonId: b.id, comment: '下書き' });
  assert.equal((await h.ok('records/lesson', { auth: teacherAuth, lessonId: a.id })).together[1].recordStatus, 'draft', '相手の記録の状態も出る');
  const c = await make('2026-10-02', '13:00');
  assert.deepEqual((await h.ok('records/lesson', { auth: teacherAuth, lessonId: c.id })).together, [], '1人だけのときは出さない');
  assert.ok(kid);
});
