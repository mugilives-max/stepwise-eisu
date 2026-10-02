'use strict';
// 作り直し（v2）: 保護者ページ・生徒ページのプレビュー（表示だけ。書き込みはすべて断る）。cf/v2/preview.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  await h.ok('schedule/lessons/create', { auth, studentId: kid.id, date: '2026-10-09', start: '17:00', minutes: 60, subject: '数学', deliveryMode: 'in_person', force: true });
  const tokenOf = url => decodeURIComponent(url.split(/#preview=|\?k=/)[1]);
  return { h, auth, fam, kid, tokenOf };
}

test('a manager previews the family page: every read works, every write is refused', async () => {
  const { h, auth, fam, tokenOf } = await world();
  const start = await h.ok('admin/preview/start', { auth, kind: 'family', id: fam.id });
  assert.match(start.url, /^\/family\/#preview=pv2\./);
  const pv = tokenOf(start.url);
  assert.equal((await h.ok('family/me', { auth: pv })).me.name, '架空家');
  for (const r of ['family/schedule', 'family/learning', 'family/money', 'family/grades', 'family/students']) await h.ok(r, { auth: pv });
  const lesson = (await h.ok('family/schedule', { auth: pv })).lessons[0];
  const before = h.rows('select count(*) n from lessonRequests')[0].n;
  for (const [r, body] of [['family/lessons/request', { lessonId: lesson.id, kind: 'rest' }], ['family/events/add', { studentId: lesson.studentId, kind: 'test', date: '2026-10-20', title: 'x' }],
    ['family/password', { current: 'a', next: 'b' }], ['family/logout', {}], ['family/grades/upload', { studentId: lesson.studentId, name: 'a.pdf', mime: 'application/pdf', size: 10 }]]) {
    const res = await h.call(r, { auth: pv, ...body });
    assert.deepEqual([res.status, res.error.code], [403, 'preview'], r + ' はプレビューでは断る');
  }
  assert.equal(h.rows('select count(*) n from lessonRequests')[0].n, before, '何も書かれていない');
  assert.ok(h.rows("select action from auditLog where action = 'previewStart'").length, 'プレビューを始めたことは残す');
  h.clock += 61 * 60e3;
  assert.equal((await h.call('family/me', { auth: pv })).error.code, 'needLogin', '1時間で切れる');
});

test('a manager previews the student page the same way; teachers and families cannot start a preview', async () => {
  const { h, auth, fam, kid, tokenOf } = await world();
  const pv = tokenOf((await h.ok('admin/preview/start', { auth, kind: 'student', id: kid.id })).url);
  const st = await h.ok('student/schedule', { k: pv });
  assert.equal(st.me.name, '架空 一郎');
  await h.ok('student/learning', { k: pv }); await h.ok('student/grades', { k: pv });
  assert.equal((await h.call('student/lessons/request', { k: pv, lessonId: st.lessons[0].id, kind: 'rest' })).error.code, 'preview');
  assert.equal((await h.call('student/homework/report', { k: pv, id: 'x' })).error.code, 'preview');
  assert.equal((await h.call('family/me', { auth: pv })).error.code, 'needLogin', '生徒のプレビューの鍵で保護者ページは見られない');
  const teacherAuth = await h.staffWith(auth, ['teacher'], 't@example.invalid');
  assert.equal((await h.call('admin/preview/start', { auth: teacherAuth, kind: 'family', id: fam.id })).error.code, 'forbidden');
  assert.equal((await h.call('admin/preview/start', { auth, kind: 'family', id: 'nobody' })).error.code, 'notFound');
});
