'use strict';
// 作り直し（v2）: スタッフの「今日」（対応すること・今日と明日の授業）。cf/v2/home.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test('today shows what needs doing and today\'s and tomorrow\'s lessons; teachers see only their own', async () => {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const tAuth = await h.staffWith(auth, ['teacher'], 't@example.invalid'), t = (await h.ok('staff/me', { auth: tAuth })).me;
  // 今日（10/2）の授業2つ（1つは講師の担当）と明日の仮予定
  for (const [date, start, staffId] of [['2026-10-02', '09:00', t.id], ['2026-10-02', '10:30', ''], ['2026-10-03', '17:00', '']]) await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date, start, minutes: 60, subject: '数学', deliveryMode: 'in_person', staffId, force: true });
  for (const l of h.rows("select * from lessons where date = '2026-10-02'")) await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
  const tomorrow = h.rows("select * from lessons where date = '2026-10-03'")[0];
  await h.ok('schedule/lessons/decide', { auth, id: tomorrow.id, version: tomorrow.version });
  h.clock = Date.parse('2026-10-02T21:00:00+09:00');
  await h.ok('family/lessons/request', { auth: parent, lessonId: tomorrow.id, kind: 'move', note: '日曜にできますか' });
  const m = await h.ok('home/today', { auth });
  assert.deepEqual(m.lessons.map(l => [l.date, l.start, l.needsRecord]), [['2026-10-02', '09:00', true], ['2026-10-02', '10:30', true], ['2026-10-03', '17:00', false]]);
  const todo = Object.fromEntries(m.todo.map(x => [x.key, x.count]));
  assert.deepEqual([todo.requests, todo.records], [1, 2]);
  const tt = await h.ok('home/today', { auth: tAuth });
  assert.deepEqual(tt.lessons.map(l => l.start), ['09:00'], '講師は担当の授業だけ');
  assert.equal(tt.todo.find(x => x.key === 'requests'), undefined, '連絡は教室管理者だけ');
  assert.equal(tt.todo.find(x => x.key === 'records').count, 1);
});
