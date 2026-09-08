'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, slot, state, card, studentReady, adminReady, flush } = require('./helpers/operations-ui-harness.cjs');

function snapshot(s) { return { id: s.id, date: s.date, start: s.start, min: s.min, subject: s.subject, deliveryMode: s.deliveryMode }; }
function offered(patch = {}) { return slot('slot-a', { studentId: 'test-a', status: 'offered', ...patch }); }
async function editing(s = offered()) { const ui = await adminReady(card({ lessons: [s] })); ui.click('slotedit', { 'data-id': s.id }); return ui; }
function changeLesson(ui) {
  ui.input('se-date', '2026-09-12'); ui.input('se-start', '18:30'); ui.input('se-min', '90'); ui.input('se-subject', '化学'); ui.input('se-mode', 'online');
}

test('student single and batch confirmations carry exactly the displayed lesson snapshots', async () => {
  const a = slot('slot-a', { subject: '化学', min: 90 }), b = slot('slot-b');
  const ui = await studentReady(state([a, b])); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend');
  assert.deepEqual(ui.requests.at(-1).body.expectedSnapshots, [snapshot(a), snapshot(b)]);
  const single = await studentReady(state([a])); single.click('askaccept', { 'data-id': a.id }); single.click('doaccept');
  assert.deepEqual(single.requests.at(-1).body.expectedSnapshots, [snapshot(a)]);
});

test('chemistry can be selected for a new offer independently of the student default mode', async () => {
  const ui = await adminReady(); assert.match(ui.html(), /<option[^>]*>化学<\/option>/);
  ui.input('f-subject', '化学'); ui.input('f-date', '2026-09-15'); ui.input('f-start', '17:00'); ui.click('offerslot');
  assert.equal(ui.requests.at(-1).body.subject, '化学'); assert.equal(ui.requests.at(-1).body.deliveryMode, 'online');
});

test('calendar interleaves timed teacher breaks and lessons in start order while preserving overlap groups', async () => {
  const ui = createUI('admin', { hash: '#home' });
  const lessons = [offered({ start: '14:00', studentName: '【テスト】A' }), offered({ id: 'slot-b', start: '13:30', studentId: 'test-b', studentName: '【テスト】B' }),
    offered({ id: 'slot-c', start: '09:00', studentName: '【テスト】C', subject: '化学' })];
  ui.requests[0].reply({ data: { today: '2026-09-08', slots: lessons, lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], students: [], meetings: [],
    teacherOff: [{ date: '2026-09-10', start: '12:00', end: '13:00' }, { date: '2026-09-10', start: '08:00', end: '08:30' }] } }); await flush();
  const html = ui.html(), positions = ['休 8-8:30', 'title="09:00〜', '休 12-13', 'title="13:30〜', 'title="14:00〜'].map(s => {
    const p = html.indexOf(s); assert.ok(p >= 0, 'calendar item exists: ' + s); return p;
  });
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b)); assert.match(html, /化学/);
});

test('offered editor keeps the old snapshot while submitting the corrected date, duration, chemistry and mode', async () => {
  const s = offered({ subject: '' }), ui = await editing(s); assert.equal(ui.el('se-subject').value, ''); changeLesson(ui); ui.click('se-save');
  const req = ui.requests.at(-1).body;
  assert.equal(req.op, 'editOffered'); assert.equal(req.studentId, 'test-a'); assert.equal(req.slotId, 'slot-a');
  assert.deepEqual(req.expectedSnapshot, snapshot(s));
  assert.deepEqual([req.date, req.start, req.min, req.subject, req.deliveryMode], ['2026-09-12', '18:30', 90, '化学', 'online']);
  assert.match(req.requestId, /^[A-Za-z0-9_-]{8,100}$/); assert.equal(ui.beforeUnload(), true);
  ui.click('se-retry'); assert.equal(ui.requests.length, 2, 'busy button cannot duplicate the mutation');
});

