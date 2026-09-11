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
  const ui = await studentReady({ ...state(), lessonRecords:[published()] }); ui.navigate('#history'); assert.match(ui.html(), /data-folder="英語"/); ui.click('histopen', { 'data-folder':'英語' });
  assert.match(ui.html(), /先生からの授業記録/); assert.match(ui.html(), /関係代名詞 &lt;復習&gt;/); assert.match(ui.html(), /次回の英語授業（予定未定）/);
  assert.equal(ui.html().includes('PRIVATE_'), false);
  const family = createUI('student', { hash:'#family/records', session:new Map([['sw_ft_v1','test-family-token']]) });
  family.requests[0].reply({ ok:true, family:{ label:'【テスト】家族', email:'parent@example.invalid' }, children:[{ studentId:'test-child', name:'【テスト】子' }] }); await flush();
  family.requests.at(-1).reply({ ok:true, data:{ name:'【テスト】子', month:'2026-09', thisMonth:{}, payments:[], planMonths:[], upcoming:[], lessonRecords:[published()] } }); await flush();
  assert.match(family.html(), /関係代名詞 &lt;復習&gt;/); assert.doesNotMatch(family.html(), /自分で説明できた|長文に進む/); assert.doesNotMatch(ui.html(), /自分で説明できた|長文に進む/); assert.equal(family.html().includes('PRIVATE_'), false);
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

test('students toggle mail items per kind, saving immediately and reverting on failure', async () => {
  const all = { offered:true, changed:true, cancelled:true, cancelDeclined:true }, checked = html => (html.match(/data-action="se-pref"[^>]*checked/g) || []).length;
  const ui = await studentReady(emailState({ email:'me@example.invalid', verified:true, prefs:all })); ui.navigate('#student-email');
  assert.match(ui.html(), /メールで受け取る項目/); assert.equal(checked(ui.html()), 4);
  ui.check('data-kind', 'cancelDeclined', false);
  assert.deepEqual(ui.requests.at(-1).body, { action:'studentEmailPrefs', k:'test-link-a', prefs:{ ...all, cancelDeclined:false } });
  ui.requests.at(-1).reply({ ok:true, emailStatus:{ ...emptyEmail(), email:'me@example.invalid', verified:true, prefs:{ ...all, cancelDeclined:false } } }); await flush();
  assert.match(ui.html(), /通知設定を保存しました/); assert.equal(checked(ui.html()), 3);
  ui.check('data-kind', 'offered', false); assert.deepEqual(ui.requests.at(-1).body.prefs, { ...all, offered:false, cancelDeclined:false });
  ui.requests.at(-1).reply({ error:'通知設定の内容を確認してください' }); await flush();
  assert.match(ui.html(), /通知設定の内容を確認してください/); assert.equal(checked(ui.html()), 3); assert.equal(ui.requests.length, 3);
});

test('the home calendar shows registration-unavailable days and times like the schedule page', async () => {
  const s = { ...state(), teacherOff:[{ date:'2026-09-15' }, { date:'2026-09-16', start:'12:00', end:'13:30' }] };
  const ui = await studentReady(s);
  assert.match(ui.html(), /data-date="2026-09-15">15<span class="calmarks"><\/span><span class="callbl to"[^>]*>登録不可<\/span>/);
  assert.match(ui.html(), /data-date="2026-09-16">16<span class="calmarks"><\/span><span class="callbl to"[^>]*>登録不可12-13:30<\/span>/);
  ui.click('calday', { 'data-date':'2026-09-15' }); assert.match(ui.html(), /<span class="tag gray">登録不可（終日）<\/span>/); assert.doesNotMatch(ui.html(), /先生の予定があるため/);
  ui.click('helptoff'); assert.match(ui.html(), /先生の予定があるため、この時間帯には授業を登録できません/); ui.click('helptoff'); assert.doesNotMatch(ui.html(), /先生の予定があるため/);
  ui.navigate('#schedule'); assert.match(ui.html(), /登録不可12-13:30/);
});

