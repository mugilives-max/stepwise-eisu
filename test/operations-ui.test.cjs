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
  const ui = await adminReady(); assert.equal(ui.el('f-delivery').value, 'online');
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
  const original = slot('slot-a', { status: 'booked', studentId: 'test-a' }); const ui = await adminReady(card({ lessons: [original] }));
  ui.change('student-delivery', 'in_person'); ui.click('studentmode');
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'setDeliveryMode'); assert.equal(b.deliveryMode, 'in_person'); assert.equal(b.slotId, undefined);
  ui.requests.at(-1).reply({ ok: true, data: card({ deliveryMode: 'in_person', lessons: [original] }), notificationWarning: '保存は完了しましたが通知を確認してください' }); await flush();
  assert.equal(ui.el('student-delivery').value, 'in_person'); ui.click('slotmode', { 'data-id': 'slot-a' }); assert.equal(ui.el('se-mode').value, 'in_person'); assert.match(ui.html(), /role="alert".*通知を確認/);
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