test('an ambiguous offered edit freezes the payload and retries it unchanged until a confirmed response', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-save'); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.fail(); await flush(); assert.equal(ui.el('se-date').disabled, true); assert.equal(ui.beforeUnload(), true);
  ui.click('se-retry'); assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: false, pending: true, saved: true, errorCode: 'pending', error: '変更は保存しました。通知の準備を確認してください' }); await flush();
  assert.match(ui.html(), /変更は保存しました/); ui.click('se-retry'); assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: true, data: card({ lessons: [offered({ ...payload })] }), notificationWarning: '通知の到達が不明です。重複を避けるため再送しません' }); await flush();
  assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /通知の到達が不明/); assert.equal(ui.html().includes('data-action="se-retry"'), false);
});

test('a rest-day warning is confirmed in the DOM and only an explicit confirmation adds force', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-save'); const original = ui.requests.at(-1).body;
  ui.requests.at(-1).reply({ error: '変更先は先生の休みです', needForce: true }); await flush();
  assert.equal(ui.confirms(), 0); assert.match(ui.html(), /変更先は先生の休み/); assert.equal(original.force, undefined);
  ui.click('se-force'); const forced = ui.requests.at(-1).body; assert.equal(forced.force, true);
  for (const k of ['date', 'start', 'min', 'subject', 'deliveryMode', 'expectedSnapshot']) assert.deepEqual(forced[k], original[k]);
});

for (const op of ['editOffered', 'setSlotDeliveryMode']) test('reload reconstructs pending ' + op + ' from the server and restores its original request ID', async () => {
  const before = snapshot(offered()), after = { ...before, deliveryMode: 'online', ...(op === 'editOffered' ? { date: '2026-09-12', subject: '化学', min: 90 } : {}) };
  const pending = { requestId: 'server-pending-edit', op, studentId: 'test-a', slotId: 'slot-a', before, after };
  const ui = await adminReady(card({ lessons: [offered({ ...after, status: op === 'editOffered' ? 'offered' : 'booked' })], pendingEdits: [pending] }));
  ui.click('se-resume', { 'data-request': pending.requestId }); assert.equal(ui.el('se-mode').disabled, true); ui.click('se-retry');
  const req = ui.requests.at(-1).body; assert.equal(req.op, op); assert.equal(req.requestId, pending.requestId); assert.equal(req.deliveryMode, 'online');
  if (op === 'editOffered') { assert.deepEqual(req.expectedSnapshot, before); assert.equal(req.subject, '化学'); assert.equal(req.date, after.date); }
  else { assert.equal(req.expectedMode, 'in_person'); assert.equal(req.expectedSnapshot, undefined); }
});

test('opening a lesson with an existing pending edit resumes that request instead of making another', async () => {
  const before = snapshot(offered()), pending = { requestId: 'pending-before-current-card', op: 'editOffered', studentId: 'test-a', slotId: 'slot-a', before, after: { ...before, subject: '化学' } };
  const ui = await adminReady(card({ lessons: [offered()], pendingEdits: [pending] })); ui.click('slotedit', { 'data-id': 'slot-a' }); ui.click('se-retry');
  assert.equal(ui.requests.at(-1).body.requestId, pending.requestId); assert.equal(ui.requests.at(-1).body.subject, '化学');
});

test('a booked lesson opens a mode-only editor and carries a stable request ID through retry', async () => {
  const ui = await adminReady(card({ lessons: [offered({ status: 'booked' })] }));
  assert.equal(ui.html().includes('data-action="slotedit"'), false); ui.click('slotmode', { 'data-id': 'slot-a' });
  assert.equal(ui.el('se-date'), undefined); ui.input('se-mode', 'online'); ui.click('se-save');
  const req = structuredClone(ui.requests.at(-1).body); assert.equal(req.expectedMode, 'in_person'); assert.equal(req.op, 'setSlotDeliveryMode');
  ui.requests.at(-1).reply({ error: 'Meetの準備中です', errorCode: 'pending' }); await flush(); ui.click('se-retry'); assert.deepEqual(ui.requests.at(-1).body, req);
});