test('the student page has no 予定 tab and registers or removes schedule items from the selected day', async () => {
  const s = { ...state(), blocked:[{ id:'b1', date:'2026-09-16', note:'部活' }], events:[{ id:'e1', date:'2026-09-17', dateTo:'2026-09-17', title:'大会', kind:'event' }] };
  const ui = await studentReady(s);
  assert.equal(ui.el('tabs').innerHTML.includes('#schedule'), false); assert.equal(ui.el('tabs').innerHTML.includes('>予定<'), false);
  assert.doesNotMatch(ui.html(), /予定管理|href="#schedule"|data-action="panel"/); assert.match(ui.html(), /<h2>予定の編集<\/h2><div class="card"/); assert.match(ui.html(), /<h2>予定の編集<\/h2>[^]*<details class="fold tasks" data-fold="tasks" open><summary><h2>[^]*?やることリスト[^]*<details class="fold offers" data-fold="offers"><summary>/);
  ui.click('calday', { 'data-date':'2026-09-15' }); ui.click('dayadd'); assert.match(ui.html(), /data-m="event"[^>]*>予定共有</);
  ui.click('dayact', { 'data-m':'event' }); assert.ok(ui.el('b-etitle')); assert.match(ui.html(), /予定の日をタップ/);
  ui.input('b-etitle', '模試'); ui.click('selapply'); assert.equal(ui.requests.at(-1).body.action, 'eventAddMany'); assert.equal(ui.requests.at(-1).body.title, '模試'); assert.equal(JSON.stringify(ui.requests.at(-1).body).includes('2026-09-15'), true);
  ui.requests.at(-1).reply({ ok:true, state:s }); await flush();
  ui.click('calday', { 'data-date':'2026-09-16' }); assert.match(ui.html(), /授業不可<\/span><span class="time">終日<\/span><span class="who">部活</); assert.match(ui.html(), /class="calday(?: sel)? ngday" data-action="calday" data-date="2026-09-16">16<span class="calmarks"><\/span><span class="callbl to"[^>]*>授業不可<\/span>/); const before = ui.requests.length; ui.click('delblock', { 'data-ids':'b1' }); assert.equal(ui.requests.length, before); assert.match(ui.html(), /授業できない日 9\/16\(水\)（終日） を解除しますか\?/); ui.click('closebar'); assert.doesNotMatch(ui.html(), /解除しますか/); ui.click('delblock', { 'data-ids':'b1' }); ui.click('doremove'); assert.deepEqual(ui.requests.at(-1).body, { action:'unblock', k:'test-link-a', blockIds:['b1'] });
  ui.requests.at(-1).reply({ ok:true, state:s }); await flush();
  ui.click('calday', { 'data-date':'2026-09-17' }); assert.match(ui.html(), /<span class="tag coral">重要な予定<\/span><span class="time"><\/span><span class="who">大会/); ui.click('delevent', { 'data-id':'e1' }); assert.match(ui.html(), /重要な予定「大会」（9\/17\(木\)） を削除しますか\?/); ui.click('doremove'); assert.deepEqual(ui.requests.at(-1).body, { action:'eventDel', k:'test-link-a', eventId:'e1' });
  ui.navigate('#schedule'); assert.equal(ui.el('tabs').innerHTML.includes('class="on">ホーム'), true);
});

