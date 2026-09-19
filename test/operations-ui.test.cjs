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
  assert.match(ui.html(), /<h2>予定表<\/h2>/); assert.equal(ui.html().includes('古いAの応答'), false); assert.equal(ui.html().includes('data-action="batchsend"'), false, 'the old batch state is gone after the switch');
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

test('an offer beyond the plan shows the plan prompt in the form: cancel, or send a prefilled plan line and then the offer with planForce', async () => {
  const ui = await adminReady();
  ui.click('calday', { 'data-date': '2026-09-10' }); ui.click('sdayadd'); ui.click('dayoffer', { 'data-date': '2026-09-10' });
  ui.input('f-subject', '英語'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-10'); ui.input('f-start', '17:00'); ui.input('f-rep', '2'); ui.click('offerslot');
  const first = ui.requests.at(-1); assert.equal(first.body.op, 'offer'); assert.equal(first.body.planForce, false);
  const suggest = { studentId: 'test-a', subject: '英語', kind: '通常', count: 2, dates: ['2026-09-10', '2026-09-17'], startDate: '2026-09-01', endDate: '2026-09-30', lessonMin: 90, lessonFee: 4500, parentId: '', parentLabel: '' };
  first.reply({ error: '授業計画の上限を超えています（2件）。', errorCode: 'planShort', needPlan: true, planSuggest: suggest }); await flush();
  assert.match(ui.html(), /<strong>授業計画の上限を超えていますが案内しますか？<\/strong>/); assert.match(ui.html(), /英語（通常） 2026\/9\/10、2026\/9\/17 の 2件が/);
  assert.doesNotMatch(ui.html(), /data-action="offerslot"/, 'the send button gives way to the prompt'); assert.equal(ui.el('pp-start'), undefined, 'the plan form opens only after the teacher chooses to send a plan');
  // cancel closes the prompt and brings the button back with the draft intact
  ui.click('pp-cancel'); assert.match(ui.html(), /data-action="offerslot"/); assert.equal(ui.el('f-rep').value, '2'); assert.equal(ui.el('f-subject').value, '英語');
  ui.click('offerslot'); ui.requests.at(-1).reply({ error: 'x', errorCode: 'planShort', needPlan: true, planSuggest: suggest }); await flush();
  ui.click('pp-open');
  assert.equal(ui.el('pp-start').value, '2026-09-01'); assert.equal(ui.el('pp-end').value, '2026-09-30'); assert.equal(ui.el('pp-count').value, '2'); assert.equal(ui.el('pp-min').value, '90'); assert.equal(ui.el('pp-fee').value, '4500');
  ui.input('pp-count', '4'); ui.input('pp-comment', '10月の定期テストまで週2回に増やすため'); ui.click('pp-send');
  const plan = ui.requests.at(-1); assert.equal(plan.body.op, 'planLineSave'); assert.equal(plan.body.studentId, 'test-a'); assert.equal(plan.body.propose, true); assert.equal(plan.body.parentId, '');
  assert.deepEqual([plan.body.subject, plan.body.kind, plan.body.count, plan.body.startDate, plan.body.endDate, plan.body.lessonMin, plan.body.lessonFee, plan.body.comment], ['英語', '通常', 4, '2026-09-01', '2026-09-30', 90, 4500, '10月の定期テストまで週2回に増やすため']);
  plan.reply({ ok: true, line: { id: 'ln1' }, data: card() }); await flush();
  const again = ui.requests.at(-1); assert.equal(again.body.op, 'offer'); assert.equal(again.body.planForce, true); assert.equal(again.body.repeat, 2); assert.equal(again.body.subject, '英語');
  assert.match(ui.el('toast').textContent, /授業計画の案内を送りました/);
  again.reply({ ok: true, added: 2, data: card() }); await flush();
  assert.doesNotMatch(ui.html(), /授業計画の上限を超えていますが/);
  // an addon suggestion sends the parent id and says so (the form stays open after a sent offer)
  ui.input('f-subject', '数学'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-24'); ui.input('f-start', '17:00'); ui.click('offerslot');
  ui.requests.at(-1).reply({ error: 'x', errorCode: 'planShort', needPlan: true, planSuggest: { ...suggest, subject: '数学', count: 1, dates: ['2026-09-24'], parentId: 'parent-1', parentLabel: '2026年9月 数学 4回' } }); await flush();
  ui.click('pp-open'); assert.match(ui.html(), /2026年9月 数学 4回 への追加案内として送ります/); ui.click('pp-send');
  assert.equal(ui.requests.at(-1).body.parentId, 'parent-1'); assert.equal(ui.requests.at(-1).body.count, 1);
  ui.requests.at(-1).reply({ error: '追加案内の期間は元の案内の期間の中にしてください' }); await flush();
  assert.match(ui.html(), /追加案内の期間は元の案内の期間の中にしてください/); assert.ok(ui.el('pp-start'), 'the plan form stays open after a server error');
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

test('the home calendar is the shared component: one box per lesson with time, family name and subject initial, teacher off as 休み, wishes and events named', async () => {
  const slots = ['17:00', '17:30', '18:30', '19:00'].map((start, i) => slot('chain-' + i, { date: '2026-09-15', start, min: 90, status: 'booked', studentId: i % 2 ? 'test-b' : 'test-a', studentName: i % 2 ? '【テスト】B' : '【テスト】山田 太郎', subject: i % 2 ? '数学' : '英語', req: i === 2 ? '{"kind":"cancel"}' : '' }));
  slots.push(slot('of-1', { date: '2026-09-16', start: '16:00', min: 60, status: 'offered', studentId: 'test-a', studentName: '【テスト】山田 太郎', subject: '英語' }));
  const ui = createUI('admin', { hash: '#home' });
  ui.requests[0].reply({ data: { today: '2026-09-08', slots, lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], students: [], meetings: [], teacherOff: [{ id: 'o1', date: '2026-09-20', start: '', end: '', note: '' }], wishes: [{ id: 'w1', studentId: 'test-b', studentName: '【テスト】B', date: '2026-09-18', start: '16:00', end: '18:00', kind: 'range' }], allEvents: [{ id: 'e1', studentId: 'test-a', studentName: '【テスト】山田 太郎', date: '2026-09-25', dateTo: '2026-09-25', title: '中間テスト', kind: 'test' }] } }); await flush();
  const html = ui.html();
  assert.doesNotMatch(html, /class="cgrp"|class="cbox|class="caldot|calday boxed/, 'the old home renderer is gone');
  assert.match(html, /<button class="calday[^"]*" data-action="calday" data-date="2026-09-15">15<span class="calmarks"><\/span><span class="calbox"><span class="t">17:00-<wbr>18:30<\/span><span class="s">山田 英<\/span><\/span><span class="calbox"><span class="t">17:30-<wbr>19:00<\/span><span class="s">B 数<\/span><\/span><span class="calbox rq"><span class="t">18:30-<wbr>20:00<\/span><span class="s">山田 英（取消依頼）<\/span><\/span>/);
  assert.match(html, /data-date="2026-09-16">16<span class="calmarks"><\/span><span class="calbox of"><span class="t">16:00-<wbr>17:00<\/span><span class="s">山田 英<\/span>/);
  assert.match(html, /data-date="2026-09-18">18<span class="calmarks"><\/span><span class="calbox wi">希 B 16-18<\/span>/);
  assert.match(html, /class="calday[^"]*toff[^"]*" data-action="calday" data-date="2026-09-20">20<span class="calmarks"><\/span><span class="callbl to"[^>]*>休み<\/span>/);
  assert.match(html, /data-date="2026-09-25">25<span class="calmarks"><\/span><span class="calbox ev">山田 中間テスト<\/span>/);
  assert.match(html, /<div class="callegend">[^]*<span class="callbl to toffswatch"[^>]*>休み<\/span> 先生の休み<\/span><span><span class="callbl rq"[^>]*>取消依頼<\/span> 生徒から取消の依頼あり<\/span><\/div>/);
  assert.doesNotMatch(html, /登録不可/);
});
test('selected calendar day exposes add button and carries date into student offer',async()=>{
 const ui=await adminReady();ui.click('calday',{'data-date':'2026-09-15'});assert.match(ui.html(),/data-action="sdayadd" aria-label="9\/15\(火\)の予定を追加"/);ui.click('sdayadd');assert.equal(ui.el('f-date'),undefined);ui.click('dayoffer',{'data-date':'2026-09-15'});assert.equal(ui.el('f-date').value,'2026-09-15');ui.click('dayoffer',{'data-date':'2026-09-15'});assert.equal(ui.el('f-date'),undefined);assert.equal(ui.requests.length,1);
});
test('home calendar preserves past selection and shows its lessons in the 予定の編集 card without an add button',async()=>{
 const ui=createUI('admin',{hash:'#home'});ui.requests[0].reply({data:{today:'2026-09-08',slots:[{id:'old',date:'2026-09-05',start:'13:00',min:60,status:'booked',studentId:'test-a',studentName:'【テスト】過去授業',subject:'英語'}],lessonsToday:[],lessonsWeek:[],pending:[],unpaid:[],students:[],meetings:[]}});await flush();ui.click('calday',{'data-date':'2026-09-05'});
 assert.match(ui.html(),/<h2>予定の編集<\/h2><div class="card"[^>]*><div class="row"[^>]*><h3[^>]*>9月5日（土）の予定<\/h3><\/div>/);assert.match(ui.html(),/【テスト】過去授業/);assert.doesNotMatch(ui.html(),/data-action="calendar-add"|data-action="sdayadd"/);
});

test('the home 予定の編集 card mirrors the student page: named rows with teacher actions, ＋ opens 授業を案内 (student select) and 先生の休みを登録', async () => {
  const ui = createUI('admin', { hash: '#home' });
  ui.requests[0].reply({ data: { today: '2026-09-08', students: [{ id: 'test-a', name: '【テスト】生徒A', active: true, deliveryMode: 'online' }, { id: 'test-b', name: '【テスト】生徒B', active: true }],
    slots: [{ id: 'bk', date: '2026-09-15', start: '17:00', min: 60, status: 'booked', studentId: 'test-a', studentName: '【テスト】生徒A', subject: '英語', meetUrl: 'https://meet.example.invalid/x' }, { id: 'of', date: '2026-09-15', start: '18:00', min: 60, status: 'offered', studentId: 'test-b', studentName: '【テスト】生徒B', subject: '数学' }, { id: 'dn', date: '2026-09-15', start: '15:00', min: 60, status: 'booked', done: true, studentId: 'test-b', studentName: '【テスト】生徒B', subject: '数学' }],
    teacherOff: [{ id: 'o1', date: '2026-09-15', start: '12:00', end: '13:00', note: '通院' }], blocked: [{ id: 'b1', studentId: 'test-a', studentName: '【テスト】生徒A', date: '2026-09-15', start: '', end: '', note: '部活' }],
    wishes: [{ id: 'w1', studentId: 'test-b', studentName: '【テスト】生徒B', date: '2026-09-15', start: '19:00', end: '21:00', kind: 'range' }], allEvents: [{ id: 'e1', studentId: 'test-a', studentName: '【テスト】生徒A', date: '2026-09-15', dateTo: '2026-09-15', title: '中間テスト', kind: 'test' }],
    lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], meetings: [] } }); await flush();
  ui.click('calday', { 'data-date': '2026-09-15' });
  const html = ui.html();
  assert.match(html, /<h3[^>]*>9月15日（火）の予定<\/h3><button class="btn-primary"[^>]*data-action="sdayadd"[^>]*>＋<\/button><\/div><div class="daylist">/);
  assert.match(html, /<span class="tag gray">先生の休み<\/span><span class="time">12:00〜13:00<\/span><span class="who"><span class="small muted">通院<\/span><\/span><span class="acts"><button class="btn-quiet btn-sm" data-action="tdeloff" data-ids="o1">削除<\/button>/);
  assert.match(html, /<span class="tag coral">重要な予定<\/span>[^]*?<a class="nm" href="#s=test-a"[^>]*><strong>【テスト】生徒A<\/strong><\/a> 中間テスト[^]*?data-action="delevent" data-id="e1" data-sid="test-a"/);
  assert.match(html, /<span class="tag gray">実施済<\/span><a class="lesson-link" href="#lesson\?student=test-b&amp;slot=dn"[^>]*><span class="time">15:00〜16:00<\/span><span class="who"><a class="nm" href="#s=test-b"[^>]*><strong>【テスト】生徒B<\/strong><\/a> 数学<\/span><\/a><span class="acts"><button class="btn-quiet btn-sm" data-action="toggledone" data-id="dn" data-done="0" data-sid="test-b">未実施に戻す<\/button>/);
  assert.match(html, /<span class="tag green">確定<\/span><a class="lesson-link" href="#lesson\?student=test-a&amp;slot=bk"[^>]*><span class="time">17:00〜18:00<\/span>[^]*?<span class="acts"><a class="btn-ghost btn-sm"[^>]*>Meet<\/a><button class="btn-quiet btn-sm" data-action="toggledone" data-id="bk" data-done="1" data-sid="test-a">実施済にする<\/button><button class="btn-quiet btn-sm" data-action="unbook" data-id="bk" data-name="【テスト】生徒A" data-when="9\/15\(火\) 17:00" data-sid="test-a">解除<\/button>/);
  assert.match(html, /<span class="tag amber">案内<\/span><span class="time">18:00〜19:00<\/span>[^]*?data-action="delslot" data-id="of" data-sid="test-b">取り下げ<\/button>/);
  assert.match(html, /<span class="tag gray">授業不可<\/span><span class="time">終日<\/span><span class="who"><a class="nm" href="#s=test-a"[^>]*><strong>【テスト】生徒A<\/strong><\/a> 部活<\/span><span class="acts"><button class="btn-quiet btn-sm" data-action="sdelblock" data-id="b1" data-sid="test-a">解除<\/button>/);
  assert.match(html, /<span class="tag green">授業可<\/span><span class="time">19:00〜21:00<\/span>[^]*?data-action="usewish"[^>]*data-sid="test-b"[^>]*>この希望で案内<\/button><button class="btn-quiet btn-sm" data-action="delwish" data-id="w1" data-sid="test-b">削除<\/button>/);
  const cardHtml = html.slice(html.indexOf('<h2>予定の編集</h2>'), html.indexOf('<div class="head">')); assert.doesNotMatch(cardHtml, /class="line"|授業ページで案内|data-action="calendar-add"/, 'the old home lists are gone from the card');
  // ＋ → 授業を案内 (student select, prefilled date) / 先生の休みを登録 (inline form)
  ui.click('sdayadd'); assert.match(ui.html(), /<h3[^>]*>手動で予定入力<\/h3><div class="row"[^>]*><button class="btn-quiet btn-sm" data-action="dayoffer" data-date="2026-09-15" aria-expanded="false">授業を案内<\/button><button class="btn-quiet btn-sm" data-action="homeoff" data-date="2026-09-15" aria-expanded="false">先生の休みを登録<\/button><\/div>/);
  ui.click('dayoffer', { 'data-date': '2026-09-15' }); assert.match(ui.html(), /<h4[^>]*>授業を案内する<\/h4>/); assert.ok(ui.el('f-student'), 'the home form lets the teacher pick the student'); assert.equal(ui.el('f-date').value, '2026-09-15'); assert.match(ui.html(), /<option value="test-b">【テスト】生徒B<\/option>/);
  ui.click('homeoff', { 'data-date': '2026-09-15' }); assert.ok(ui.el('ho-start')); assert.equal(ui.el('f-student'), undefined, 'the two manual forms are exclusive'); assert.match(ui.html(), /data-action="homeoff" data-date="2026-09-15" aria-expanded="true"/);
  ui.input('ho-note', '学会'); ui.click('homeoffsave', { 'data-date': '2026-09-15' });
  const req = ui.requests.at(-1).body; assert.equal(req.op, 'addOff'); assert.equal(req.date, '2026-09-15'); assert.equal(req.note, '学会'); assert.equal(req.start, '');
  // teacher actions send the student id taken from the row, not from a student page
  ui.requests.at(-1).reply({ ok: true, dash: { today: '2026-09-08', students: [], slots: [{ id: 'bk', date: '2026-09-15', start: '17:00', min: 60, status: 'booked', studentId: 'test-a', studentName: '【テスト】生徒A', subject: '英語' }], teacherOff: [], lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], meetings: [] } }); await flush();
  ui.click('toggledone', { 'data-id': 'bk' }); const td = ui.requests.at(-1).body; assert.equal(td.op, 'toggleDone'); assert.equal(td.slotId, 'bk'); assert.equal(td.studentId, 'test-a'); assert.equal(td.done, true);
});

test('past months stay reachable for a year and past days keep their lessons and 授業不可 marks', async () => {
  const c = card({ lessons: [{ id: 'old', date: '2026-04-10', start: '17:00', min: 60, status: 'booked', done: true, subject: '英語', kind: '' }], blocked: [{ id: 'b0', date: '2026-04-11', start: '', end: '', note: '' }], teacherOff: [{ id: 't0', date: '2026-04-12', start: '12:00', end: '13:00', note: '' }], wishes: [{ id: 'w0', date: '2026-04-13', start: '16:00', end: '18:00', kind: 'range' }] });
  const ui = await adminReady(c, 'overview');
  for (let i = 0; i < 5; i++) { assert.doesNotMatch(ui.html(), /data-action="calprev" disabled/); ui.click('calprev'); }
  const html = ui.html();
  assert.match(html, /<span class="callabel">2026年4月<\/span>/);
  assert.match(html, /<button class="calday" data-action="calday" data-date="2026-04-10">10<span class="calmarks"><\/span><span class="calbox"><span class="t">17:00-<wbr>18:00<\/span><span class="s">英語<\/span><\/span><\/button>/, 'a past lesson is a box on a clickable day');
  assert.match(html, /<button class="calday sat ngday" data-action="calday" data-date="2026-04-11">11<span class="calmarks"><\/span><span class="callbl to"[^>]*>授業不可<\/span><\/button>/, 'past 授業不可 stays visible');
  assert.match(html, /<button class="calday sun" data-action="calday" data-date="2026-04-12">12<span class="calmarks"><\/span><span class="callbl to"[^>]*>登録不可12-13<\/span><\/button>/, 'past teacher off stays visible');
  assert.match(html, /<span class="calday off" data-date="2026-04-13">13<span class="calmarks"><\/span><\/span>|<span class="calday off">13<span class="calmarks"><\/span><\/span>/, 'an expired 授業可 request is not shown and the empty past day is faded');
  ui.click('calday', { 'data-date': '2026-04-10' }); assert.match(ui.html(), /4月10日（金）の予定/); assert.match(ui.html(), /<span class="tag gray">実施済<\/span>/);
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
  assert.match(ui.html(), /<span class="tag coral">重要な予定<\/span><span class="time"><\/span><span class="who">中間テスト<\/span><span class="acts"><button class="btn-quiet btn-sm" data-action="delevent" data-id="e1">削除<\/button><\/span>/);
  assert.match(ui.html(), /<span class="tag gray">実施済<\/span><a class="lesson-link" href="#lesson\?student=test-a&amp;slot=l3"[^>]*><span class="time">15:00〜16:00<\/span><span class="who">国語<\/span><\/a><span class="acts"><button class="btn-quiet btn-sm" data-action="toggledone" data-id="l3" data-done="0">未実施に戻す<\/button><\/span><\/div>/); assert.match(ui.html(), /<div class="slotline tight"><span class="tag gray">実施済<\/span>/);
  assert.match(ui.html(), /<span class="tag green">確定<\/span><a class="lesson-link" href="#lesson\?student=test-a&amp;slot=l1"[^>]*><span class="time">17:00〜18:30<\/span><span class="who">英語（演習）<\/span><\/a><span class="acts"><a class="btn-ghost btn-sm"[^>]*>Meet<\/a><button class="btn-quiet btn-sm" data-action="toggledone" data-id="l1" data-done="1">実施済にする<\/button><button class="btn-quiet btn-sm" data-action="unbook" data-id="l1"/);
  assert.match(ui.html(), /<span class="tag amber">案内<\/span><span class="time">19:00〜20:00<\/span><span class="who">数学<\/span><span class="acts"><button class="btn-quiet btn-sm" data-action="delslot" data-id="l2" data-sid="test-a">取り下げ<\/button><\/span>/);
  assert.match(ui.html(), /<span class="tag gray">授業不可<\/span><span class="time">終日<\/span><span class="who">部活<\/span><span class="acts"><button class="btn-quiet btn-sm" data-action="sdelblock" data-id="b1">解除<\/button><\/span>/);
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
  assert.equal(r.planForce, false);
  // the plan prompt works here too: nothing was registered, so the same items are re-sent with planForce after the plan line goes out
  ui.requests.at(-1).reply({ error: '授業計画の上限を超えています（1件）。', errorCode: 'planShort', needPlan: true, planSuggest: { studentId: 'test-a', subject: '英語', kind: '演習', count: 1, dates: ['2026-09-16'], startDate: '2026-09-01', endDate: '2026-09-30', lessonMin: 90, lessonFee: 4500, parentId: '', parentLabel: '' } }); await flush();
  assert.match(ui.html(), /授業計画の上限を超えていますが案内しますか？/); assert.match(ui.html(), /英語（演習） 2026\/9\/16 の 1件が/);
  ui.click('pp-open'); ui.click('pp-send'); assert.equal(ui.requests.at(-1).body.op, 'planLineSave'); assert.equal(ui.requests.at(-1).body.kind, '演習');
  ui.requests.at(-1).reply({ ok: true, line: { id: 'ln-1' } }); await flush();
  r = ui.requests.at(-1).body; assert.equal(r.op, 'nlApplyTeacher'); assert.equal(r.planForce, true); assert.equal(r.items.length, 3);
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