test('a stale edit conflict can be closed and does not leave an unrecoverable pending request', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-save');
  ui.requests.at(-1).reply({ error: '案内が変更されています', errorCode: 'conflict' }); await flush();
  assert.equal(ui.requests.at(-1).body.op, 'kanriStudent');
  const latest = offered({ date: '2026-09-14', subject: '数学', min: 60 }); ui.requests.at(-1).reply({ data: card({ lessons: [latest] }) }); await flush();
  assert.equal(ui.el('se-date').value, '2026-09-12', 'the unsaved draft survives refreshing its underlying card');
  assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /最新の案内/); ui.click('se-close'); assert.equal(ui.html().includes('aria-label="授業変更"'), false);
  ui.click('slotedit', { 'data-id': 'slot-a' }); assert.equal(ui.el('se-date').value, latest.date); ui.click('se-save');
  assert.deepEqual(ui.requests.at(-1).body.expectedSnapshot, snapshot(latest));
});

for (const dueMode of ['nextLesson', 'date', 'none']) test('teacher tasks submit the selected deadline policy: ' + dueMode, async () => {
  const ui = await adminReady(card({ lessons: [offered({ status: 'booked', subject: '化学' })] }));
  assert.equal(ui.el('tk-due-mode').value, 'nextLesson'); assert.equal(ui.el('tk-due-subject').value, '化学');
  ui.input('tk-title', '化学のワーク'); ui.change('tk-due-mode', dueMode);
  assert.equal(ui.el('tk-due').disabled, dueMode !== 'date'); assert.equal(ui.el('tk-due-subject').disabled, dueMode !== 'nextLesson');
  if (dueMode === 'date') ui.input('tk-due', '2026-09-22');
  ui.click('taskadd'); const req = ui.requests.at(-1).body;
  assert.equal(req.op, 'taskAdd'); assert.equal(req.dueMode, dueMode); assert.equal(req.due, dueMode === 'date' ? '2026-09-22' : '');
  if (dueMode === 'nextLesson') assert.equal(req.dueSubject, '化学');
});

async function lessonReady(record = null, extra = {}) {
  const ui = createUI('admin', { hash: '#lesson?student=test-a&slot=slot-a' });
  const context = { student: { id: 'test-a', name: '【テスト】生徒A', active: true }, slot: offered({ subject: '化学', status: 'booked' }),
    record, previous: null, otherPrevious: [], openTasks: [], homeworkState: [], draft: null, pending: null, slotChanged: false, lessonChoices: [], ...extra };
  ui.requests[0].reply({ ok: true, context }); await flush(); return ui;
}

test('lesson save explains public content and private notes while new homework defaults to the next lesson', async () => {
  const ui = await lessonReady(); assert.match(ui.html(), /保存して生徒・保護者へ公開/); assert.match(ui.html(), /先生だけのメモは非公開/);
  ui.input('lc-content', '化学反応式を練習'); ui.input('lc-teacherNote', 'SYNTHETIC_PRIVATE_NOTE'); ui.click('lc-add');
  assert.equal(ui.el('lc-due-mode-0').value, 'nextLesson'); assert.equal(ui.el('lc-due-0').disabled, true);
  ui.input('lc-title-0', '化学ワークp.10'); ui.click('lc-save'); const req = ui.requests.at(-1).body;
  assert.equal(req.op, 'lessonRecordSave'); assert.equal(req.record.homework[0].dueMode, 'nextLesson'); assert.equal(req.record.homework[0].due, '');
  assert.equal(req.record.teacherNote, 'SYNTHETIC_PRIVATE_NOTE');
  assert.equal(JSON.stringify([...ui.local, ...ui.session]).includes('SYNTHETIC_PRIVATE_NOTE'), false);
});

