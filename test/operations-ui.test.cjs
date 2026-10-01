'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, slot, state, card, studentReady, adminReady, flush } = require('./helpers/operations-ui-harness.cjs');
// 授業の詳細ダイアログ(詳細 → 授業内容を編集)の欄は id を持たず data-slot-edit で識別される。ハーネスの ui.input は id で
// 要素を探すため、表示中で操作できる欄であることを確かめてから、同じ data-slot-edit を持つ入力イベントをダイアログ要素経由で送る。
function slotField(ui, prop, value) {
  const html = ui.html(), start = html.indexOf('<dialog id="slot-editor"'); assert.ok(start >= 0, 'visible dialog: slot-editor');
  const field = html.slice(start, html.indexOf('</dialog>', start)).match(new RegExp('<(?:input|select) [^>]*data-slot-edit="' + prop + '"[^>]*>'));
  assert.ok(field && !/ disabled/.test(field[0]), 'visible field: ' + prop);
  const dialog = ui.el('slot-editor'); dialog.attrs['data-slot-edit'] = prop; ui.input('slot-editor', value); delete dialog.attrs['data-slot-edit'];
}

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
  // 日付カードの＋は授業一覧と共通の案内モーダルを開き、表示中の生徒を選択済みにする(d046b20)
  ui.click('calday', { 'data-date': '2026-09-10' }); ui.click('sdayadd');
  assert.equal(ui.el('board-editor').modal, true); assert.match(ui.html(), /<th scope="row">生徒<\/th><td>【テスト】生徒A<input type="hidden" id="f-student" value="test-a"><\/td>/);
  assert.equal(ui.el('f-student').value, 'test-a'); assert.equal(ui.el('f-delivery').value, 'online'); assert.equal(ui.el('f-date').value, '2026-09-10');
  ui.input('f-subject', '英語'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-10'); ui.input('f-start', '17:00'); ui.input('f-rep', '4'); ui.click('offerslot');
  const r = ui.requests.at(-1); assert.equal(r.body.op, 'offer'); assert.equal(r.body.studentId, 'test-a'); assert.equal(r.body.deliveryMode, 'in_person'); assert.equal(r.body.repeat, 4);
  r.reply({ error: '定員超過のため案内できません', errorCode: 'capacity', conflicts: [{ date: '2026-09-17', start: '17:00', error: '対面定員' }, { date: '2026-10-01', start: '17:00', error: '全体定員' }] }); await flush();
  assert.match(ui.html(), /2026-09-17/); assert.match(ui.html(), /2026-10-01/); assert.equal(ui.el('f-delivery').value, 'in_person'); assert.equal(ui.el('f-rep').value, '4');
});

