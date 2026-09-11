'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = fs.readFileSync(path.join(__dirname, 'operations-ui.test.cjs'), 'utf8').split('\ntest(')[0];
const { createUI, flush, state } = new Function('require', '__dirname', harness + '\nreturn {createUI, flush, state};')(require, __dirname);
const home = children => ({ ok: true, family: { id: 'family-a', label: '【テスト】家族', email: 'parent@example.invalid' }, children: children || [{ studentId: 'child-a', name: '【テスト】子A' }, { studentId: 'child-b', name: '【テスト】子B' }] });
const data = name => ({ name, month: '2026-09', thisMonth: {}, payments: [], upcoming: [{ id: 'slot-a', date: '2026-09-10', start: '17:00', min: 30, status: 'booked', subject: '英語 '+name, deliveryMode: 'online' }], planMonths: [{ ym: '2026-09', status: 'proposed', revision: 7, termsKnown: true, lessonMin:90, rate30: 1000, monthly: 0, rows: [{ subject: '英語', count: 4 }], total: 4 }] });
function loggedUI() { return createUI('student', { hash: '#family/billing', session: new Map([['sw_ft_v1', 'test-family-token']]) }); }
async function readyFamily() { const ui = loggedUI(); ui.requests[0].reply(home()); await flush(); ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子A') }); await flush(); ui.requests.at(-1).reply({ok:true,data:data('【テスト】子B')}); await flush(); return ui; }

test('parent sections separate billing, reports and account settings without reloading the child',async()=>{
  const ui=await readyFamily(),count=ui.requests.length;
  assert.match(ui.html(),/承認する/);assert.ok(!ui.html().includes('先生からの授業記録'));
  ui.navigate('#family/records');{const st=ui.requests.find(r=>r.body.action==='familyStudentState');st.reply({...state(),viewer:'family',history:[{id:'h1',date:'2026-09-02',start:'17:00',min:90,subject:'英語',done:true}],lessonRecords:[{recordId:'r1',revision:2,date:'2026-09-02',start:'17:00',min:90,subject:'英語',content:'本文',homework:[]}]});await flush();}
  assert.match(ui.html(),/data-folder="英語"/);ui.click('histopen',{'data-folder':'英語'});assert.match(ui.html(),/先生からの授業記録/);assert.match(ui.html(),/<details class="card" data-parent-record="r1" data-record-revision="2"><summary><span data-read-label class="tag">確認中<\/span>/);assert.ok(!ui.html().includes('承認する'));assert.ok(!ui.html().includes('メールアドレスを変更'));
  const count2=ui.requests.length; // 既読の取得(recordReadStatus)は StepwiseLessonRead を読み込む実ブラウザでのみ動く
  ui.navigate('#family/settings');assert.match(ui.html(),/メールアドレスを変更/);assert.equal(ui.requests.length,count2);assert.match(ui.el('tabs').innerHTML,/href="#family\/menu" class="on"[^>]*>保護者メニュー/);
});
function familyList(extra = {}) { return { ok: true, families: [], students: [{ id: 'child-a', name: '【テスト】子A', active: true }, { id: 'child-b', name: '【テスト】子B', active: true }], notifications: [], ...extra }; }
async function teacherReady(list = familyList()) { const ui = createUI('admin', { hash: '#students' }); assert.equal(ui.requests[0].body.op, 'familyList'); ui.requests[0].reply(list); ui.requests[1].reply({ok:true,data:{students:[],inactive:[]}}); await flush(); return ui; }

test('registration collects only email and keeps a correction route while waiting', async () => {
  const ui=createUI('student',{hash:'#family?invite=fi1.synthetic.invite-secret'});
  assert.ok(!ui.html().includes('id="fa-pass"'));
  ui.input('fa-email',' Parent@Example.Invalid ');ui.submit('family-auth-form');
  assert.equal(ui.requests[0].body.pass,undefined);assert.equal(ui.requests[0].body.email,'parent@example.invalid');
  ui.requests[0].reply({ok:true,verificationRequired:true,mailStatus:'sent'});await flush();
  assert.match(ui.html(),/メールを開いて登録を続けてください/);assert.match(ui.html(),/parent@example.invalid/);assert.match(ui.html(),/メールアドレスを修正/);
  assert.equal(ui.session.has('sw_ft_v1'),false);assert.equal(JSON.stringify(ui.writes).includes('invite-secret'),false);
});

test('verification and reset challenges are stripped from the URL and never copied to DOM logs or storage', async () => {
  const secret = 'challenge-test-secret';
  const ui = createUI('student', { hash: '#family?verify=' + secret, local: new Map() });
  assert.equal(ui.location.hash, '#family'); assert.equal(ui.requests.length, 0); assert.equal(ui.html().includes(secret), false);
  await flush();assert.equal(ui.requests[0].body.action,'familyVerificationInfo');ui.requests[0].reply({ok:true,email:'parent@example.invalid',registration:true});await flush();ui.requests.shift();
  assert.match(ui.html(),/parent@example.invalid/);assert.ok(!ui.html().includes('確認メールを再送'));assert.ok(!ui.html().includes('ログインへ'));
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
  ui.requests.at(-1).reply({ ok: true, data: data('Aだけの表示') }); await flush(); assert.match(ui.html(), /【テスト】子Aさんのページを読み込んでいます|さんのマイページ/);
  assert.equal(ui.requests.at(-1).body.studentId, 'child-b');
  ui.requests.at(-1).reply({ ok: true, data: data('Bだけの表示') }); await flush();
  { const st = ui.requests.find(r => r.body.action === 'familyStudentState'); if (st) { st.reply({ ...state(), viewer: 'family' }); await flush(); } const nt = ui.requests.find(r => r.body.action === 'familyNotices'); if (nt) { nt.reply({ ok: true, notices: [] }); await flush(); } }
  ui.navigate('#family/billing'); assert.match(ui.html(), /<h2>【テスト】子A<\/h2>[^]*<h2>【テスト】子B<\/h2>/); const count=ui.requests.length; ui.change('fa-child','child-b'); assert.equal(ui.html().includes('<h2>【テスト】子A</h2>'),false); assert.match(ui.html(), /<h2>【テスト】子B<\/h2>/); assert.equal(ui.requests.length,count); ui.change('fa-child',''); assert.match(ui.html(),/<h2>【テスト】子A<\/h2>/);
  assert.equal(JSON.stringify(ui.writes).includes('parent@example.invalid'), false);
});

test('family approval requires a DOM confirmation and sends that child and proposal revision', async () => {
  const ui = await readyFamily(); const before = ui.requests.length;
  ui.click('fa-planok', { 'data-ym': '2026-09' });
  assert.equal(ui.requests.length, before); assert.equal(ui.confirms(), 0); assert.match(ui.html(), /授業計画の回答確認/);
  ui.click('fa-decide'); const b = ui.requests.at(-1).body;
  assert.equal(b.action, 'familyPlanDecide'); assert.equal(b.studentId, 'child-a'); assert.equal(b.expectedRevision, 7); assert.equal(b.ftoken, 'test-family-token');
  ui.requests.at(-1).reply({ ok: true, data: data('承認後の子A'), notificationWarning: '保存済みですが通知を確認してください' }); await flush();
  assert.match(ui.html(), /通知を確認/);
});

test('child switch discards the previous approval confirmation and membership refresh removes old private data', async () => {
  const ui = await readyFamily(); ui.click('fa-planok', { 'data-ym': '2026-09' }); ui.change('fa-child', 'child-b');
  assert.equal(ui.html().includes('data-action="fa-decide"'), false);
  ui.navigate('#family/settings'); ui.click('fa-home'); assert.equal(ui.html().includes('Bだけの表示'), false);
  ui.requests.at(-1).reply(home([])); await flush(); assert.match(ui.html(), /子どもの紐付けを先生/); assert.equal(ui.html().includes('今後の授業'), false);
});

test('family auth expiry removes protected data without clearing the legacy parent token', async () => {
  const ui = await readyFamily(); ui.session.set('sw_pt_v2:test-link-a', 'legacy-parent-token'); ui.click('fa-refresh');
  ui.requests.at(-1).reply({ error: 'ログイン期限切れ', familyAuthRequired: true }); await flush();
  assert.equal(ui.session.has('sw_ft_v1'), false); assert.equal(ui.session.get('sw_pt_v2:test-link-a'), 'legacy-parent-token'); assert.equal(ui.html().includes('今後の授業'), false); assert.ok(ui.el('fa-pass'));
});

test('a failed family logout hides data and remains a retry after refresh until server revocation succeeds', async () => {
  const ui = await readyFamily(); ui.navigate('#family/settings'); ui.click('fa-logout'); assert.equal(ui.html().includes('今後の授業'), false); ui.requests.at(-1).fail(); await flush();
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

test('teacher unlink sends only the final child list after explicit confirmation', async () => {
  const ui = await teacherReady(familyList({ families: [{ id: 'family-a', label: '【テスト】きょうだい', status: 'active', configured: true, children: [{ studentId: 'child-a', name: '子A' }, { studentId: 'child-b', name: '子B' }] }] }));
  ui.click('family-edit', { 'data-id': 'family-a' }); ui.check('data-family-child', 'child-b', false); ui.click('family-save');
  assert.equal(ui.requests.length, 2); ui.click('family-confirm');
  assert.equal(ui.requests.at(-1).body.op, 'familySetChildren'); assert.equal(ui.requests.at(-1).body.familyId, 'family-a'); assert.deepEqual(ui.requests.at(-1).body.studentIds, ['child-a']);
});

test('a failed verification mail is reported as unsent while registration remains saved', async () => {
  const ui = createUI('student', { hash: '#family?invite=fi1.synthetic.test' });
  ui.input('fa-email', 'parent@example.invalid'); ui.submit('family-auth-form');
  ui.requests.at(-1).reply({ ok: true, verificationRequired: true, mailStatus: 'failed' }); await flush();
  assert.match(ui.html(), /登録は保存しましたが確認メールを送れませんでした/); assert.equal(ui.session.has('sw_ft_v1'), false);
});

test('an expired verification link provides a working resend route without reloading', async () => {
  const ui = createUI('student', { hash: '#family?verify=expired-challenge' }); await flush();
  ui.requests.at(-1).reply({ error: '確認リンクが期限切れです',verificationUnavailable:true }); await flush();
  ui.click('fa-mode', { 'data-step': 'resend' }); ui.input('fa-email', 'parent@example.invalid'); ui.submit('family-auth-form');
  assert.equal(ui.requests.at(-1).body.action, 'familyResendVerification');
  assert.equal(ui.requests.at(-1).body.challenge, undefined);
});

test('student entry links a student to an existing multi-student group',async()=>{
 const linked=createUI('admin',{hash:'#families?student=child-b'});linked.requests[0].reply(familyList({families:[{id:'family-a',label:'保護者A',status:'active',configured:true,children:[{studentId:'child-a',name:'子A'},{studentId:'child-c',name:'子C'}]}]}));await flush();linked.click('family-link',{'data-id':'family-a'});linked.click('family-confirm');assert.equal(linked.requests.at(-1).body.studentId,'child-b');assert.equal(linked.requests.at(-1).body.familyId,'family-a');assert.equal(linked.requests.at(-1).body.sourceFamilyId,'');assert.equal(linked.requests.at(-1).body.op,'familyMoveStudent');
});
test('invite link opens registration, scrubs URL and survives validation errors without logging in another account',()=>{
 const ui=createUI('student',{hash:'#family?invite=fi1.synthetic.secret',session:new Map([['sw_ft_v1','other-session']])});assert.equal(ui.location.hash,'#family');assert.equal(ui.requests.length,0);assert.equal(ui.el('fa-invite').value,'fi1.synthetic.secret');ui.input('fa-email','');ui.submit('family-auth-form');assert.equal(ui.el('fa-invite').value,'fi1.synthetic.secret');assert.equal(JSON.stringify(ui.writes).includes('synthetic.secret'),false);
});


test('verified email opens password-only form, then completes signup and logs in',async()=>{
 const ui=createUI('student',{hash:'#family?verify=signup-proof'});await flush();ui.requests[0].reply({ok:true,email:'parent@example.invalid',registration:true});await flush();ui.requests.shift();ui.click('fa-verify');
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
 const ui=createUI('student',{hash:'#family?verify=signup-proof'});await flush();ui.requests[0].reply({ok:true,email:'parent@example.invalid',registration:true});await flush();ui.requests.shift();ui.click('fa-verify');
 ui.requests[0].reply({ok:true,passwordRequired:true,email:'parent@example.invalid'});await flush();
 ui.input('fa-pass',' long password ');ui.input('fa-pass2',' long password ');ui.submit('family-auth-form');
 ui.requests[1].reply({error:'リンクが期限切れです'});await flush();assert.match(ui.html(),/確認メールを再送/);
 ui.input('fa-pass',' long password ');ui.input('fa-pass2',' long password ');ui.submit('family-auth-form');
 ui.requests[2].reply({ok:true,registered:true,email:'parent@example.invalid'});await flush();ui.requests[3].fail();await flush();
 assert.match(ui.html(),/登録が完了しました/);assert.ok(ui.html().includes('id="fa-email"'));
});

test('verification lookup network failure offers reload, never resends mail or verifies automatically',async()=>{
 const ui=createUI('student',{hash:'#family?verify=lookup-proof'});await flush();
 assert.equal(ui.requests[0].body.action,'familyVerificationInfo');assert.ok(!ui.html().includes('data-action="fa-verify"'));
 ui.requests[0].fail();await flush();assert.match(ui.html(),/もう一度読み込む/);assert.ok(!ui.html().includes('data-step="resend"'));
 ui.click('fa-verification-retry');ui.requests[1].reply({ok:true,email:'changed@example.invalid',registration:false});await flush();
 assert.match(ui.html(),/changed@example.invalid/);assert.match(ui.html(),/このメールアドレスで認証する/);assert.ok(!ui.html().includes('次に、ログイン用'));
 assert.ok(!ui.html().includes('data-step="login"'));assert.ok(!ui.html().includes('data-step="resend"'));
});

 test('student list includes parent management below students and keeps legacy links usable', async()=>{
  const ui=await teacherReady();
  assert.ok(ui.html().indexOf('生徒を追加') < ui.html().indexOf('グループの管理'));
  assert.doesNotMatch(ui.html(),/通知の状況/);
  assert.doesNotMatch(ui.el('nav').innerHTML, /保護者・通知/);
  assert.match(ui.el('nav').innerHTML, /href="#students" class="on"/);
  ui.navigate('#families?student=child-a');
  ui.requests.findLast(r=>r.body.op==='familyList').reply(familyList());
  ui.requests.findLast(r=>r.body.op==='kanriDashboard').reply({ok:true,data:{students:[],inactive:[]}});
  await flush();assert.match(ui.html(),/生徒一覧/);assert.match(ui.html(),/子Aさんの保護者/);
 });
const settingsCard=require('./helpers/operations-ui-harness.cjs').card;
test('student settings issues invitation for the current student group and copies it without caching',async()=>{
 const ui=createUI('admin',{hash:'#s=test-a&tab=settings'});ui.requests[0].reply({ok:true,data:settingsCard()});ui.requests.findLast(r=>r.body.op==='familyList').reply(familyList());await flush();
 ui.click('family-student-invite');assert.equal(ui.requests.at(-1).body.op,'familyEnsureGroup');assert.equal(ui.requests.at(-1).body.studentId,'test-a');
 ui.requests.at(-1).reply({ok:true,family:{label:'【テスト】兄弟グループ'},inviteCode:'fi1.synthetic.settings',expiresAt:1790000000000});await flush();
 assert.match(ui.html(),/兄弟グループの登録案内/);ui.click('family-copy');await flush();assert.match(ui.clipboard,/fi1.synthetic.settings/);
 assert.equal(JSON.stringify(ui.writes).includes('fi1.synthetic.settings'),false);
 ui.click('family-hidecode');assert.doesNotMatch(ui.html(),/fi1.synthetic.settings/);
});
test('student settings keeps registered-parent errors visible and late invitations off another student',async()=>{
 const ui=createUI('admin',{hash:'#s=test-a&tab=settings'});ui.requests[0].reply({ok:true,data:settingsCard()});ui.requests.findLast(r=>r.body.op==='familyList').reply(familyList());await flush();
 ui.click('family-student-invite');ui.requests.at(-1).reply({error:'登録済みの保護者はメールからパスワードを再設定してください'});await flush();assert.match(ui.html(),/role="alert"/);
 ui.click('family-student-invite');const pending=ui.requests.at(-1);ui.navigate('#s=test-b&tab=settings');ui.requests.findLast(r=>r.body.op==='kanriStudent').reply({ok:true,data:settingsCard({id:'test-b',name:'【テスト】別生徒'})});ui.requests.findLast(r=>r.body.op==='familyList').reply(familyList());await flush();
 pending.reply({ok:true,family:{label:'別グループ'},inviteCode:'fi1.synthetic.other',expiresAt:1790000000000});await flush();assert.doesNotMatch(ui.html(),/fi1.synthetic.other/);
});

test('student family settings shows only other members of the current group',async()=>{
 const ui=createUI('admin',{hash:'#s=test-a&tab=settings'});ui.requests[0].reply({ok:true,data:settingsCard()});
 ui.requests[1].reply(familyList({families:[{id:'g1',label:'【テスト】家族A',children:[{studentId:'test-a',name:'本人'},{studentId:'sibling',name:'【テスト】弟'}]},{id:'g2',label:'別家族',children:[{studentId:'unrelated',name:'関係ない生徒'}]}]}));await flush();
 const section=ui.html().split('<h2>家族設定</h2>')[1];assert.match(section,/【テスト】弟/);assert.doesNotMatch(section,/本人|関係ない生徒|別家族/);assert.match(section,/#s=sibling&tab=settings/);
 ui.navigate('#s=sibling&tab=settings');ui.requests.findLast(r=>r.body.op==='kanriStudent').reply({ok:true,data:settingsCard({id:'sibling'})});ui.requests.findLast(r=>r.body.op==='familyList').reply(familyList({families:[{id:'single',label:'単独',children:[{studentId:'sibling',name:'本人'}]}]}));await flush();assert.match(ui.html(),/同じグループの他の生徒はいません/);
});

test('group management excludes single and empty groups',async()=>{
 const ui=await teacherReady(familyList({families:[{id:'one',label:'単独グループ',children:[{studentId:'child-a'}]},{id:'empty',label:'空グループ',children:[]},{id:'two',label:'兄弟グループ',children:[{studentId:'child-a',name:'兄弟A'},{studentId:'child-b',name:'兄弟B'}]}]}));
 assert.match(ui.html(),/兄弟A/);assert.doesNotMatch(ui.html(),/単独グループ|空グループ|family-single/);
});

test('group list displays members without account or billing details',async()=>{
 const ui=await teacherReady(familyList({families:[{id:'two',label:'アカウント名',email:'private@example.invalid',configured:true,verifiedAt:'2026-09-10',children:[{studentId:'a',name:'生徒A'},{studentId:'b',name:'生徒B'}]}]}));
 assert.match(ui.html(),/生徒A/);assert.match(ui.html(),/生徒B/);assert.doesNotMatch(ui.html(),/private@example|アカウント名|メール確認済み|最終ログイン|family-invite|family-active|family-help/);
});
test('student add card opens on demand and retains draft after a failed save',async()=>{
 const ui=await teacherReady();assert.doesNotMatch(ui.html(),/id="n-name"|一覧を更新/);
 ui.click('newstudent-open');ui.input('n-name','【テスト】追加');ui.input('n-email','test@example.invalid');ui.click('addstudent');
 const request=ui.requests.at(-1);assert.equal(request.body.op,'addStudent');assert.equal(request.body.name,'【テスト】追加');assert.equal(request.body.email,'test@example.invalid');
 request.fail();await flush();assert.equal(ui.el('n-name').value,'【テスト】追加');assert.equal(ui.el('n-email').value,'test@example.invalid');ui.click('newstudent-close');assert.doesNotMatch(ui.html(),/id="n-name"/);
});

test('all-child approval targets child B and keeps child A visible after saving',async()=>{
 const ui=await readyFamily();ui.click('fa-planng',{'data-child':'child-b'});ui.input('fa-plan-message','Bへの相談');ui.change('fa-reduce-0','2');ui.click('fa-plan-review');assert.match(ui.html(),/子B/);ui.click('fa-decide');const request=ui.requests.at(-1);assert.equal(request.body.studentId,'child-b');assert.equal(request.body.memo,'Bへの相談');request.reply({ok:true,data:data('更新後B')});await flush();ui.navigate('#family/billing');assert.match(ui.html(),/<h2>【テスト】子A<\/h2>[^]*<h2>【テスト】子B<\/h2>/);assert.doesNotMatch(ui.html(),/子どもの情報を再読み込み/);
});
test('one child has no selector and failed second-child loading retains the first with retry',async()=>{
 const one=loggedUI();one.requests[0].reply(home([{studentId:'child-a',name:'【テスト】子A'}]));await flush();one.requests.at(-1).reply({ok:true,data:data('一人')});await flush();assert.equal(one.el('fa-child'),undefined);
 const ui=loggedUI();ui.requests[0].reply(home());await flush();ui.requests.at(-1).reply({ok:true,data:data('子Aを保持')});await flush();ui.requests.at(-1).fail();await flush();ui.navigate('#family/billing');assert.match(ui.html(),/<h2>【テスト】子A<\/h2>(?![^]*子どもの情報を再読み込み[^]*<h2>【テスト】子B)/);assert.match(ui.html(),/<h2>【テスト】子B<\/h2>[^]*data-action="fa-refresh" data-child="child-b"/);ui.click('fa-refresh',{'data-child':'child-b'});assert.equal(ui.requests.at(-1).body.studentId,'child-b');
});


test('the family home is the child mypage with 今月の授業 at the bottom, and the old schedule section is gone',async()=>{
 const ui=await readyFamily();ui.navigate('#family/home');
 assert.doesNotMatch(ui.el('tabs').innerHTML,/#family\/schedule|>予定</);assert.doesNotMatch(ui.html(),/予定カレンダー/);
 const st=ui.requests.find(r=>r.body.action==='familyStudentState');assert.ok(st,JSON.stringify(ui.requests.map(r=>r.body.action)));assert.equal(st.body.studentId,'child-a');
 st.reply({...state(),viewer:'family'});await flush();
 const html=ui.html();assert.ok(html.indexOf('<h2>予定表</h2>')>=0&&html.indexOf('<h2>予定表</h2>')<html.indexOf('今月の授業 <span class="cnt">2026-09</span>'));assert.match(html,/実施済み<\/div><div class="stat">0<small>回/);
 assert.equal(html.lastIndexOf('今月の授業')>html.lastIndexOf('授業計画'),true);
 ui.navigate('#family/schedule');assert.match(ui.html(),/さんのマイページ/);
});

test('notification bell opens all-child priorities; reading retains required status and routes to the correct child',async()=>{
 const ui=await readyFamily();const notice={id:'plan:b:2',studentId:'child-b',name:'【テスト】子B',title:'料金の確認',section:'billing',priority:0,required:true,read:false};
 assert.equal(ui.requests.at(-1).body.action,'familyNotices');ui.requests.at(-1).reply({ok:true,notices:[notice]});await flush();assert.match(ui.el('parent-header-actions').innerHTML,/お知らせ 1件/);assert.ok(!ui.el('parent-header-actions').innerHTML.includes('fa-logout'));
 ui.click('fa-notices');assert.match(ui.html(),/要対応/);ui.click('fa-notice-open',{'data-notice':notice.id});assert.equal(ui.requests.at(-1).body.action,'familyNoticeRead');assert.equal(ui.requests.at(-1).body.noticeId,notice.id);ui.requests.at(-1).reply({ok:true,notices:[{...notice,read:true}]});await flush();assert.equal(ui.location.hash,'#family/billing');assert.equal(ui.el('fa-child').value,'child-b');assert.match(ui.el('parent-header-actions').innerHTML,/お知らせ 1件/);ui.navigate('#family/settings');assert.match(ui.html(),/data-action="fa-logout"/);
});

test('the family マイページ tab shows the child student home and proxies student actions with the family session', async () => {
  const ui = createUI('student', { hash: '#family/mypage', session: new Map([['sw_ft_v1', 'test-family-token']]) });
  ui.requests[0].reply(home([{ studentId: 'child-a', name: '【テスト】子A' }])); await flush();
  ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子A') }); await flush();
  const st = ui.requests.find(r => r.body.action === 'familyStudentState'); assert.ok(st, JSON.stringify(ui.requests.map(r => r.body.action)));
  assert.deepEqual({ ftoken: st.body.ftoken, studentId: st.body.studentId, k: st.body.k }, { ftoken: 'test-family-token', studentId: 'child-a', k: undefined });
  st.reply({ ...state(), viewer: 'family' }); await flush();
  const nt = ui.requests.find(r => r.body.action === 'familyNotices'); if (nt) { nt.reply({ ok: true, notices: [] }); await flush(); }
  assert.match(ui.el('tabs').innerHTML, /href="#family\/home" class="on"[^>]*>ホーム/);
  assert.match(ui.html(), /【テスト】子Aさんのマイページ（保護者が代わりに操作できます）/); assert.match(ui.html(), /<h2>予定表<\/h2>/); assert.match(ui.html(), /<h2>予定の編集<\/h2>/);
  ui.click('calday', { 'data-date': '2026-09-15' }); ui.click('dayadd'); ui.click('dayact', { 'data-m': 'ng' }); ui.click('selapply');
  const sent = ui.requests.at(-1).body;
  assert.equal(sent.action, 'blockSet'); assert.equal(sent.ftoken, 'test-family-token'); assert.equal(sent.studentId, 'child-a'); assert.equal(sent.k, undefined); assert.deepEqual(sent.add, ['2026-09-15']);
  ui.requests.at(-1).reply({ ok: true, state: { ...state(), blocked: [{ id: 'b1', date: '2026-09-15' }] } }); await flush();
  assert.match(ui.html(), /授業不可<\/span><span class="time">終日/);
  ui.navigate('#family/records'); assert.match(ui.html(), /実施済みの授業はまだありません/); assert.match(ui.html(), /授業の記録（開くと既読になります）/);
});

test('the family 成績 tab is the child grades page with the exam-report panel host', async () => {
  const ui = await readyFamily(); ui.navigate('#family/grades');
  const st = ui.requests.find(r => r.body.action === 'familyStudentState'); st.reply({ ...state(), viewer: 'family' }); await flush();
  assert.match(ui.html(), /【テスト】子Aさんの成績（保護者が代わりに操作できます）/); assert.match(ui.html(), /先生が記録したテストの結果/);
  assert.doesNotMatch(ui.html(), /data-action="fa-mytab"/); assert.match(ui.html(), /<section id="family-grades-panel" data-family-child="child-a"/);
  const g = ui.requests.find(r => r.body.action === 'grades'); assert.ok(g, JSON.stringify(ui.requests.map(r => r.body.action))); assert.equal(g.body.studentId, 'child-a'); assert.equal(g.body.ftoken, 'test-family-token'); assert.equal(g.body.k, undefined);
  g.reply({ ok: true, grades: [{ date: '2026-09-01', test: '中間', subject: '英語', score: 80, max: 100, dev: null, rank: '' }], exams: [] }); await flush();
  assert.match(ui.html(), /成績推移 <span class="cnt">1件/); assert.match(ui.html(), /中間/);
  ui.navigate('#family/home'); assert.doesNotMatch(ui.html(), /data-action="fa-mytab"/); assert.match(ui.html(), /<h2>予定表<\/h2>/);
});

test('the 保護者メニュー tab combines billing, contact and settings, with mail notification toggles saved at once', async () => {
  const ui = loggedUI(); ui.requests[0].reply({ ...home(), emailPrefs: { planProposed: true, invoiceCreated: true, invoiceVoided: true } }); await flush();
  ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子A') }); await flush(); ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子B') }); await flush();
  ui.navigate('#family/menu');
  assert.deepEqual([...ui.el('tabs').innerHTML.matchAll(/>([^<]+)<\/a>/g)].map(m => m[1]), ['ホーム', '授業の記録', '成績', '保護者メニュー']);
  const html = ui.html(); const order = ['<h2>請求・料金承認</h2>', '<h2>先生への連絡</h2>', '<h2>保護者の設定</h2>', 'メール通知'].map(t => html.indexOf(t));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  assert.match(html, /承認する/); assert.match(html, /メールアドレスを変更/); assert.match(html, /id="family-contact-0"/); assert.match(html, /id="family-contact-1"/);
  assert.equal((html.match(/data-action="fa-mailpref"[^>]*checked/g) || []).length, 3);
  ui.check('data-kind', 'invoiceVoided', false);
  assert.deepEqual(ui.requests.at(-1).body, { action: 'familyEmailPrefs', ftoken: 'test-family-token', prefs: { planProposed: true, invoiceCreated: true, invoiceVoided: false } });
  ui.requests.at(-1).reply({ ok: true, emailPrefs: { planProposed: true, invoiceCreated: true, invoiceVoided: false } }); await flush();
  assert.match(ui.html(), /メール通知の設定を保存しました/); assert.equal((ui.html().match(/data-action="fa-mailpref"[^>]*checked/g) || []).length, 2);
  ui.navigate('#family/billing'); assert.match(ui.el('tabs').innerHTML, /href="#family\/menu" class="on"/);
});

test('a parent approves the proposed lesson plan directly from the mypage 授業計画 fold', async () => {
  const ui = loggedUI(); ui.requests[0].reply(home([{ studentId: 'child-a', name: '【テスト】子A' }])); await flush();
  ui.requests.at(-1).reply({ ok: true, data: data('【テスト】子A') }); await flush();
  ui.navigate('#family/home');
  const st = ui.requests.find(r => r.body.action === 'familyStudentState'); st.reply({ ...state(), viewer: 'family', planMonths: [{ ym: '2026-09', status: 'proposed', plan: { '英語': 4 } }] }); await flush();
  const nt = ui.requests.find(r => r.body.action === 'familyNotices'); if (nt) { nt.reply({ ok: true, notices: [] }); await flush(); }
  assert.match(ui.html(), /<strong>英語<\/strong> <span class="tag gray">通常<\/span> 4回<\/span><span class="tag amber">保護者の承認待ち<\/span><\/div><div class="row"[^>]*><button class="btn-primary btn-sm" data-action="fa-planok" data-child="child-a" data-ym="2026-09">承認する<\/button><button class="btn-quiet btn-sm" data-action="fa-planng" data-child="child-a" data-ym="2026-09">回数を調整・見送る<\/button><span class="small muted">1回 [^<]*3,000[^<]*（90分）<\/span>/);
  assert.doesNotMatch(ui.html(), /保護者の方に伝えて/);
  ui.click('fa-planok', { 'data-child': 'child-a' });
  assert.match(ui.html(), /<details class="fold plan" data-fold="plan" open>/); assert.match(ui.html(), /授業計画の回答確認[^]*英語（通常） 4回まで[^]*承認しますか/);
  ui.click('fa-decide');
  const req = ui.requests.at(-1).body; assert.equal(req.action, 'familyPlanDecide'); assert.equal(req.studentId, 'child-a'); assert.equal(req.ym, '2026-09'); assert.equal(req.approve, true); assert.equal(req.expectedRevision, 7);
  assert.deepEqual((req.approvedCounts || []).map(r => [r.subject, r.count]), [['英語', 4]]);
  ui.requests.at(-1).reply({ ok: true, data: { ...data('【テスト】子A'), planMonths: [{ ym: '2026-09', status: 'approved', revision: 8, termsKnown: true, lessonMin: 90, rate30: 1000, monthly: 0, rows: [{ subject: '英語', count: 4 }], total: 4 }] } }); await flush();
  assert.match(ui.html(), /承認しました。/);
  const again = ui.requests.filter(r => r.body.action === 'familyStudentState'); assert.equal(again.length, 2); again.at(-1).reply({ ...state(), viewer: 'family', planMonths: [{ ym: '2026-09', status: 'approved', plan: { '英語': 4 } }] }); await flush();
  assert.match(ui.html(), /<span class="tag green">承認済み<\/span><span class="time">9月<\/span><span class="who"><strong>英語<\/strong>/); assert.doesNotMatch(ui.html(), /data-action="fa-planok"/);
});
