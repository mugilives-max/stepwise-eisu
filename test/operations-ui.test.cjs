'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, slot, state, card, studentReady, adminReady, flush } = require('./helpers/operations-ui-harness.cjs');

test('batch selection confirms exact dates in the DOM before one POST and one state adoption', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.check('data-accept-id', 'slot-b', false); ui.click('batchreview');
  assert.equal(ui.requests.length, 1); assert.match(ui.html(), /次の1件を確定/); assert.equal(ui.confirms(), 0);
  ui.click('batchsend'); const r = ui.requests.at(-1); assert.deepEqual(r.body.slotIds, ['slot-a']); assert.equal(r.body.action, 'acceptMany');
  ui.click('batchsend'); assert.equal(ui.requests.length, 2);
  r.reply({ ok: true, pending: false, completed: 1, results: [{ slotId: 'slot-a', status: 'booked' }], state: state([slot('slot-a', { st: 'mine' }), slot('slot-b')]) }); await flush();
  assert.equal(ui.requests.length, 2, 'response state needs no per-slot refresh'); assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /確定済み/);
});

test('batch partial and network failures retain the identical request and show completed versus pending dates', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.reply({ ok: false, pending: true, completed: 1, results: [{ slotId: 'slot-a', status: 'booked' }, { slotId: 'slot-b', status: 'pending', error: '外部処理待ち' }], state: state([slot('slot-a', { st: 'mine' }), slot('slot-b')]) }); await flush();
  assert.match(ui.html(), /確定済み/); assert.match(ui.html(), /未完了/); assert.equal(ui.beforeUnload(), true);
  ui.click('batchsend'); assert.deepEqual(ui.requests.at(-1).body, payload); ui.requests.at(-1).fail(); await flush();
  ui.click('batchsend'); assert.deepEqual(ui.requests.at(-1).body, payload);
});

test('a late batch response cannot display the previous student after a dedicated-link switch', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b'); ui.requests.at(-1).reply(state([], '【テスト】生徒B')); await flush();
  old.reply({ ok: true, pending: false, results: [], state: state([], '古いAの応答') }); await flush();
  assert.match(ui.html(), /生徒B/); assert.equal(ui.html().includes('古いAの応答'), false);
});

test('batch validation failure permits correction and uncertain mail never offers a notification resend', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend');
  ui.requests.at(-1).reply({ error: '定員を確認してください', results: [{ slotId: 'slot-b', status: 'error' }] }); await flush();
  assert.equal(ui.beforeUnload(), false); ui.check('data-accept-id', 'slot-b', false); ui.click('batchreview'); ui.click('batchsend');
  assert.deepEqual(ui.requests.at(-1).body.slotIds, ['slot-a']);
  ui.requests.at(-1).reply({ ok: true, pending: false, notification: 'uncertain', warning: '通知の到達を確認してください', results: [], state: state([]) }); await flush();
  assert.match(ui.html(), /通知の到達を確認/); assert.equal(ui.html().includes('data-action="batchsend"'), false);
});