test('students turn a sentence into checked proposals and register them through the existing actions', async () => {
  const s = { ...state(), nlEnabled:true, blocked:[{ id:'b0', date:'2026-09-16' }] };
  const ui = await studentReady(s);
  assert.equal(ui.el('nl-text'), undefined); ui.click('calday', { 'data-date':'2026-09-15' }); ui.click('dayadd');
  assert.ok(ui.el('nl-text')); assert.match(ui.html(), /手動で予定入力[^]*?文章で自動入力/); const text = '来週の月水は16時から19時、16と17日は部活で無理、20日に模試';
  ui.input('nl-text', text); ui.click('nl-parse');
  assert.deepEqual(ui.requests.at(-1).body, { action:'scheduleParse', k:'test-link-a', text });
  ui.requests.at(-1).reply({ ok:true, summary:'3件を読み取りました。', today:'2026-09-08', questions:['模試の時間は登録していません。'], items:[
    { kind:'wish', dates:['2026-09-14','2026-09-16'], start:'16:00', end:'19:00', note:'', confidence:'high', needsTime:false },
    { kind:'block', dates:['2026-09-16','2026-09-17'], start:'', end:'', note:'部活', confidence:'high' },
    { kind:'event', dates:['2026-09-20'], start:'', end:'', note:'', title:'模試', test:true, alsoBlock:false, confidence:'low' } ] }); await flush();
  assert.match(ui.html(), /授業できる時間帯/); assert.match(ui.html(), /予定の共有：模試（テスト・模試）/); assert.match(ui.html(), /読み取りに自信がありません/); assert.match(ui.html(), /模試の時間は登録していません/);
  ui.click('nl-register');
  assert.deepEqual(ui.requests.at(-1).body, { action:'wishMany', k:'test-link-a', kind:'ok', dates:['2026-09-14','2026-09-16'], start:'16:00', end:'19:00', note:'', deliveryMode:'' });
  ui.requests.at(-1).reply({ ok:true, state:s }); await flush();
  assert.deepEqual(ui.requests.at(-1).body, { action:'blockSet', k:'test-link-a', add:['2026-09-17'], removeIds:[], note:'部活', start:'', end:'' });
  ui.requests.at(-1).reply({ ok:true, state:s }); await flush();
  const ev = ui.requests.at(-1).body; assert.equal(ev.action, 'eventAddMany'); assert.equal(ev.title, '模試'); assert.equal(ev.kind, 'test'); assert.equal(ev.alsoBlock, false); assert.equal(ev.ranges[0].date, '2026-09-20'); assert.equal(ev.ranges[0].dateTo, '2026-09-20');
  ui.requests.at(-1).reply({ ok:true, state:s }); await flush();
  assert.equal(ui.requests.length, 5); assert.equal(ui.html().includes(text), false); assert.doesNotMatch(ui.html(), /チェックした内容で登録する/);
  ui.input('nl-text', 'x'); ui.click('nl-parse'); ui.requests.at(-1).reply({ error:'文章からの登録はまだ準備中です。予定表の＋から登録してください', errorCode:'notConfigured' }); await flush();
  assert.match(ui.html(), /まだ準備中/); assert.equal(ui.requests.length, 6);
});

test('the sentence card is hidden while the API key is not configured', async () => {
  const ui = await studentReady(state()); ui.click('calday', { 'data-date':'2026-09-15' }); ui.click('dayadd'); assert.equal(ui.el('nl-text'), undefined); assert.doesNotMatch(ui.html(), /文章で自動入力/); assert.match(ui.html(), /手動で予定入力/);
});