test('an offer beyond the plan shows the plan prompt in the form: cancel, or send a prefilled plan line and then the offer with planForce', async () => {
  const ui = await adminReady();
  ui.click('calday', { 'data-date': '2026-09-10' }); ui.click('sdayadd');
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
  // the shared offer modal closes after a sent offer (d046b20), so the next offer reopens it from ＋
  assert.equal(ui.el('board-editor'), undefined); assert.equal(ui.el('f-subject'), undefined);
  // an addon suggestion sends the parent id and says so
  ui.click('sdayadd'); ui.input('f-subject', '数学'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-24'); ui.input('f-start', '17:00'); ui.click('offerslot');
  ui.requests.at(-1).reply({ error: 'x', errorCode: 'planShort', needPlan: true, planSuggest: { ...suggest, subject: '数学', count: 1, dates: ['2026-09-24'], parentId: 'parent-1', parentLabel: '2026年9月 数学 4回' } }); await flush();
  ui.click('pp-open'); assert.match(ui.html(), /2026年9月 数学 4回 への追加案内として送ります/); ui.click('pp-send');
  assert.equal(ui.requests.at(-1).body.parentId, 'parent-1'); assert.equal(ui.requests.at(-1).body.count, 1);
  ui.requests.at(-1).reply({ error: '追加案内の期間は元の案内の期間の中にしてください' }); await flush();
  assert.match(ui.html(), /追加案内の期間は元の案内の期間の中にしてください/); assert.ok(ui.el('pp-start'), 'the plan form stays open after a server error');
});

test('slot mode changes carry the old mode and target only that student and slot', async () => {
  const s = slot('slot-a', { status: 'booked', studentId: 'test-a', done: false }); const ui = await adminReady(card({ lessons: [s] }));
  ui.click('calday',{'data-date':'2026-09-10'}); ui.click('slotedit', { 'data-id': 'slot-a' }); assert.equal(ui.confirms(),0);
  // 詳細はまず表で開き、「授業内容を編集」で同じ表の中の欄を直す(24e19b1)
  assert.equal(ui.el('slot-editor').modal, true); ui.click('se-content'); slotField(ui, 'deliveryMode', 'online'); ui.click('se-detail-save'); assert.equal(ui.requests.length, 2);
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'editBooked'); assert.equal(b.studentId, 'test-a'); assert.equal(b.slotId, 'slot-a'); assert.equal(b.expectedSnapshot.deliveryMode, 'in_person'); assert.equal(b.deliveryMode, 'online');
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
  ui.click('calday',{'data-date':'2026-09-10'}); ui.click('slotedit', { 'data-id': 'slot-a' }); ui.click('se-content'); slotField(ui, 'deliveryMode', 'online'); ui.click('se-detail-save'); assert.equal(ui.requests.at(-1).body.op,'editBooked'); assert.equal(ui.requests.at(-1).body.expectedSnapshot.deliveryMode,'in_person');
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

test('the lessons calendar is the shared component: one box per lesson with time, family name and subject initial, teacher off as 休み, wishes and events named', async () => {
  const slots = ['17:00', '17:30', '18:30', '19:00'].map((start, i) => slot('chain-' + i, { date: '2026-09-15', start, min: 90, status: 'booked', studentId: i % 2 ? 'test-b' : 'test-a', studentName: i % 2 ? '【テスト】B' : '【テスト】山田 太郎', subject: i % 2 ? '数学' : '英語', req: i === 2 ? '{"kind":"cancel"}' : '' }));
  slots.push(slot('of-1', { date: '2026-09-16', start: '16:00', min: 60, status: 'offered', studentId: 'test-a', studentName: '【テスト】山田 太郎', subject: '英語' }));
  const ui = createUI('admin', { hash: '#lessons' });
  ui.requests[0].reply({ admin: { today: '2026-09-08', slots, lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], students: [], meetings: [], teacherOff: [{ id: 'o1', date: '2026-09-20', start: '', end: '', note: '' }], wishes: [{ id: 'w1', studentId: 'test-b', studentName: '【テスト】B', date: '2026-09-18', start: '16:00', end: '18:00', kind: 'range' }], events: [{ id: 'e1', studentId: 'test-a', studentName: '【テスト】山田 太郎', date: '2026-09-25', dateTo: '2026-09-25', title: '中間テスト', kind: 'test' }] } }); await flush();
  const html = ui.html();
  assert.doesNotMatch(html, /class="cgrp"|class="cbox|class="caldot|calday boxed/, 'the old home renderer is gone');
  // 重なる授業は横に並ぶレーン(a992576)に入り、色は必要な対応で分ける(ed39666: 取消依頼は needs-attention)。1授業1箱・時刻順は変わらない
  const day15 = html.match(/<button class="calday[^"]*" data-action="calday" data-date="2026-09-15">15<span class="calmarks"><\/span>[^]*?<\/button>/)[0];
  assert.deepEqual([...day15.matchAll(/<span class="calbox ([^"]*)"><span class="t">([^<]*)<wbr>([^<]*)<\/span><span class="s">([^<]*)<\/span><\/span>/g)].map(m => [m[1], m[2] + m[3], m[4]]),
    [['admin-ok', '17:00-18:30', '山田 英'], ['admin-ok', '17:30-19:00', 'B 数'], ['needs-attention', '18:30-20:00', '山田 英（取消依頼）'], ['admin-ok', '19:00-20:30', 'B 数']]);
  assert.match(html, /data-date="2026-09-16">16<span class="calmarks"><\/span><span class="calbox of admin-pending"><span class="t">16:00-<wbr>17:00<\/span><span class="s">山田 英<\/span>/);
  assert.match(html, /data-date="2026-09-18">18<span class="calmarks"><\/span><span class="calbox wi">希 B 16-18<\/span>/);
  assert.match(html, /class="calday[^"]*toff[^"]*" data-action="calday" data-date="2026-09-20">20<span class="calmarks"><\/span><span class="callbl to"[^>]*>休み<\/span>/);
  assert.match(html, /data-date="2026-09-25">25<span class="calmarks"><\/span><span class="calbox ev">山田 中間テスト<\/span>/);
  assert.match(html, /<div class="callegend">[^]*<span class="callbl rq"[^>]*>要対応<\/span> 実施未登録・記録なし・取消依頼<\/span>[^]*<span class="callbl to toffswatch"[^>]*>休み<\/span> 先生の休み<\/span><\/div>/);
  assert.doesNotMatch(html, /登録不可/);
});
test('selected calendar day exposes add button and carries date into student offer',async()=>{
 const ui=await adminReady();ui.click('calday',{'data-date':'2026-09-15'});assert.match(ui.html(),/data-action="sdayadd" data-date="2026-09-15" aria-label="この日に予定を追加"/);assert.equal(ui.el('f-date'),undefined);
 // ＋は共通の案内モーダルを直接開き、選んだ日と表示中の生徒を入れておく(d046b20)。閉じても何も送らない
 ui.click('sdayadd',{'data-date':'2026-09-15'});assert.equal(ui.el('board-editor').modal,true);assert.equal(ui.el('f-date').value,'2026-09-15');assert.equal(ui.el('f-student').value,'test-a');ui.click('board-close');assert.equal(ui.el('f-date'),undefined);assert.equal(ui.requests.length,1);
});


test('past months stay reachable for a year and past days keep their lessons and 授業不可 marks', async () => {
  const c = card({ lessons: [{ id: 'old', date: '2026-04-10', start: '17:00', min: 60, status: 'booked', done: true, subject: '英語', kind: '' }], blocked: [{ id: 'b0', date: '2026-04-11', start: '', end: '', note: '' }], teacherOff: [{ id: 't0', date: '2026-04-12', start: '12:00', end: '13:00', note: '' }], wishes: [{ id: 'w0', date: '2026-04-13', start: '16:00', end: '18:00', kind: 'range' }] });
  const ui = await adminReady(c, 'overview');
  for (let i = 0; i < 5; i++) { assert.doesNotMatch(ui.html(), /data-action="calprev" disabled/); ui.click('calprev'); }
  const html = ui.html();
  assert.match(html, /<span class="callabel">2026年4月<\/span>/);
  // 管理の生徒カレンダーは授業一覧と同じ部品(e5df615: cal-lanes・先生の休みは「休み」)。記録のない実施済み授業は要対応の色(ed39666)
  assert.match(html, /<button class="calday[^"]*" data-action="calday" data-date="2026-04-10">10<span class="calmarks"><\/span><span class="calbox needs-attention"><span class="t">17:00-<wbr>18:00<\/span><span class="s">英語（通常）<\/span><\/span><\/button>/, 'a past lesson is a box on a clickable day');
  assert.match(html, /<button class="calday[^"]* sat ngday" data-action="calday" data-date="2026-04-11">11<span class="calmarks"><\/span><span class="callbl to"[^>]*>授業不可<\/span><\/button>/, 'past 授業不可 stays visible');
  assert.match(html, /<button class="calday[^"]* sun" data-action="calday" data-date="2026-04-12">12<span class="calmarks"><\/span><span class="calbox unavailable toff"><span class="t">12:00-<wbr>13:00<\/span><span class="s">休み<\/span><\/span><\/button>/, 'past teacher off stays visible');
  assert.match(html, /<span class="calday[^"]* off">13<span class="calmarks"><\/span><\/span>/, 'an expired 授業可 request is not shown and the empty past day is faded');
  assert.doesNotMatch(html, /data-date="2026-04-13"[^>]*>13/);
  // 日付カードの見出しは「M/D(曜)の授業」(e5df615)、通常の「実施済」バッジは省略し記録状態のタグと data-done で表す(1ec9f94)
  ui.click('calday', { 'data-date': '2026-04-10' }); assert.match(ui.html(), /<span>4\/10\(金\)の授業<\/span>/);
  assert.match(ui.html(), /href="#lesson\?student=test-a&amp;slot=old" title="授業記録を開く">未記入<\/a>/); assert.match(ui.html(), /data-action="slotedit" data-done="1" data-id="old"/);
});

test('the admin student page draws the same calendar as the student mypage (boxes, hatched days, legend)', async () => {
  const c = card({ lessons: [{ id: 'l1', date: '2026-09-15', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語', kind: '演習' }, { id: 'l2', date: '2026-09-16', start: '18:00', min: 60, status: 'offered', done: false, subject: '数学', kind: '' }], blocked: [{ id: 'b1', date: '2026-09-17', start: '', end: '', note: '' }], teacherOff: [{ id: 't1', date: '2026-09-18', note: '' }], wishes: [{ id: 'w1', date: '2026-09-19', start: '16:00', end: '18:00' }], events: [{ id: 'e1', date: '2026-09-20', dateTo: '2026-09-21', title: '中間テスト', kind: 'test' }] });
  const ui = await adminReady(c, 'overview');
  // 共通部品 calendar.js のまま、管理の授業ページと同じ表示に揃えた(e5df615: 重なりレーン・先生の休みは「休み」、ed39666: 対応別の色)
  assert.match(ui.html(), /<h2>【テスト】生徒A<\/h2>|さんの予定表<\/h2>/);
  assert.match(ui.html(), /data-date="2026-09-15">15<span class="calmarks"><\/span><span class="calbox admin-ok"><span class="t">17:00-<wbr>18:30<\/span><span class="s">英語（演習）<\/span><\/span>/);
  assert.match(ui.html(), /data-date="2026-09-16">16<span class="calmarks"><\/span><span class="calbox of admin-pending"><span class="t">18:00-<wbr>19:00<\/span><span class="s">数学（通常）<\/span>/);
  assert.match(ui.html(), /class="calday[^"]* ngday" data-action="calday" data-date="2026-09-17">17<span class="calmarks"><\/span><span class="callbl to"[^>]*>授業不可<\/span>/);
  assert.match(ui.html(), /class="calday[^"]* toff" data-action="calday" data-date="2026-09-18">18<span class="calmarks"><\/span><span class="callbl to"[^>]*>休み<\/span>/);
  assert.match(ui.html(), /data-date="2026-09-19">19<span class="calmarks"><\/span><span class="callbl wi">授業可<\/span>/);
  assert.match(ui.html(), /data-date="2026-09-20">20<span class="calmarks"><\/span><span class="calbox ev">中間テスト<\/span>/); assert.match(ui.html(), /data-date="2026-09-21">21<span class="calholiday">敬老の日<\/span><span class="calmarks"><\/span><span class="calbox ev">中間テスト<\/span>/);
  assert.match(ui.html(), /<div class="callegend"><span><span class="callbl" style="display:inline">授業<\/span><\/span>[^]*<span class="callbl to ngswatch"[^>]*>授業不可<\/span> 授業できない日<\/span><span><span class="callbl to toffswatch"[^>]*>休み<\/span> 先生の休み/);
  assert.doesNotMatch(ui.html(), /class="caldot|class="cbox/);
});

test('the admin day card mirrors the student 予定の編集 card with teacher actions', async () => {
  const c = card({ lessons: [{ id: 'l1', date: '2026-09-15', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語', kind: '演習', meetUrl: 'https://meet.example.invalid/x' }, { id: 'l2', date: '2026-09-15', start: '19:00', min: 60, status: 'offered', done: false, subject: '数学', kind: '' }, { id: 'l3', date: '2026-09-15', start: '15:00', min: 60, status: 'booked', done: true, subject: '国語', kind: '' }], blocked: [{ id: 'b1', date: '2026-09-15', start: '', end: '', note: '部活' }], teacherOff: [{ id: 't1', date: '2026-09-15', start: '09:00', end: '12:00', note: '' }], wishes: [{ id: 'w1', date: '2026-09-15', start: '16:00', end: '18:00', kind: 'ok', deliveryMode: 'online', duration: 90 }], events: [{ id: 'e1', date: '2026-09-15', dateTo: '2026-09-15', title: '中間テスト', kind: 'test' }] });
  const ui = await adminReady(c, 'overview'); ui.click('calday', { 'data-date': '2026-09-15' });
  assert.match(ui.html(), /class="schedule-day-heading"/);
  assert.match(ui.html(), /09:00〜12:00/);
  assert.match(ui.html(), /data-action="delevent" data-id="e1"/);
  // 通常の「実施済」バッジは省略(1ec9f94)。実施済みの授業は記録状態のタグ(記録ページへのリンク)と修正ボタンの data-done で示す
  assert.match(ui.html(), /href="#lesson\?student=test-a&amp;slot=l3" title="授業記録を開く">未記入<\/a>/);
  assert.match(ui.html(), /data-action="slotedit" data-done="1" data-id="l3"/);
  for (const id of ['l1','l2','l3']) assert.match(ui.html(), new RegExp('data-action="slotedit"[^>]*data-id="'+id+'"'));
  assert.match(ui.html(), /承認待ち/);
  assert.match(ui.html(), /data-action="sdelblock" data-id="b1"/);
  assert.match(ui.html(), /data-action="usewish"/);
  assert.match(ui.html(), /data-action="delwish" data-id="w1"/);
  assert.doesNotMatch(ui.html(), /手動で予定入力/);
  // ＋は授業一覧と共通の案内モーダルを、この生徒・この日で開く(d046b20)
  ui.click('sdayadd'); assert.equal(ui.el('board-editor').modal, true); assert.equal(ui.el('f-student').value, 'test-a'); assert.equal(ui.el('f-date').value, '2026-09-15');
  ui.click('board-close'); assert.equal(ui.requests.length, 1);
  ui.click('sdelblock', { 'data-id': 'b1' }); assert.equal(ui.requests.at(-1).body.op, 'delBlock'); assert.equal(ui.requests.at(-1).body.blockId, 'b1'); assert.equal(ui.requests.at(-1).body.studentId, 'test-a');
});

// 先生が日付カードからこの生徒の授業不可を登録する操作。d046b20 で＋が共通の案内モーダル(授業の案内のみ)に替わってから、
// sblockopen / sblockadd は「この希望で案内」(usewish)経由でしか表示されない。授業ページの代理登録フォームは
// e285b26 で「重複」として削除済みのため、手動で登録する入口がなくなっている。意図した削除と確認できるまで失敗のまま残す。
test('the teacher registers 授業不可 for the shown student from the day card', async () => {
  const c = card({ blocked: [{ id: 'b1', date: '2026-09-15', start: '', end: '', note: '部活' }] });
  const ui = await adminReady(c, 'overview'); ui.click('calday', { 'data-date': '2026-09-15' });
  ui.click('sdayadd'); ui.click('sblockopen'); ui.input('sb-start', '16:00'); ui.input('sb-end', '18:00'); ui.input('sb-note', '塾の面談'); ui.click('sblockadd');
  const r = ui.requests.at(-1).body; assert.equal(r.op, 'addBlock'); assert.equal(r.studentId, 'test-a'); assert.equal(r.date, '2026-09-15'); assert.equal(r.dateTo, '2026-09-15'); assert.equal(r.start, '16:00'); assert.equal(r.end, '18:00'); assert.equal(r.note, '塾の面談');
});

// AIボタンは文章入力の共通モーダルを、この生徒だけを選択肢にして開く(d046b20・e5bfbb9)。旧カード内の文章/手動の切替と説明欄は廃止
test('the admin day card AI button opens the shared text modal for this student: parse through scheduleParseTeacher, edit the proposal, register through nlApplyTeacher', async () => {
  const ui = await adminReady(card({ nlEnabled: true, deliveryMode: 'online' }), 'overview');
  ui.click('calday', { 'data-date': '2026-09-15' }); ui.click('sdayai');
  assert.equal(ui.el('ai-schedule').modal, true); assert.equal(ui.el('ai-student').value, 'test-a'); assert.deepEqual([...ui.html().matchAll(/<option value="([^"]+)"[^>]*>【テスト】/g)].map(m => m[1]), ['test-a']);
  assert.ok(ui.el('tnl-text')); assert.doesNotMatch(ui.html(), /文章で自動入力|手動で予定入力|data-action="dayoffer"|data-action="sblockopen"|data-action="dayinput"/); assert.equal(ui.el('tnl-text').getAttribute('placeholder'), '予定を文章で入力。AIが予定に変換し、下書きを作ります');
  ui.input('tnl-text', '来週水曜17時から90分英語の演習。20日は部活で休み。25日は中間テスト'); ui.click('tnl-parse');
  let r = ui.requests.at(-1).body; assert.equal(r.op, 'scheduleParseTeacher'); assert.equal(r.studentId, 'test-a'); assert.match(r.text, /英語の演習/); assert.deepEqual(r.subjects.slice(0, 2), ['英語', '数学']);
  ui.requests.at(-1).reply({ ok: true, items: [
    { kind: 'offer', dates: ['2026-09-16'], start: '17:00', min: 90, subject: '英語', lessonKind: '演習', needsTime: false, confidence: 'high', note: '' },
    { kind: 'offer', dates: ['2026-09-17'], start: '', min: 0, subject: '', lessonKind: '', needsTime: true, confidence: 'low', note: '' },
    { kind: 'block', dates: ['2026-09-20'], start: '', end: '', note: '部活', confidence: 'high' },
    { kind: 'event', dates: ['2026-09-25'], title: '中間テスト', test: true, alsoBlock: false, start: '', end: '', note: '', confidence: 'high' }
  ], questions: ['木曜の時刻は？'], summary: '案内2件、授業不可1件、予定1件です。' }); await flush();
  assert.match(ui.html(), /案内2件、授業不可1件、予定1件です。/); assert.match(ui.html(), /<strong>授業を案内<\/strong><br>9\/16\(水\)<br><input type="time" id="tnl-start-0" value="17:00"/); assert.match(ui.html(), /開始時刻を入れてください/); assert.match(ui.html(), /<strong>イベント：中間テスト（テスト・模試）<\/strong>/); assert.match(ui.html(), /<li>木曜の時刻は？<\/li>/);
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

// 予定タブの授業履歴の折りたたみは c08bd09 で未完了宿題の表に置き換え(過去の授業は予定表の日付から開く)
test('admin student overview omits upcoming and history folds and shows the homework table instead', async () => {
  const ui = await adminReady(card({ lessons: [{ id: 'p1', date: '2026-09-01', start: '17:00', min: 90, status: 'booked', done: true, subject: '英語' }, { id: 'u1', date: '2026-09-20', start: '17:00', min: 90, status: 'booked', done: false, subject: '英語' }] }), 'overview');
  assert.doesNotMatch(ui.html(), /data-fold="upcoming"|今後の予定/);
  assert.doesNotMatch(ui.html(), /data-fold="history"|授業履歴/); assert.match(ui.html(), /<h2>宿題 <span class="cnt">0件<\/span><\/h2>/);
  ui.click('calday', { 'data-date': '2026-09-01' }); assert.match(ui.html(), /href="#lesson\?student=test-a&amp;slot=p1" title="授業記録を開く"/);
});
