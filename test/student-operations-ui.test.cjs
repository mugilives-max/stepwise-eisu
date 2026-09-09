'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, slot, state, studentReady, flush } = require('./helpers/operations-ui-harness.cjs');

const emptyEmail = () => ({ email:'', verified:false, verifiedAt:'', pendingEmail:'', verificationExpiresAt:'', mailStatus:'' });
const emailState = overrides => ({ ...state(), emailStatus:{ ...emptyEmail(), ...overrides } });
const proof = 'se1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);

test('self-added homework selects a next-subject deadline without sending a client anchor and retains a failed draft', async () => {
  const ui = await studentReady(state([slot('booked', { st:'mine', subject:'数学' })]));
  assert.equal(ui.el('f-tdue-mode').value, 'nextLesson'); assert.equal(ui.el('f-tdue-subject').value, '数学');
  ui.input('f-ttitle', '方程式 <復習>'); ui.input('f-tdue-subject', '化学'); ui.click('taskadd');
  const first = ui.requests.at(-1);
  assert.deepEqual(first.body, { action:'taskAdd', k:'test-link-a', type:'宿題', title:'方程式 <復習>', due:'', dueMode:'nextLesson', dueSubject:'化学' });
  first.reply({ error:'確認してからもう一度追加してください' }); await flush();
  assert.equal(ui.el('f-ttitle').value, '方程式 <復習>'); assert.equal(ui.el('f-tdue-subject').value, '化学');
  ui.click('taskadd'); ui.requests.at(-1).reply({ ok:true, state:state() }); await flush();
  assert.equal(ui.el('f-ttitle').value, '');
});

test('deadline mode changes preserve input and date, no-deadline, and missing-subject requests stay distinct', async () => {
  const ui = await studentReady(state([])); ui.input('f-ttitle', '単語を復習'); ui.click('taskadd');
  assert.equal(ui.requests.length, 1, 'next-subject mode needs a subject');
  ui.change('f-tdue-mode', 'date'); assert.equal(ui.el('f-ttitle').value, '単語を復習');
  ui.click('taskadd'); assert.equal(ui.requests.length, 1, 'date mode needs an actual date');
  ui.input('f-tdue', '2026-09-14'); ui.change('f-tdue-mode', 'none'); ui.change('f-tdue-mode', 'date');
  assert.equal(ui.el('f-tdue').value, '2026-09-14'); ui.click('taskadd');
  assert.equal(ui.requests.at(-1).body.due, '2026-09-14'); assert.equal(ui.requests.at(-1).body.dueSubject, '');
  ui.requests.at(-1).reply({ error:'一時的な確認待ち' }); await flush(); ui.change('f-tdue-mode', 'none'); ui.click('taskadd');
  assert.equal(ui.requests.at(-1).body.dueMode, 'none'); assert.equal(ui.requests.at(-1).body.due, ''); assert.equal(ui.requests.at(-1).body.dueSubject, '');
});

test('homework drafts are scoped to the dedicated student link and late saves cannot clear another draft', async () => {
  const ui = await studentReady(); ui.input('f-ttitle', 'Aの宿題'); ui.input('f-tdue-subject', '数学'); ui.click('taskadd'); const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b'); ui.requests.at(-1).reply(state([], '【テスト】B')); await flush();
  assert.equal(ui.el('f-ttitle').value, ''); ui.input('f-ttitle', 'Bのメモ');
  old.reply({ ok:true, state:state([], '古いA') }); await flush();
  assert.equal(ui.el('f-ttitle').value, 'Bのメモ'); assert.equal(ui.html().includes('古いA'), false);
});

test('task lists show pending same-subject deadlines and the frozen deadline of completed homework', async () => {
  const tasks = [
    { id:'pending-task', type:'宿題', title:'次の英語まで', dueMode:'nextLesson', dueSubject:'英語', due:'', nextLessonPending:true },
    { id:'completed-task', type:'宿題', title:'完了分', done:true, doneAt:'2026-09-08', dueMode:'nextLesson', dueSubject:'数学', due:'2026-09-10', dueStart:'17:00' },
    { id:'escaped-task', type:'メモ', title:'<img src=x>', dueMode:'nextLesson', dueSubject:'<script>x</script>', due:'' }
  ];
  const ui = await studentReady({ ...state(), tasks });
  assert.match(ui.html(), /次回の英語授業（予定未定）/);
  assert.match(ui.html(), /次回の数学授業（2026\/9\/10 17:00）まで・2026-09-08 に完了/);
  assert.match(ui.html(), /&lt;script&gt;x&lt;\/script&gt;/); assert.equal(ui.html().includes('<img src=x>'), false);
});