test('teacher offers inherit the student default, allow one-off mode, and retain all failed dates', async () => {
  const ui = await adminReady(); assert.equal(ui.el('f-delivery'), undefined, 'the offer form lives inside the day card now'); assert.doesNotMatch(ui.html(), /さんに授業を案内する/);
  ui.click('calday', { 'data-date': '2026-09-10' }); ui.click('sdayadd'); ui.click('dayoffer', { 'data-date': '2026-09-10' });
  assert.match(ui.html(), /手動で予定入力[^]*data-action="dayoffer" data-date="2026-09-10" aria-expanded="true">授業を案内<\/button>[^]*<h4[^>]*>【テスト】生徒Aさんに授業を案内する<\/h4>/); assert.equal(ui.el('f-delivery').value, 'online'); assert.equal(ui.el('f-date').value, '2026-09-10');
  ui.input('f-subject', '英語'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-10'); ui.input('f-start', '17:00'); ui.input('f-rep', '4'); ui.click('offerslot');
  const r = ui.requests.at(-1); assert.equal(r.body.deliveryMode, 'in_person'); assert.equal(r.body.repeat, 4);
  r.reply({ error: '定員超過のため案内できません', errorCode: 'capacity', conflicts: [{ date: '2026-09-17', start: '17:00', error: '対面定員' }, { date: '2026-10-01', start: '17:00', error: '全体定員' }] }); await flush();
  assert.match(ui.html(), /2026-09-17/); assert.match(ui.html(), /2026-10-01/); assert.equal(ui.el('f-delivery').value, 'in_person'); assert.equal(ui.el('f-rep').value, '4');
});

test('slot mode changes carry the old mode and target only that student and slot', async () => {
  const s = slot('slot-a', { status: 'booked', studentId: 'test-a', done: false }); const ui = await adminReady(card({ lessons: [s] }));
  ui.click('slotmode', { 'data-id': 'slot-a' }); ui.input('se-mode', 'online'); ui.click('se-save');
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'setSlotDeliveryMode'); assert.equal(b.studentId, 'test-a'); assert.equal(b.slotId, 'slot-a'); assert.equal(b.expectedMode, 'in_person'); assert.equal(b.deliveryMode, 'online');
});

test('select all limits the batch to 31 and a single confirmation uses the same resumable API', async () => {
  const ui = await studentReady(state(Array.from({ length: 32 }, (_, i) => slot('slot-' + i))));
  ui.click('batchreview'); assert.equal(ui.requests.length, 1);
  ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); assert.equal(ui.requests.at(-1).body.slotIds.length, 31);
  const single = await studentReady(); single.click('askaccept', { 'data-id': 'slot-a' }); single.click('doaccept');
  assert.equal(single.requests.at(-1).body.action, 'acceptMany'); assert.deepEqual(single.requests.at(-1).body.slotIds, ['slot-a']);
  single.requests.at(-1).fail(); await flush(); assert.match(single.html(), /同じ処理を再試行/);
});

test('changing a student default does not send slot fields and adopts a refreshed card with a visible notification warning', async () => {
  const original = slot('slot-a', { status: 'booked', studentId: 'test-a' }); const ui = await adminReady(card({ lessons: [original] }), 'settings');
  ui.change('student-delivery', 'in_person'); ui.click('studentmode');
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'setDeliveryMode'); assert.equal(b.deliveryMode, 'in_person'); assert.equal(b.slotId, undefined);
  ui.requests.at(-1).reply({ ok: true, data: card({ deliveryMode: 'in_person', lessons: [original] }), notificationWarning: '保存は完了しましたが通知を確認してください' }); await flush();
  assert.equal(ui.el('student-delivery').value, 'in_person'); assert.match(ui.html(), /role="alert".*通知を確認/);
  ui.navigate('#s=test-a'); ui.requests.at(-1).reply({data:card({section:'overview',deliveryMode:'in_person',lessons:[original]})}); await flush();
  ui.click('slotmode', { 'data-id': 'slot-a' }); assert.equal(ui.el('se-mode').value, 'in_person');
});

test('unfinished batch payload survives reload and lock-timeout responses without changing request ID', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const payload = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({ error: '他の処理を確認中です', errorCode: 'pending' }); await flush();
  assert.equal(ui.beforeUnload(), true); assert.ok(ui.session.has('sw_accept_v1:test-link-a'));
  const reloaded = createUI('student', { session: ui.session }); reloaded.requests[0].reply(state()); await flush();
  assert.match(reloaded.html(), /前回の確定処理/); reloaded.click('batchsend'); assert.deepEqual(reloaded.requests.at(-1).body, payload);
  reloaded.requests.at(-1).reply({ ok: true, pending: false, results: [], state: state([]) }); await flush();
  assert.equal(reloaded.session.has('sw_accept_v1:test-link-a'), false);
});

