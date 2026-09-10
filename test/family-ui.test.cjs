'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = fs.readFileSync(path.join(__dirname, 'operations-ui.test.cjs'), 'utf8').split('\ntest(')[0];
const { createUI, flush, state } = new Function('require', '__dirname', harness + '\nreturn {createUI, flush, state};')(require, __dirname);
const home = children => ({ ok: true, family: { id: 'family-a', label: '【テスト】家族', email: 'parent@example.invalid' }, children: children || [{ studentId: 'child-a', name: '【テスト】子A' }, { studentId: 'child-b', name: '【テスト】子B' }] });
const data = name => ({ name, month: '2026-09', thisMonth: {}, payments: [], upcoming: [{ id: 'slot-a', date: '2026-09-10', start: '17:00', min: 30, status: 'booked', subject: '英語', deliveryMode: 'online' }], planMonths: [{ ym: '2026-09', status: 'proposed', revision: 7, termsKnown: true, rate30: 1000, monthly: 0, rows: [{ subject: '英語', count: 4 }], total: 4 }] });
function loggedUI() { return createUI('student', { hash: '#family/billing', session: new Map([['sw_ft_v1', 'test-family-token']]) }); }
async function readyFamily() { const ui = loggedUI(); ui.requests[0].reply(home()); await flush(); ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子A') }); await flush(); return ui; }

test('parent sections separate billing, reports and account settings without reloading the child',async()=>{
  const ui=await readyFamily(),count=ui.requests.length;
  assert.match(ui.html(),/この回数と料金を承認する/);assert.ok(!ui.html().includes('先生からの授業記録'));
  ui.navigate('#family/records');assert.match(ui.html(),/先生からの授業記録/);assert.ok(!ui.html().includes('この回数と料金を承認する'));assert.ok(!ui.html().includes('メールアドレスを変更'));
  ui.navigate('#family/settings');assert.match(ui.html(),/メールアドレスを変更/);assert.equal(ui.requests.length,count);assert.equal(ui.el('fa-child').value,'child-a');
});
function familyList(extra = {}) { return { ok: true, families: [], students: [{ id: 'child-a', name: '【テスト】子A', active: true }, { id: 'child-b', name: '【テスト】子B', active: true }], notifications: [], ...extra }; }
async function teacherReady(list = familyList()) { const ui = createUI('admin', { hash: '#families' }); assert.equal(ui.requests[0].body.op, 'familyList'); ui.requests[0].reply(list); await flush(); return ui; }

test('registration collects only email and keeps a correction route while waiting', async () => {
  const ui=createUI('student',{hash:'#family?invite=fi1.synthetic.invite-secret'});
  assert.ok(!ui.html().includes('id="fa-pass"'));
  ui.input('fa-email',' Parent@Example.Invalid ');ui.submit('family-auth-form');
  assert.equal(ui.requests[0].body.pass,undefined);assert.equal(ui.requests[0].body.email,'parent@example.invalid');
  ui.requests[0].reply({ok:true,verificationRequired:true,mailStatus:'sent'});await flush();
  assert.match(ui.html(),/メール確認待ち/);assert.match(ui.html(),/parent@example.invalid/);assert.match(ui.html(),/メールアドレスを修正/);
  assert.equal(ui.session.has('sw_ft_v1'),false);assert.equal(JSON.stringify(ui.writes).includes('invite-secret'),false);
});

test('verification and reset challenges are stripped from the URL and never copied to DOM logs or storage', async () => {
  const secret = 'challenge-test-secret';
  const ui = createUI('student', { hash: '#family?verify=' + secret, local: new Map() });
  assert.equal(ui.location.hash, '#family'); assert.equal(ui.requests.length, 0); assert.equal(ui.html().includes(secret), false);
  ui.click('fa-verify'); assert.equal(ui.requests[0].body.challenge, secret);
  ui.requests[0].reply({ ok: true, verified: true }); await flush(); assert.match(ui.html(), /メールアドレスを確認しました/);
  assert.equal(JSON.stringify([...ui.writes, ...ui.logs]).includes(secret), false);
  const reset = createUI('student', { hash: '#family?reset=' + secret, local: new Map() });
  assert.equal(reset.location.hash, '#family'); reset.input('fa-pass', ' replacement pass '); reset.input('fa-pass2', ' replacement pass '); reset.submit('family-auth-form');
  assert.equal(reset.requests[0].body.action, 'familyResetConfirm'); assert.equal(reset.requests[0].body.challenge, secret); assert.equal(reset.requests[0].body.pass, ' replacement pass ');
});

test('login uses a separate session token and clears each child before loading the next', async () => {
  const ui = createUI('student', { hash: '#family', session: new Map([['sw_pt_v2:test-link-a', 'legacy-parent-token']]) });
  ui.input('fa-email', 'parent@example.invalid'); ui.input('fa-pass', 'test-family-password'); ui.submit('family-auth-form');
  ui.requests[0].reply({ ...home(), ftoken: 'test-family-token' }); await flush();
  assert.equal(ui.session.get('sw_ft_v1'), 'test-family-token'); assert.equal(ui.session.get('sw_pt_v2:test-link-a'), 'legacy-parent-token'); assert.equal(ui.requests.at(-1).body.studentId, 'child-a');
  ui.requests.at(-1).reply({ ok: true, data: data('Aだけの表示') }); await flush(); assert.match(ui.html(), /Aだけの表示/); assert.match(ui.html(), /今後の授業/); assert.match(ui.html(), /オンライン/);
  ui.change('fa-child', 'child-b'); assert.equal(ui.html().includes('Aだけの表示'), false); assert.equal(ui.requests.at(-1).body.studentId, 'child-b');
  ui.requests.at(-1).reply({ ok: true, data: data('Bだけの表示') }); await flush(); assert.match(ui.html(), /Bだけの表示/);
  assert.equal(JSON.stringify(ui.writes).includes('parent@example.invalid'), false);
});

test('family approval requires a DOM confirmation and sends that child and proposal revision', async () => {
  const ui = await readyFamily(); const before = ui.requests.length;
  ui.input('pl-memo-2026-09', '相談内容'); ui.click('fa-planok', { 'data-ym': '2026-09' });
  assert.equal(ui.requests.length, before); assert.equal(ui.confirms(), 0); assert.match(ui.html(), /月間計画の回答確認/);
  ui.click('fa-decide'); const b = ui.requests.at(-1).body;
  assert.equal(b.action, 'familyPlanDecide'); assert.equal(b.studentId, 'child-a'); assert.equal(b.expectedRevision, 7); assert.equal(b.ftoken, 'test-family-token');
  ui.requests.at(-1).reply({ ok: true, data: data('承認後の子A'), notificationWarning: '保存済みですが通知を確認してください' }); await flush();
  assert.match(ui.html(), /通知を確認/);
});

test('child switch discards the previous approval confirmation and membership refresh removes old private data', async () => {
  const ui = await readyFamily(); ui.click('fa-planok', { 'data-ym': '2026-09' }); ui.change('fa-child', 'child-b');
  assert.equal(ui.html().includes('data-action="fa-decide"'), false);
  ui.requests.at(-1).reply({ ok: true, data: data('Bだけの表示') }); await flush();
  ui.navigate('#family/settings'); ui.click('fa-home'); assert.equal(ui.html().includes('Bだけの表示'), false);
  ui.requests.at(-1).reply(home([])); await flush(); assert.match(ui.html(), /子どもの紐付けを先生/); assert.equal(ui.html().includes('今後の授業'), false);
});

test('family auth expiry removes protected data without clearing the legacy parent token', async () => {
  const ui = await readyFamily(); ui.session.set('sw_pt_v2:test-link-a', 'legacy-parent-token'); ui.click('fa-refresh');
  ui.requests.at(-1).reply({ error: 'ログイン期限切れ', familyAuthRequired: true }); await flush();
  assert.equal(ui.session.has('sw_ft_v1'), false); assert.equal(ui.session.get('sw_pt_v2:test-link-a'), 'legacy-parent-token'); assert.equal(ui.html().includes('今後の授業'), false); assert.ok(ui.el('fa-pass'));
});

test('a failed family logout hides data and remains a retry after refresh until server revocation succeeds', async () => {
  const ui = await readyFamily(); ui.click('fa-logout'); assert.equal(ui.html().includes('今後の授業'), false); ui.requests.at(-1).fail(); await flush();
  assert.equal(ui.session.get('sw_ft_v1:logout'), '1');
  const refreshed = createUI('student', { hash: '#family', session: ui.session }); assert.equal(refreshed.requests.length, 0); assert.match(refreshed.html(), /ログアウトを再試行/);
  refreshed.click('fa-logout'); refreshed.requests.at(-1).reply({ ok: true }); await flush(); assert.equal(refreshed.session.has('sw_ft_v1'), false); assert.equal(refreshed.session.has('sw_ft_v1:logout'), false);
});

test('email change clears the family session only after its successful request and waits for verification', async () => {
  const ui = await readyFamily(); ui.navigate('#family/settings'); ui.click('fa-mode', { 'data-step': 'emailChange' }); ui.input('fa-email', 'new@example.invalid'); ui.input('fa-pass', 'test-family-password'); ui.submit('family-auth-form');
  assert.equal(ui.requests.at(-1).body.action, 'familyEmailChange'); assert.equal(ui.requests.at(-1).body.ftoken, 'test-family-token');
  ui.requests.at(-1).reply({ ok: true, verificationRequired: true, mailStatus: 'sent' }); await flush();
  assert.equal(ui.session.has('sw_ft_v1'), false); assert.match(ui.html(), /メール内のリンク/); assert.equal(ui.html().includes('今後の授業'), false);
});

test('late family data cannot replace the student page after route departure', async () => {
  const ui = loggedUI(); ui.requests[0].reply(home()); await flush(); const old = ui.requests.at(-1);
  ui.navigate('#home'); ui.requests.at(-1).reply(state([], '生徒ページの表示')); await flush();
  old.reply({ ok: true, data: data('遅れて届いた家族の表示') }); await flush();
  assert.match(ui.html(), /生徒ページの表示/); assert.equal(ui.html().includes('遅れて届いた家族'), false);
});

test('teacher family creation confirms exact children, reveals invitation once, and never caches it', async () => {
  const ui = await teacherReady(); ui.click('family-single',{'data-id':'child-a'});
  assert.equal(ui.requests.length, 1); assert.match(ui.html(), /1人の生徒グループ/); assert.equal(ui.confirms(), 0);
  ui.click('family-confirm'); assert.equal(ui.requests.at(-1).body.studentId, 'child-a'); assert.equal(ui.requests.at(-1).body.op, 'familyEnsureGroup');
  ui.requests.at(-1).reply({ ok: true, family: { label: '【テスト】きょうだい' }, inviteCode: 'fi1.synthetic.private-invite', expiresAt: 1790000000000 }); await flush();
  ui.requests.at(-1).reply(familyList()); await flush(); assert.match(ui.html(), /private-invite/);
  assert.equal(JSON.stringify(ui.writes).includes('private-invite'), false); assert.equal(ui.local.has('sw_kanri_c'), false); assert.equal(JSON.stringify(ui.logs).includes('private-invite'), false);
  ui.click('family-hidecode'); assert.equal(ui.html().includes('private-invite'), false);
});

test('teacher notification retries exclude uncertain and nonretryable authentication emails, and pending families can stop', async () => {
  const ui = await teacherReady(familyList({ families: [{ id: 'family-a', label: '【テスト】家族', status: 'pending', children: [], configured: false }], notifications: [
    { id: 'uncertain', kind: 'invoiceCreated', status: 'uncertain', retryable: false }, { id: 'auth-failed', kind: 'emailVerification', status: 'failed', retryable: false }, { id: 'invoice-failed', kind: 'invoiceCreated', status: 'failed', retryable: true }
  ] }));
  assert.equal((ui.html().match(/data-action="family-notify"/g) || []).length, 1); assert.match(ui.html(), /保護者ページから/);
  ui.click('family-active', { 'data-id': 'family-a' }); ui.click('family-confirm'); assert.equal(ui.requests.at(-1).body.active, false);
});

test('teacher unlink sends only the final child list after explicit confirmation', async () => {
  const ui = await teacherReady(familyList({ families: [{ id: 'family-a', label: '【テスト】きょうだい', status: 'active', configured: true, children: [{ studentId: 'child-a', name: '子A' }, { studentId: 'child-b', name: '子B' }] }] }));
  ui.click('family-edit', { 'data-id': 'family-a' }); ui.check('data-family-child', 'child-b', false); ui.click('family-save');
  assert.equal(ui.requests.length, 1); ui.click('family-confirm');
  assert.equal(ui.requests.at(-1).body.op, 'familySetChildren'); assert.equal(ui.requests.at(-1).body.familyId, 'family-a'); assert.deepEqual(ui.requests.at(-1).body.studentIds, ['child-a']);
});

test('teacher mail retries display a confirmation and send only the selected retryable notification', async () => {
  const ui = await teacherReady(familyList({ notifications: [{ id: 'invoice-failed', familyId: 'family-a', label: '【テスト】通知対象', kind: 'invoiceCreated', status: 'failed', retryable: true }] }));
  ui.click('family-notify', { 'data-id': 'invoice-failed' }); assert.equal(ui.requests.length, 1); assert.match(ui.html(), /確認済みメールへ/);
  ui.click('family-confirm'); assert.equal(ui.requests.at(-1).body.op, 'familyRetryNotifications'); assert.deepEqual(ui.requests.at(-1).body.ids, ['invoice-failed']);
});

test('a failed verification mail is reported as unsent while registration remains saved', async () => {
  const ui = createUI('student', { hash: '#family' }); ui.click('fa-mode', { 'data-step': 'register' });
  ui.input('fa-email', 'parent@example.invalid'); ui.input('fa-invite', 'fi1.synthetic.test'); ui.submit('family-auth-form');
  ui.requests.at(-1).reply({ ok: true, verificationRequired: true, mailStatus: 'failed' }); await flush();
  assert.match(ui.html(), /登録は保存しましたが確認メールを送れませんでした/); assert.equal(ui.session.has('sw_ft_v1'), false);
});

test('an expired verification link provides a working resend route without reloading', async () => {
  const ui = createUI('student', { hash: '#family?verify=expired-challenge' }); ui.click('fa-verify');
  ui.requests.at(-1).reply({ error: '確認リンクが期限切れです' }); await flush();
  ui.click('fa-mode', { 'data-step': 'resend' }); ui.input('fa-email', 'parent@example.invalid'); ui.submit('family-auth-form');
  assert.equal(ui.requests.at(-1).body.action, 'familyResendVerification');
  assert.equal(ui.requests.at(-1).body.challenge, undefined);
});

test('student entry preselects one child and existing-parent linking preserves siblings',async()=>{
 const ui=createUI('admin',{hash:'#families?student=child-b'});ui.requests[0].reply(familyList({families:[{id:'family-a',label:'保護者A',status:'active',configured:true,verifiedAt:'2026-09-01',children:[{studentId:'child-a',name:'子A'}]}]}));await flush();
 ui.click('family-single',{'data-id':'child-b'});ui.click('family-confirm');assert.equal(ui.requests.at(-1).body.studentId,'child-b');
 const linked=createUI('admin',{hash:'#families?student=child-b'});linked.requests[0].reply(familyList({families:[{id:'family-a',label:'保護者A',status:'active',configured:true,children:[{studentId:'child-a',name:'子A'}]}]}));await flush();linked.click('family-link',{'data-id':'family-a'});linked.click('family-confirm');assert.equal(linked.requests.at(-1).body.studentId,'child-b');assert.equal(linked.requests.at(-1).body.familyId,'family-a');assert.equal(linked.requests.at(-1).body.sourceFamilyId,'');assert.equal(linked.requests.at(-1).body.op,'familyMoveStudent');
});
test('invite link opens registration, scrubs URL and survives validation errors without logging in another account',()=>{
 const ui=createUI('student',{hash:'#family?invite=fi1.synthetic.secret',session:new Map([['sw_ft_v1','other-session']])});assert.equal(ui.location.hash,'#family');assert.equal(ui.requests.length,0);assert.equal(ui.el('fa-invite').value,'fi1.synthetic.secret');ui.input('fa-email','');ui.submit('family-auth-form');assert.equal(ui.el('fa-invite').value,'fi1.synthetic.secret');assert.equal(JSON.stringify(ui.writes).includes('synthetic.secret'),false);
});


test('verified email opens password-only form, then completes signup and logs in',async()=>{
 const ui=createUI('student',{hash:'#family?verify=signup-proof'});ui.click('fa-verify');
 ui.requests[0].reply({ok:true,passwordRequired:true,email:'parent@example.invalid'});await flush();
 assert.match(ui.html(),/メール確認済み/);assert.ok(!ui.html().includes('id="fa-email"'));
 ui.input('fa-pass',' short ');ui.input('fa-pass2',' short ');ui.submit('family-auth-form');assert.equal(ui.requests.length,1);
 ui.input('fa-pass',' long password ');ui.input('fa-pass2',' long password ');ui.submit('family-auth-form');
 assert.equal(ui.requests[1].body.action,'familyCompleteRegistration');assert.equal(ui.requests[1].body.pass,' long password ');
 assert.equal(ui.requests[1].body.challenge,'signup-proof');
 ui.requests[1].reply({ok:true,registered:true,email:'parent@example.invalid'});await flush();
 assert.equal(ui.requests[2].body.action,'familyLogin');
 ui.requests[2].reply({...home([]),ftoken:'new-family-token'});await flush();assert.equal(ui.session.get('sw_ft_v1'),'new-family-token');
 assert.equal(JSON.stringify(ui.writes).includes('signup-proof'),false);assert.equal(JSON.stringify(ui.writes).includes('long password'),false);
});
test('password setup failure offers resend; successful save with login network error offers login',async()=>{
 const ui=createUI('student',{hash:'#family?verify=signup-proof'});ui.click('fa-verify');
 ui.requests[0].reply({ok:true,passwordRequired:true,email:'parent@example.invalid'});await flush();
 ui.input('fa-pass',' long password ');ui.input('fa-pass2',' long password ');ui.submit('family-auth-form');
 ui.requests[1].reply({error:'リンクが期限切れです'});await flush();assert.match(ui.html(),/確認メールを再送/);
 ui.input('fa-pass',' long password ');ui.input('fa-pass2',' long password ');ui.submit('family-auth-form');
 ui.requests[2].reply({ok:true,registered:true,email:'parent@example.invalid'});await flush();ui.requests[3].fail();await flush();
 assert.match(ui.html(),/登録が完了しました/);assert.ok(ui.html().includes('id="fa-email"'));
});