const published = () => ({ date:'2026-09-07', start:'17:00', subject:'英語', content:'関係代名詞 <復習>', progress:'自分で説明できた', nextFocus:'長文に進む', teacherNote:'PRIVATE_TEACHER_NOTE', reportDraft:'PRIVATE_DRAFT', homework:[{ title:'単語 <再確認>', dueMode:'nextLesson', dueSubject:'英語', due:'', nextLessonPending:true }] });
test('saved public lesson records show escaped content and deadline only in student and family views', async () => {
  const ui = await studentReady({ ...state(), lessonRecords:[published()] }); ui.navigate('#history');
  assert.match(ui.html(), /先生からの授業記録/); assert.match(ui.html(), /関係代名詞 &lt;復習&gt;/); assert.match(ui.html(), /次回の英語授業（予定未定）/);
  assert.equal(ui.html().includes('PRIVATE_'), false);
  const family = createUI('student', { hash:'#family/records', session:new Map([['sw_ft_v1','test-family-token']]) });
  family.requests[0].reply({ ok:true, family:{ label:'【テスト】家族', email:'parent@example.invalid' }, children:[{ studentId:'test-child', name:'【テスト】子' }] }); await flush();
  family.requests.at(-1).reply({ ok:true, data:{ name:'【テスト】子', month:'2026-09', thisMonth:{}, payments:[], planMonths:[], upcoming:[], lessonRecords:[published()] } }); await flush();
  assert.match(family.html(), /関係代名詞 &lt;復習&gt;/); assert.match(family.html(), /自分で説明できた/); assert.equal(family.html().includes('PRIVATE_'), false);
});

async function staleBatch(ui) {
  ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const old = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({ error:'案内が変更されています', errorCode:'conflict', refresh:true, completed:0, pending:false, results:[] }); await flush(); return old;
}
test('stale offer review performs one refresh, blocks old selections, then requires a newly reviewed snapshot', async () => {
  const ui = await studentReady(), old = await staleBatch(ui);
  assert.equal(ui.requests.length, 3); assert.equal(ui.requests.at(-1).body.action, 'state'); assert.equal(ui.beforeUnload(), false);
  ui.click('batchall'); ui.click('batchreview'); ui.click('askaccept', { 'data-id':'slot-a' }); assert.equal(ui.requests.length, 3);
  ui.requests.at(-1).reply(state([slot('slot-a', { start:'19:00', subject:'化学', deliveryMode:'online' })])); await flush();
  ui.click('batchreview'); assert.equal(ui.requests.length, 3, 'the old selection was cleared');
  ui.click('batchall'); ui.click('batchreview'); assert.match(ui.html(), /19:00/); ui.click('batchsend');
  assert.notEqual(ui.requests.at(-1).body.requestId, old.requestId);
  assert.equal(ui.requests.at(-1).body.expectedSnapshots[0].start, '19:00'); assert.equal(ui.requests.at(-1).body.expectedSnapshots[0].subject, '化学');
});

test('failed stale refresh leaves an explicit reload action and never confirms the outdated offer', async () => {
  const ui = await studentReady(); await staleBatch(ui); ui.requests.at(-1).fail(); await flush();
  assert.match(ui.html(), /最新の案内を読み込めません/); ui.click('batchall'); ui.click('batchreview'); assert.equal(ui.requests.length, 3);
  ui.click('batchrefresh'); assert.equal(ui.requests.at(-1).body.action, 'state'); ui.requests.at(-1).reply(state([])); await flush();
  assert.equal(ui.html().includes('data-action="batchrefresh"'), false); assert.equal(ui.html().includes('slot-a'), false);
});

test('a pending confirmation keeps its original request even if an error also requests refresh', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const payload = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({ pending:true, errorCode:'pending', refresh:true, error:'処理が継続中です', results:[] }); await flush();
  assert.equal(ui.requests.length, 2); assert.equal(ui.beforeUnload(), true); ui.click('batchsend'); assert.deepEqual(ui.requests.at(-1).body, payload);
});

test('a late stale-batch response cannot refresh or display the previous child', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b'); ui.requests.at(-1).reply(state([], '【テスト】B')); await flush(); const count = ui.requests.length;
  old.reply({ error:'古いAの案内', errorCode:'conflict', pending:false, completed:0, refresh:true }); await flush();
  assert.equal(ui.requests.length, count); assert.equal(ui.html().includes('古いA'), false);
});

test('standalone student email proof is removed from the URL and POSTed once without a student or family credential', async () => {
  const ui = createUI('student', { local:new Map(), hash:'#student-email?verify=' + proof });
  assert.equal(ui.location.hash, '#student-email'); assert.equal(ui.requests.length, 0); assert.equal(ui.html().includes(proof), false);
  ui.click('se-verify'); assert.deepEqual(ui.requests[0].body, { action:'studentEmailVerify', challenge:proof }); ui.click('se-verify'); assert.equal(ui.requests.length, 1);
  ui.requests[0].reply({ ok:true, verified:true, message:'メールアドレスを確認しました。' }); await flush();
  assert.match(ui.html(), /メールアドレスを確認しました/); assert.equal(ui.html().includes('data-action="se-verify"'), false);
  assert.equal(JSON.stringify([...ui.writes,...ui.logs]).includes(proof), false); assert.equal(ui.requests.length, 1);
});