test('server pending recovery overrides stale local state and shows snapshots even when no offers remain', async () => {
  const session = new Map([['sw_accept_v1:test-link-a', JSON.stringify({ requestId: 'stale-request', slotIds: ['stale-slot'], slots: [slot('stale-slot')] })]]);
  const ui = createUI('student', { session }); const slots = [slot('slot-a'), slot('slot-b')];
  ui.requests[0].reply({ ...state(slots.map(s => ({ ...s, st: 'mine' }))), pendingAccepts: [{ requestId: 'server-pending-request', slotIds: ['slot-a', 'slot-b'], slots }] }); await flush();
  assert.match(ui.html(), /次の2件を確定/); assert.match(ui.html(), /17:00/); assert.match(ui.html(), /18:00/); assert.match(ui.html(), /未完了の確定処理/);
  ui.click('batchsend'); assert.equal(ui.requests.at(-1).body.requestId, 'server-pending-request'); assert.deepEqual(ui.requests.at(-1).body.slotIds, ['slot-a', 'slot-b']);
});

test('calendar overlap chains keep all four lessons without claiming four people or fixed concurrency', async () => {
  const slots = ['17:00', '17:30', '18:30', '19:00'].map((start, i) => slot('chain-' + i, { start, min: 90, status: 'booked', studentId: i % 2 ? 'test-b' : 'test-a', studentName: i % 2 ? '【テスト】B' : '【テスト】A' }));
  const ui = createUI('admin', { hash: '#home' });
  ui.requests[0].reply({ data: { today: '2026-09-08', slots, lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], students: [], meetings: [] } }); await flush();
  assert.equal((ui.html().match(/class="cgrp"/g) || []).length, 1);
  assert.match(ui.html(), /title="時間が重なる授業"/);
  for (const start of ['17:00', '17:30', '18:30', '19:00']) assert.ok(ui.html().includes('title="' + start + '〜'), 'calendar retains ' + start);
  assert.equal(ui.html().includes('同じ時間帯の授業(4人)'), false);
  assert.equal(ui.html().includes('2人同時'), false);
});
test('selected calendar day exposes add button and carries date into student offer',async()=>{
 const ui=await adminReady();ui.click('calday',{'data-date':'2026-09-15'});assert.match(ui.html(),/data-action="sdayadd" aria-label="9\/15\(火\)の予定を追加"/);ui.click('sdayadd');assert.equal(ui.el('f-date'),undefined);ui.click('dayoffer',{'data-date':'2026-09-15'});assert.equal(ui.el('f-date').value,'2026-09-15');ui.click('dayoffer',{'data-date':'2026-09-15'});assert.equal(ui.el('f-date'),undefined);assert.equal(ui.requests.length,1);
});
test('home calendar preserves past selection and shows its lessons without add action',async()=>{
 const ui=createUI('admin',{hash:'#home'});ui.requests[0].reply({data:{today:'2026-09-08',slots:[{id:'old',date:'2026-09-05',start:'13:00',min:60,status:'booked',studentId:'test-a',studentName:'【テスト】過去授業',subject:'英語'}],lessonsToday:[],lessonsWeek:[],pending:[],unpaid:[],students:[],meetings:[]}});await flush();ui.click('calday',{'data-date':'2026-09-05'});assert.match(ui.html(),/9\/5\(土\)の予定/);assert.match(ui.html(),/【テスト】過去授業/);assert.doesNotMatch(ui.html(),/data-action="calendar-add"/);
});

