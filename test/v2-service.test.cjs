'use strict';
// 作り直し（v2）: 外のサービス（MCP）の読み取りの鍵（cf/v2/service.mjs）。読むだけ通し、書き込みは断る。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

test('the service key reads as the owner, refuses writes, and needs the exact key', async () => {
  const h = await createV2(); const auth = await h.owner();
  const KEY = 'k'.repeat(40); h.env.V2_SERVICE_KEY = KEY;
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const list = await h.ok('students/list', { serviceKey: KEY });
  assert.deepEqual(list.families.flatMap(f => f.students.map(s => s.name)), ['架空 一郎']);
  assert.equal(list.manager, true, '代表として読む');
  const hub = await h.ok('students/hub', { serviceKey: KEY, studentId: kid.id });
  assert.equal(hub.basic.familyName, '架空家');
  assert.equal((await h.call('students/list', { serviceKey: 'wrong' })).error.code, 'badKey');
  assert.equal((await h.call('students/list', { serviceKey: KEY + 'x' })).error.code, 'badKey');
  assert.equal((await h.call('schedule/lessons/create', { serviceKey: KEY, studentId: kid.id, date: '2026-10-20', start: '17:00', minutes: 60, subject: '数学' })).error.code, 'service', '書き込みは断る');
  assert.equal(h.rows('select count(*) n from lessons')[0].n, 0);
  delete h.env.V2_SERVICE_KEY;
  assert.equal((await h.call('students/list', { serviceKey: KEY })).error.code, 'badKey', '鍵が設定されていなければ通さない');
});
