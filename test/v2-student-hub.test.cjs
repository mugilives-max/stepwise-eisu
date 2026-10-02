'use strict';
// 作り直し（v2）: スタッフの「生徒」（一覧と、1人の生徒の画面）。cf/v2/student-hub.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test('the student screen gathers lessons, records, homework, grades, plans and basics; teachers see only their students without money or contacts', async () => {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid', phone: '090-0000-0000' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', grade: '中2', baseRate30: 1500 })).student;
  const other = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  const tAuth = await h.staffWith(auth, ['teacher'], 't@example.invalid'), t = (await h.ok('staff/me', { auth: tAuth })).me;
  await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date: '2026-10-02', start: '09:00', minutes: 60, subject: '数学', deliveryMode: 'in_person', staffId: t.id, force: true });
  await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date: '2026-10-09', start: '17:00', minutes: 60, subject: '数学', deliveryMode: 'in_person', staffId: t.id, force: true });
  const l = h.rows("select * from lessons where date = '2026-10-02'")[0];
  await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  await h.ok('records/save', { auth: tAuth, lessonId: l.id, range: '一次関数', comment: 'よくできた', staffNotes: { nextFocus: '傾き' }, homework: [{ title: 'ワーク p.10', dueMode: 'nextLesson', dueSubject: '数学' }], publish: true });
  await h.ok('billing/plans/save', { auth, studentId: kid.id, subject: '数学', kind: '通常', startDate: '2026-10-01', endDate: '2026-10-31', count: 4, minutes: 60, fee: 3000 });
  const list = await h.ok('students/list', { auth });
  assert.deepEqual(list.families[0].students.map(s => [s.name, s.next.slice(0, 10)]), [['架空 一郎', '2026-10-09'], ['架空 花子', '']]);
  const hub = await h.ok('students/hub', { auth, studentId: kid.id });
  assert.deepEqual([hub.upcoming.length, hub.records[0].range, hub.homework[0].title, hub.plans[0].count, hub.basic.phone], [1, '一次関数', 'ワーク p.10', 4, '090-0000-0000']);
  const th = await h.ok('students/hub', { auth: tAuth, studentId: kid.id });
  assert.equal(th.records[0].staffNotes.nextFocus, '傾き', '講師用のメモは講師に見せる');
  assert.deepEqual([th.plans, th.basic, th.invoices], [undefined, undefined, undefined], '講師には計画・請求・連絡先を出さない');
  assert.equal((await h.call('students/hub', { auth: tAuth, studentId: other.id })).error.code, 'forbidden');
  const tl = await h.ok('students/list', { auth: tAuth });
  assert.deepEqual([tl.families.length, tl.families[0].name, tl.families[0].students.map(s => s.name)], [1, '', ['架空 一郎']], '講師には担当の生徒だけ、家族は出さない');
});