test('the admin student page draws the same calendar as the student mypage (boxes, hatched days, legend)', async () => {
  const c = card({ lessons: [{ id: 'l1', date: '2026-09-15', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語', kind: '演習' }, { id: 'l2', date: '2026-09-16', start: '18:00', min: 60, status: 'offered', done: false, subject: '数学', kind: '' }], blocked: [{ id: 'b1', date: '2026-09-17', start: '', end: '', note: '' }], teacherOff: [{ id: 't1', date: '2026-09-18', note: '' }], wishes: [{ id: 'w1', date: '2026-09-19', start: '16:00', end: '18:00' }], events: [{ id: 'e1', date: '2026-09-20', dateTo: '2026-09-21', title: '中間テスト', kind: 'test' }] });
  const ui = await adminReady(c, 'overview');
  assert.match(ui.html(), /<h2>【テスト】生徒A<\/h2>|さんの予定表<\/h2>/);
  assert.match(ui.html(), /data-date="2026-09-15">15<span class="calmarks"><\/span><span class="calbox"><span class="t">17:00-<wbr>18:30<\/span><span class="s">英語（演習）<\/span><\/span>/);
  assert.match(ui.html(), /data-date="2026-09-16">16<span class="calmarks"><\/span><span class="calbox of"><span class="t">18:00-<wbr>19:00<\/span><span class="s">数学<\/span>/);
  assert.match(ui.html(), /class="calday ngday" data-action="calday" data-date="2026-09-17">17<span class="calmarks"><\/span><span class="callbl to"[^>]*>授業不可<\/span>/);
  assert.match(ui.html(), /class="calday toff" data-action="calday" data-date="2026-09-18">18<span class="calmarks"><\/span><span class="callbl to"[^>]*>登録不可<\/span>/);
  assert.match(ui.html(), /data-date="2026-09-19">19<span class="calmarks"><\/span><span class="callbl wi">授業可<\/span>/);
  assert.match(ui.html(), /data-date="2026-09-20">20<span class="calmarks"><\/span><span class="calbox ev">中間テスト<\/span>/); assert.match(ui.html(), /data-date="2026-09-21">21<span class="calmarks"><\/span><span class="calbox ev">中間テスト<\/span>/);
  assert.match(ui.html(), /<div class="callegend"><span><span class="callbl" style="display:inline">授業<\/span><\/span>[^]*登録不可<\/span> 先生の休み/);
  assert.doesNotMatch(ui.html(), /class="caldot|class="cbox/);
});

test('the admin day card mirrors the student 予定の編集 card with teacher actions', async () => {
  const c = card({ lessons: [{ id: 'l1', date: '2026-09-15', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語', kind: '演習', meetUrl: 'https://meet.example.invalid/x' }, { id: 'l2', date: '2026-09-15', start: '19:00', min: 60, status: 'offered', done: false, subject: '数学', kind: '' }, { id: 'l3', date: '2026-09-15', start: '15:00', min: 60, status: 'booked', done: true, subject: '国語', kind: '' }], blocked: [{ id: 'b1', date: '2026-09-15', start: '', end: '', note: '部活' }], teacherOff: [{ id: 't1', date: '2026-09-15', start: '09:00', end: '12:00', note: '' }], wishes: [{ id: 'w1', date: '2026-09-15', start: '16:00', end: '18:00', kind: 'ok', deliveryMode: 'online', duration: 90 }], events: [{ id: 'e1', date: '2026-09-15', dateTo: '2026-09-15', title: '中間テスト', kind: 'test' }] });
  const ui = await adminReady(c, 'overview'); ui.click('calday', { 'data-date': '2026-09-15' });
  assert.match(ui.html(), /<h2>予定の編集<\/h2><div class="card"[^>]*><div class="row"[^>]*><h3[^>]*>9月15日（火）の予定<\/h3><button class="btn-primary"[^>]*data-action="sdayadd" aria-label="9\/15\(火\)の予定を追加" aria-expanded="false">＋<\/button><\/div><div class="daylist">/);
  assert.match(ui.html(), /<div class="slotline"><span class="tag gray">登録不可<\/span><span class="time">09:00〜12:00<\/span>/);
  assert.match(ui.html(), /<span class="tag coral">重要な予定<\/span><span class="time"><\/span><span class="who">中間テスト<\/span><button class="btn-quiet btn-sm" data-action="delevent" data-id="e1">削除<\/button>/);
  assert.match(ui.html(), /<span class="tag gray">実施済<\/span><span class="time">15:00〜16:00<\/span><span class="who">国語<\/span><button class="btn-quiet btn-sm" data-action="toggledone" data-id="l3" data-done="0">未実施に戻す<\/button><a class="btn-quiet btn-sm"[^>]*>記録<\/a>/);
  assert.match(ui.html(), /<span class="tag green">確定<\/span><span class="time">17:00〜18:30<\/span><span class="who">英語（演習）<\/span><a class="btn-ghost btn-sm"[^>]*>Meet<\/a><button class="btn-quiet btn-sm" data-action="toggledone" data-id="l1" data-done="1">実施済にする<\/button><button class="btn-quiet btn-sm" data-action="unbook" data-id="l1"/);
  assert.match(ui.html(), /<span class="tag amber">案内<\/span><span class="time">19:00〜20:00<\/span><span class="who">数学<\/span><button class="btn-quiet btn-sm" data-action="delslot" data-id="l2" data-sid="test-a">取り下げ<\/button>/);
  assert.match(ui.html(), /<span class="tag gray">授業不可<\/span><span class="time">終日<\/span><span class="who">部活<\/span><button class="btn-quiet btn-sm" data-action="sdelblock" data-id="b1">解除<\/button>/);
  assert.match(ui.html(), /<span class="tag green">授業可<\/span><span class="time">16:00〜18:00<\/span><span class="who"><span class="tag green">この時間帯のどこかで<\/span>[^]*?data-action="usewish"[^>]*>この希望で案内<\/button><button class="btn-quiet btn-sm" data-action="delwish" data-id="w1"/);
  assert.doesNotMatch(ui.html(), /手動で予定入力/);
  ui.click('sdayadd'); assert.match(ui.html(), /<h3[^>]*>手動で予定入力<\/h3><div class="row"[^>]*><button class="btn-quiet btn-sm" data-action="dayoffer" data-date="2026-09-15" aria-expanded="false">授業を案内<\/button><button class="btn-quiet btn-sm" data-action="sblockopen"[^>]*>授業不可を登録<\/button>/);
  ui.click('sblockopen'); ui.input('sb-start', '16:00'); ui.input('sb-end', '18:00'); ui.input('sb-note', '塾の面談'); ui.click('sblockadd');
  const r = ui.requests.at(-1).body; assert.equal(r.op, 'addBlock'); assert.equal(r.studentId, 'test-a'); assert.equal(r.date, '2026-09-15'); assert.equal(r.dateTo, '2026-09-15'); assert.equal(r.start, '16:00'); assert.equal(r.end, '18:00'); assert.equal(r.note, '塾の面談');
  ui.requests.at(-1).reply({ ok: true, admin: { today: '2026-09-08', students: [], slots: [], blocked: [], teacherOff: [], wishes: [], events: [], plans: [], log: [] } }); await flush();
  const reload = ui.requests.at(-1); if (reload.body.op === 'kanriStudent') { reload.reply({ ok: true, data: c }); await flush(); }
  ui.click('sdelblock', { 'data-id': 'b1' }); assert.equal(ui.requests.at(-1).body.op, 'delBlock'); assert.equal(ui.requests.at(-1).body.blockId, 'b1');
});

test('the admin day card offers 文章で自動入力: parse through scheduleParseTeacher, edit the proposal, register through nlApplyTeacher', async () => {
  const ui = await adminReady(card({ nlEnabled: true, deliveryMode: 'online' }), 'overview');
  ui.click('calday', { 'data-date': '2026-09-15' }); ui.click('sdayadd');
  assert.match(ui.html(), /<h3[^>]*>文章で自動入力<\/h3>/);
  ui.input('tnl-text', '来週水曜17時から90分英語の演習。20日は部活で休み。25日は中間テスト'); ui.click('tnl-parse');
  let r = ui.requests.at(-1).body; assert.equal(r.op, 'scheduleParseTeacher'); assert.equal(r.studentId, 'test-a'); assert.match(r.text, /英語の演習/); assert.deepEqual(r.subjects.slice(0, 2), ['英語', '数学']);
  ui.requests.at(-1).reply({ ok: true, items: [
    { kind: 'offer', dates: ['2026-09-16'], start: '17:00', min: 90, subject: '英語', lessonKind: '演習', needsTime: false, confidence: 'high', note: '' },
    { kind: 'offer', dates: ['2026-09-17'], start: '', min: 0, subject: '', lessonKind: '', needsTime: true, confidence: 'low', note: '' },
    { kind: 'block', dates: ['2026-09-20'], start: '', end: '', note: '部活', confidence: 'high' },
    { kind: 'event', dates: ['2026-09-25'], title: '中間テスト', test: true, alsoBlock: false, start: '', end: '', note: '', confidence: 'high' }
  ], questions: ['木曜の時刻は？'], summary: '案内2件、授業不可1件、予定1件です。' }); await flush();
  assert.match(ui.html(), /案内2件、授業不可1件、予定1件です。/); assert.match(ui.html(), /<strong>授業を案内<\/strong><br>9\/16\(水\)<br><input type="time" id="tnl-start-0" value="17:00"/); assert.match(ui.html(), /開始時刻を入れてください/); assert.match(ui.html(), /<strong>予定の共有：中間テスト（テスト・模試）<\/strong>/); assert.match(ui.html(), /<li>木曜の時刻は？<\/li>/);
  ui.click('tnl-item', { 'data-i': '1' }); ui.click('tnl-register');
  r = ui.requests.at(-1).body; assert.equal(r.op, 'nlApplyTeacher'); assert.equal(r.studentId, 'test-a'); assert.equal(r.deliveryMode, 'online');
  assert.deepEqual(r.items, [{ kind: 'offer', dates: ['2026-09-16'], start: '17:00', min: 90, subject: '英語', lessonKind: '演習' }, { kind: 'block', dates: ['2026-09-20'], start: '', end: '', note: '部活' }, { kind: 'event', dates: ['2026-09-25'], title: '中間テスト', test: true, alsoBlock: false }]);
  ui.requests.at(-1).reply({ ok: true, id: 'test-a', data: card({ nlEnabled: true }), added: 3, results: [{ i: 0, kind: 'offer', status: 'added', count: 1, errors: [] }, { i: 1, kind: 'block', status: 'added', count: 1, errors: [] }, { i: 2, kind: 'event', status: 'added', count: 1, errors: [] }] }); await flush();
  assert.match(ui.el('toast').textContent, /3件を登録しました/);
  // everything registered → the proposal is cleared, like the student page
  assert.doesNotMatch(ui.html(), /data-action="tnl-register"|登録済み/); assert.equal(ui.el('tnl-text').value, '');
});

test('今後の予定 and 授業履歴 on the student page are collapsible folds (upcoming open, history closed by default)', async () => {
  const ui = await adminReady(card({ lessons: [{ id: 'p1', date: '2026-09-01', start: '17:00', min: 90, status: 'booked', done: true, subject: '英語' }, { id: 'u1', date: '2026-09-20', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語' }] }), 'overview');
  assert.match(ui.html(), /<details class="fold " data-fold="upcoming" open><summary><h2><span class="mk" aria-hidden="true"><\/span>今後の予定 <span class="cnt">1件<\/span><\/h2><\/summary><div class="card">/);
  assert.match(ui.html(), /<details class="fold " data-fold="history"><summary><h2><span class="mk" aria-hidden="true"><\/span>授業履歴 <span class="cnt">直近1件<\/span><\/h2><\/summary><div class="card">[^]*?<\/div><\/details>/);
});