test('lesson homework deadline changes clear stale dates and retain the chosen policy through retry', async () => {
  const record = { id: 'synthetic-record', revision: 1, status: 'active', content: '保存された内容', publishedRevision: 1,
    homework: [{ itemId: 'synthetic-homework', title: '宿題', dueMode: 'date', due: '2026-09-20', type: '宿題' }] };
  const ui = await lessonReady(record); assert.match(ui.html(), /公開済み/); assert.match(ui.html(), /保存しても送信・公開されません/);
  assert.equal(ui.el('lc-due-0').disabled, false); ui.input('lc-due-mode-0', 'nextLesson');
  assert.equal(ui.el('lc-due-0').disabled, true); assert.equal(ui.el('lc-due-0').value, '');
  ui.click('lc-save'); const payload = structuredClone(ui.requests.at(-1).body); assert.equal(payload.record.homework[0].dueMode, 'nextLesson');
  ui.requests.at(-1).fail(); await flush(); ui.click('lc-retry'); assert.deepEqual(ui.requests.at(-1).body, payload);
});

test('teacher email status permits explicit retries only for safe queued messages and shows unknown results', async () => {
  const ui = await adminReady(card({ emailStatus: { email: 'synthetic@example.invalid', verified: true } }));
  ui.click('sm-load'); assert.equal(ui.requests.at(-1).body.op, 'studentEmailNotifications');
  const emailStatus = { email: 'synthetic@example.invalid', verified: true }, notifications = [
    { id: 'uncertain-notice', kind: 'changed', status: 'uncertain', retryable: false }, { id: 'failed-notice', kind: 'offered', status: 'failed', retryable: true }
  ];
  ui.requests.at(-1).reply({ ok: true, emailStatus, notifications }); await flush();
  assert.match(ui.html(), /送信結果不明/); assert.equal(ui.html().includes('data-action="sm-retry" data-id="uncertain-notice"'), false);
  ui.click('sm-retry', { 'data-id': 'failed-notice' }); assert.equal(ui.requests.length, 2); assert.match(ui.html(), /synthetic@example.invalid/);
  ui.click('sm-send'); const req = ui.requests.at(-1).body; assert.equal(req.op, 'studentEmailRetryNotification'); assert.equal(req.studentId, 'test-a'); assert.equal(req.notificationId, 'failed-notice');
  assert.equal(ui.confirms(), 0);
});

test('offered edit survives teacher re-login with its request identity and input intact', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-save'); const original = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({badAuth:true,error:'ログインし直してください'}); await flush();
  assert.ok(ui.el('a-email')); assert.equal(ui.beforeUnload(),true);
  ui.input('a-email','teacher@example.invalid'); ui.input('a-pass','test-password'); ui.click('login');
  ui.requests.at(-1).reply({ok:true,token:'new-teacher-token'}); await flush();
  ui.requests.at(-1).reply({data:card({lessons:[offered()]})}); await flush();
  assert.equal(ui.el('se-subject').value,'化学'); ui.click('se-retry');
  assert.deepEqual(ui.requests.at(-1).body,{...original,token:'new-teacher-token'});
});

test('an old-token edit response cannot block recovery after another tab refreshed teacher login', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-save'); const first=ui.requests.at(-1),original=structuredClone(first.body);
  ui.local.set('sw_admt','new-teacher-token'); ui.click('reload'); ui.requests.at(-1).reply({data:card({lessons:[offered()]})}); await flush();
  first.reply({badAuth:true,error:'old authentication'}); await flush();
  assert.equal(ui.local.get('sw_admt'),'new-teacher-token'); assert.equal(ui.el('se-subject').value,'化学'); ui.click('se-retry');
  assert.deepEqual(ui.requests.at(-1).body,{...original,token:'new-teacher-token'});
});