test('expired student-email links can return to the registration instructions without exposing or storing the challenge', async () => {
  const ui = createUI('student', { local:new Map(), hash:'#student-email?verify=' + proof }); ui.click('se-verify');
  ui.requests[0].reply({ error:'リンクの期限が切れています <確認>' }); await flush(); assert.match(ui.html(), /&lt;確認&gt;/);
  ui.click('se-back'); assert.equal(ui.html().includes('data-action="se-verify"'), false); assert.match(ui.html(), /生徒専用リンク/); assert.equal(ui.requests.length, 1);
});

test('request failure and uncertain delivery are distinct from sent mail, with no automatic retry', async () => {
  for (const status of ['failed','uncertain']) {
    const ui = await studentReady(emailState({ email:'old@example.invalid', verified:true })); ui.navigate('#student-email'); ui.input('se-email', 'new@example.invalid'); ui.submit('student-email-form');
    assert.deepEqual(ui.requests.at(-1).body, { action:'studentEmailRequest', k:'test-link-a', email:'new@example.invalid' });
    ui.requests.at(-1).reply({ ok:true, verificationRequired:true, mailStatus:status, emailStatus:{ ...emptyEmail(), email:'old@example.invalid', verified:true, pendingEmail:'new@example.invalid', mailStatus:status } }); await flush();
    assert.match(ui.html(), /old@example.invalid（確認済み）/); assert.match(ui.html(), status === 'failed' ? /確認メールを送れませんでした/ : /まず受信箱を確認/);
    assert.equal(ui.requests.length, 2); assert.equal(JSON.stringify([...ui.writes,...ui.logs]).includes('new@example.invalid'), false);
    ui.click('se-resend'); assert.deepEqual(ui.requests.at(-1).body, { action:'studentEmailResend', k:'test-link-a' });
  }
});

test('email removal is confirmed in the page and clears the previously typed address after success', async () => {
  const ui = await studentReady(emailState({ email:'old@example.invalid', verified:true })); ui.navigate('#student-email'); ui.input('se-email', 'draft@example.invalid');
  ui.click('se-askremove'); assert.equal(ui.requests.length, 1); assert.equal(ui.confirms(), 0); assert.equal(ui.el('se-email').value, 'draft@example.invalid');
  ui.click('se-remove'); assert.deepEqual(ui.requests.at(-1).body, { action:'studentEmailRemove', k:'test-link-a' });
  ui.requests.at(-1).reply({ ok:true, emailStatus:emptyEmail() }); await flush();
  assert.equal(ui.el('se-email').value, ''); assert.equal(ui.html().includes('old@example.invalid'), false); assert.match(ui.html(), /メール通知を解除しました/);
});

test('successful proof refreshes the current student status and late registration results stay scoped', async () => {
  const ui = await studentReady(emailState({ pendingEmail:'new@example.invalid' })); ui.navigate('#student-email?verify=' + proof); ui.click('se-verify');
  ui.requests.at(-1).reply({ ok:true, verified:true, message:'メールアドレスを確認しました。' }); await flush(); assert.equal(ui.requests.at(-1).body.action, 'state');
  ui.requests.at(-1).reply(emailState({ email:'new@example.invalid', verified:true })); await flush(); assert.match(ui.html(), /new@example.invalid（確認済み）/); assert.equal(ui.html().includes('確認待ち：'), false);
  ui.input('se-email', 'later@example.invalid'); ui.submit('student-email-form'); const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b'); ui.requests.at(-1).reply({ ...emailState(), me:{name:'【テスト】B'} }); await flush();
  old.reply({ ok:true, emailStatus:{ ...emptyEmail(), pendingEmail:'later@example.invalid' } }); await flush();
  assert.equal(ui.html().includes('later@example.invalid'), false); assert.equal(ui.el('se-email').value, '');
});

test('persisted uncertain mail remains visible after reload and removed preview parameter cannot switch the student identity', async () => {
  const status = { pendingEmail:'pending@example.invalid', mailStatus:'uncertain' };
  const ui = await studentReady(emailState(status)); ui.navigate('#student-email'); assert.match(ui.html(), /まず受信箱を確認/); assert.equal(ui.requests.length, 1);
  const preview = createUI('student', { hash:'#student-email', search:'?preview=test-preview-key' });
  preview.requests[0].reply(emailState(status)); await flush(); assert.equal(preview.requests[0].body.k, 'test-link-a'); assert.equal(preview.local.get('sw_k'), 'test-link-a');
  assert.equal(preview.html().includes('先生のプレビュー'), false);
});
