'use strict';
// 講師アカウントの画面: 講師のナビ・担当の授業・招待リンクからの設定・先生の講師管理。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, flush } = require('./helpers/operations-ui-harness.cjs');

const lesson = (o = {}) => ({ id: 'slot-a', date: '2026-10-01', start: '17:00', min: 60, subject: '英語', kind: '', deliveryMode: 'online', meetUrl: 'https://example.invalid/meet', studentId: 'test-a', studentName: '【テスト】A', done: false, lessonRecordStatus: 'none', ...o });
const home = (lessons = [lesson(), lesson({ id: 'slot-b', date: '2026-10-08' }), lesson({ id: 'slot-c', date: '2026-09-24', lessonRecordStatus: 'active', done: true })]) =>
  ({ role: 'instructor', me: { id: 'i1', name: '【テスト】講師' }, today: '2026-10-01', lessons, students: [{ id: 'test-a', name: '【テスト】A', grade: '中2', school: '' }] });
function instructorUI(hash = '#home') {
  return createUI('admin', { hash, now: '2026-10-01T12:00:00+09:00', local: new Map([['sw_admt', 'in1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64)], ['sw_role', 'instructor']]) });
}

test('an instructor sees only their lessons and students, with navigation limited to that page', async () => {
  const ui = instructorUI();
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].body.op, 'instructorHome');
  ui.requests[0].reply({ ok: true, data: home() }); await flush();
  const nav = ui.el('nav').innerHTML, html = ui.html();
  assert.match(nav, /担当の授業/); assert.doesNotMatch(nav, /請求|計画|生徒<|設定/);
  assert.match(html, /取消・日程の変更の連絡を受けたら、先生に伝えてください/);
  assert.match(html, /記録が必要な授業 <span class="cnt">1件<\/span>/);
  assert.match(html, /href="#lesson\?student=test-a&amp;slot=slot-a">記録する<\/a>|href="#lesson\?student=test-a&slot=slot-a">記録する<\/a>/);
  assert.match(html, /これからの授業 <span class="cnt">1件<\/span>/);
  assert.match(html, /href="https:\/\/example.invalid\/meet" target="_blank" rel="noopener">Meet<\/a>/, 'future online lessons offer the Meet link');
  assert.match(html, /記録済みの授業（直近60日）/); assert.match(html, />記録を見る<\/a>/);
  assert.match(html, /<a class="sl-row" href="#s=test-a"><span class="nm">【テスト】A<\/span>/);
  assert.doesNotMatch(html, /円|請求|保護者/);

  ui.navigate('#billing');
  assert.equal(ui.requests.at(-1).body.op, 'instructorHome', 'teacher pages fall back to the instructor home');
  ui.navigate('#s=test-a');
  const r = ui.requests.at(-1); assert.equal(r.body.op, 'instructorStudent'); assert.equal(r.body.studentId, 'test-a');
  r.reply({ ok: true, data: { id: 'test-a', name: '【テスト】A', grade: '中2', school: '', tasks: [{ id: 't1', title: 'p.12', material: 'ワーク', dueMode: 'none' }], grades: [{ date: '2026-09-01', test: '定期テスト', subject: '英語', score: 80, max: 100, dev: null, rank: '' }], exams: [] } }); await flush();
  assert.match(ui.html(), /未完了の宿題 <span class="cnt">1件<\/span>/); assert.match(ui.html(), /ワーク：p\.12/); assert.match(ui.html(), /定期テスト/);
  assert.doesNotMatch(ui.html(), /data-action="delrow"/, 'grades are read-only for instructors');
});

test('logging in with an instructor account switches the admin screen into the instructor view', async () => {
  const ui = createUI('admin', { hash: '#home', local: new Map() });
  ui.input('a-email', 'instructor@example.invalid'); ui.input('a-pass', 'synthetic-pass-123');
  const loginTags = ui.html().includes('data-action="login"'); assert.ok(loginTags);
  ui.click('login');
  const login = ui.requests.find(r => r.body.op === 'login');
  login.reply({ ok: true, role: 'instructor', token: 'in1.' + 'c'.repeat(32) + '.' + 'd'.repeat(64), instructor: { id: 'i1', name: '【テスト】講師' } }); await flush();
  assert.equal(ui.local.get('sw_role'), 'instructor');
  assert.equal(ui.requests.at(-1).body.op, 'instructorHome');
  ui.requests.at(-1).reply({ ok: true, data: home([]) }); await flush();
  assert.match(ui.html(), /担当の授業はまだありません/);
  ui.click('logout');
  assert.equal(ui.local.has('sw_role'), false); assert.equal(ui.local.has('sw_admt'), false);
});

test('an invite link lets the instructor set a password and start without the teacher login', async () => {
  const code = 'ii1.' + 'e'.repeat(32) + '.' + 'f'.repeat(64);
  const ui = createUI('admin', { hash: '#instructor-invite=' + code, local: new Map() });
  const info = ui.requests[0]; assert.equal(info.body.op, 'instructorInviteInfo'); assert.equal(info.body.invite, code);
  info.reply({ ok: true, name: '【テスト】講師', email: 'instructor@example.invalid', configured: false }); await flush();
  assert.match(ui.html(), /【テスト】講師さん（instructor@example.invalid）のパスワードを決めます/);
  ui.input('inv-pass', 'short'); ui.input('inv-pass2', 'short'); ui.click('inv-setup');
  assert.equal(ui.requests.length, 1, 'a short password is not sent');
  ui.input('inv-pass', 'synthetic-pass-123'); ui.input('inv-pass2', 'synthetic-pass-123'); ui.click('inv-setup');
  const setup = ui.requests.at(-1); assert.equal(setup.body.op, 'instructorSetup'); assert.equal(setup.body.password, 'synthetic-pass-123');
  setup.reply({ ok: true, role: 'instructor', token: 'in1.' + 'e'.repeat(32) + '.' + '1'.repeat(64), instructor: { id: 'i1', name: '【テスト】講師' } }); await flush();
  assert.equal(ui.local.get('sw_role'), 'instructor'); assert.match(ui.replaced.at(-1), /#home$/, 'the invite code leaves the address bar');
  assert.equal(ui.requests.at(-1).body.op, 'instructorHome');
});

test('the teacher adds an instructor in settings, gets a one-time link, and sees the monthly work summary', async () => {
  const ui = createUI('admin', { hash: '#settings', now: '2026-10-01T12:00:00+09:00' });
  const state = ui.requests.find(r => r.body.op === 'state'), list = ui.requests.find(r => r.body.op === 'instructorList');
  assert.ok(state && list); assert.equal(list.body.ym, '2026-10');
  state.reply({ ok: true, admin: { account: 'teacher@example.invalid', slots: [], students: [], lessonKinds: [], log: [], today: '2026-10-01', instructors: [] } });
  list.reply({ ok: true, instructors: [{ id: 'i1', name: '【テスト】講師', email: 'instructor@example.invalid', status: 'active', configured: true, inviteExpiresAt: 0, lastLogin: '', createdAt: '' }], work: { ym: '2026-10', rows: [{ instructorId: 'i1', name: '【テスト】講師', count: 2, minutes: 150, lessons: [{ date: '2026-10-01', start: '17:00', min: 90, subject: '英語', studentName: '【テスト】A' }, { date: '2026-10-02', start: '17:00', min: 60, subject: '英語', studentName: '【テスト】A' }] }] } });
  await flush();
  const html = ui.html();
  assert.match(html, /<h2>講師<\/h2>/); assert.match(html, /料金・保護者の連絡先・ほかの生徒は見られません/);
  assert.match(html, /<span class="tag green">利用中<\/span>/); assert.match(html, /パスワード再設定のリンク/);
  assert.match(html, /<h2>勤務実績<\/h2>/); assert.match(html, /2回<\/span><span class="small num">2時間30分<\/span>/);
  ui.input('in-name', '【テスト】新しい講師'); ui.input('in-email', 'new@example.invalid'); ui.click('in-add');
  const add = ui.requests.at(-1); assert.equal(add.body.op, 'instructorAdd'); assert.deepEqual([add.body.name, add.body.email], ['【テスト】新しい講師', 'new@example.invalid']);
  add.reply({ ok: true, instructor: { id: 'i2', name: '【テスト】新しい講師' }, inviteUrl: 'https://www.stepwise-education.jp/kanri/#instructor-invite=ii1.x.y' }); await flush();
  assert.match(ui.html(), /【テスト】新しい講師さんへの招待リンク/); assert.match(ui.html(), /value="https:\/\/www.stepwise-education.jp\/kanri\/#instructor-invite=ii1.x.y"/);
  ui.click('in-copy'); assert.equal(ui.clipboard, 'https://www.stepwise-education.jp/kanri/#instructor-invite=ii1.x.y');
});

test('settings lists failed mail and calendar work; each item is retried or dismissed one at a time after confirmation', async () => {
  const ui = createUI('admin', { hash: '#settings', now: '2026-10-01T12:00:00+09:00' });
  const state = ui.requests.find(r => r.body.op === 'state'), list = ui.requests.find(r => r.body.op === 'instructorList'), effects = ui.requests.find(r => r.body.op === 'effectsList');
  assert.ok(effects, 'the failed work list is loaded with settings');
  state.reply({ ok: true, admin: { account: 'teacher@example.invalid', slots: [], students: [], lessonKinds: [], log: [], today: '2026-10-01', instructors: [] } });
  list.reply({ ok: true, instructors: [], work: { ym: '2026-10', rows: [] } });
  effects.reply({ ok: true, count: 2, items: [
    { id: 109, at: '9/29 11:41', kind: 'calendarCreate', status: 'failed', label: 'カレンダーに予定を作る', title: '【授業】テストさん 化学 (オンライン)', when: '10/3 08:00', meet: true, error: 'Error: 授業記録のシート構成が一致しません' },
    { id: 112, at: '9/29 12:00', kind: 'mail', status: 'failed', label: 'メール', title: '授業のご案内 <b>', to: 'student@example.invalid', preview: '本文', error: '' } ] });
  await flush();
  const html = ui.html();
  assert.match(html, /<h2 id="failed-effects">送れなかった処理 <span class="cnt">2件<\/span><\/h2>/);
  assert.match(html, /10\/3 08:00 ・ Meet あり/); assert.match(html, /授業のご案内 &lt;b&gt;/); assert.match(html, /宛先 student@example.invalid/);
  const before = ui.confirms();
  ui.click('ef-retry', { 'data-id': '109' });
  assert.equal(ui.confirms(), before + 1, 'a retry is confirmed first');
  const retry = ui.requests.at(-1); assert.equal(retry.body.op, 'effectRetry'); assert.equal(retry.body.id, 109);
  assert.match(ui.html(), /送信中…/);
  ui.click('ef-dismiss', { 'data-id': '112' });
  assert.equal(ui.requests.at(-1), retry, 'nothing else is sent while one item is in flight');
  retry.reply({ ok: true, id: 109, status: 'sent' }); await flush();
  assert.equal(ui.requests.at(-1).body.op, 'effectsList', 'the list is read again after each action');
});