test('the offers section is a collapsed details block with one select-all / clear toggle', async () => {
  const ui = await studentReady();
  assert.match(ui.html(), /<details class="fold offers" data-fold="offers"><summary><h2>[^]*?授業登録 <span class="cnt">2件・返事をお願いします/);
  assert.doesNotMatch(ui.html(), /全件選択|選択を解除|data-action="batchclear"/); assert.match(ui.html(), /data-action="batchall"[^>]*>一括選択</);
  ui.click('batchall'); assert.doesNotMatch(ui.html(), /data-action="batchall"/); assert.match(ui.html(), /data-action="batchclear"[^>]*>選択解除</);
  ui.check('data-accept-id', 'slot-b', false); assert.match(ui.html(), /data-action="batchall"[^>]*>一括選択</);
  ui.click('batchall'); ui.click('batchclear'); assert.match(ui.html(), /data-action="batchall"[^>]*>一括選択</); assert.equal((ui.html().match(/data-accept-id="[^"]+" checked/g) || []).length, 0);
});

test('the 授業計画 fold separates proposed notices from the approved plan with counts', async () => {
  const s = { ...state([]), history:[{ id:'h1', date:'2026-09-02', start:'17:00', min:90, subject:'英語', done:true }], plan:{ '英語':4 }, planStatus:'approved',
    planMonths:[{ ym:'2026-09', status:'approved', plan:{ '英語':4 } }, { ym:'2026-10', status:'proposed', plan:{ '英語':3, '数学':2 } }] };
  const ui = await studentReady(s);
  assert.match(ui.html(), /<details class="fold plan" data-fold="plan"><summary><h2>[^]*?授業計画 <span class="cnt">2件の案内<\/span>/);
  assert.match(ui.html(), /案内 <span[^>]*>保護者の承認待ち<\/span><\/h3><div class="slotline"><span class="tag amber">案内<\/span><span class="time">10月<\/span><span class="who"><strong>英語<\/strong> 3回<\/span><span class="tag amber">保護者の承認待ち<\/span><\/div><div class="slotline"><span class="tag amber">案内<\/span><span class="time">10月<\/span><span class="who"><strong>数学<\/strong> 2回/);
  assert.match(ui.html(), /保護者の方に伝えて、保護者ページから承認・調整をお願いしましょう/);
  assert.match(ui.html(), /実施計画 <span[^>]*>承認済み<\/span><\/h3><div class="slotline"><span class="tag green">承認済み<\/span><span class="time">9月<\/span><span class="who"><strong>英語<\/strong> 実施 1・予定 0<span class="muted">／計画 4回<\/span><\/span><span class="small"[^>]*>あと 3 回<\/span>/);
  assert.match(ui.html(), /あと 3 回、日程調整が必要です/);
  const none = await studentReady({ ...state([]), planMonths:[] }); assert.doesNotMatch(none.html(), /授業計画/);
  const onlyProposed = await studentReady({ ...state([]), planMonths:[{ ym:'2026-09', status:'proposed', plan:{ '英語':4 } }] });
  assert.match(onlyProposed.html(), /授業計画 <span class="cnt">1件の案内<\/span>/); assert.match(onlyProposed.html(), /承認済みの計画はありません/);
  const legacy = await studentReady({ ...state([]), plan:{ '英語':4 }, planStatus:'proposed' }); assert.match(legacy.html(), /1件の案内/);
});

test('the lesson history shows subject-and-kind folder cards that open into their records', async () => {
  const s = { ...state(), history:[
    { id:'h1', date:'2026-09-02', start:'17:00', min:90, subject:'英語', kind:'', done:true },
    { id:'h2', date:'2026-09-04', start:'17:00', min:60, subject:'英語', kind:'講習', done:true },
    { id:'h3', date:'2026-09-05', start:'17:00', min:90, subject:'英語', kind:'', done:true },
    { id:'h4', date:'2026-09-06', start:'17:00', min:90, subject:'数学', kind:'', done:false } ],
    lessonRecords:[{ ...published(), date:'2026-09-05', start:'17:00', min:90, subject:'英語', recordId:'r1' }] };
  const ui = await studentReady(s); ui.navigate('#history');
  assert.match(ui.html(), /<strong>合計<\/strong> 3回<\/span><span>英語 2回<\/span><span>英語（講習） 1回<\/span>/);
  assert.match(ui.html(), /<button class="folder-card" data-action="histopen" data-folder="英語"><span class="fname">📁 英語<\/span><span class="small muted">2回・180分・最終 9\/5\(土\)<\/span><span class="tag blue">記録 1件<\/span><\/button>/);
  assert.match(ui.html(), /data-folder="英語（講習）"><span class="fname">📁 英語（講習）<\/span><span class="small muted">1回・60分・最終 9\/4\(金\)<\/span><span class="small muted">記録はまだありません<\/span>/);
  assert.doesNotMatch(ui.html(), /数学 1回|関係代名詞/);
  ui.click('histopen', { 'data-folder':'英語' });
  assert.match(ui.html(), /<h2>📁 英語 <span class="cnt">2回・180分・記録 1件<\/span><\/h2>/);
  assert.match(ui.html(), /先生からの授業記録<\/h3><details class="card"><summary>9\/5\(土\) 17:00 英語<\/summary>[^]*?関係代名詞 &lt;復習&gt;[^]*?<div class="slotline"><span class="time">9\/2\(水\) 17:00<\/span>/);
  assert.doesNotMatch(ui.html(), /folder-card/);
  ui.click('histback'); assert.match(ui.html(), /folder-card/); assert.doesNotMatch(ui.html(), /関係代名詞/);
});

test('calendar lesson labels show start and end time', async () => {
  const ui = await studentReady(state([slot('slot-a', { date:'2026-09-15', start:'17:00', min:90, subject:'英語', st:'mine' })]));
  assert.match(ui.html(), /data-date="2026-09-15">15<span class="calmarks"><\/span><span class="calbox"><span class="t">17:00-18:30<\/span><span class="s">英語<\/span><\/span>/);
});

test('calendar shows every lesson of a day without a +N summary', async () => {
  const ui = await studentReady(state(['09:00','11:00','13:00','15:00','17:00'].map((t, i) => slot('slot-' + i, { date:'2026-09-15', start:t, min:60, subject:'英語', st:'mine' }))));
  const cell = ui.html().match(/data-date="2026-09-15">15<span class="calmarks"><\/span>([^]*?)<\/button>/)[1];
  assert.equal((cell.match(/class="calbox"/g) || []).length, 5); assert.doesNotMatch(cell, /callbl more/);
});
