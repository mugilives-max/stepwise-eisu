'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, slot, state, card, studentReady, adminReady, flush } = require('./helpers/operations-ui-harness.cjs');

function snapshot(s) { return { id: s.id, date: s.date, start: s.start, min: s.min, subject: s.subject, deliveryMode: s.deliveryMode }; }
// The admin lesson editor's expected snapshot also carries the lesson's date-change history (none for these lessons).
function editorSnapshot(s) { return { ...snapshot(s), changes: [] }; }
function offered(patch = {}) { return slot('slot-a', { studentId: 'test-a', status: 'offered', ...patch }); }
// Lesson rows (and their 詳細 = slotedit button) live in the student page's day card under the calendar; select the lesson's day first.
function openDay(ui, date = '2026-09-10') { ui.click('calday', { 'data-date': date }); }
async function editing(s = offered()) { const ui = await adminReady(card({ lessons: [s] })); openDay(ui, s.date); ui.click('slotedit', { 'data-id': s.id }); return ui; }
// 詳細 opens a read-only details table; 授業内容を編集 (se-content) turns its cells into fields that carry data-slot-edit but no id.
function detailField(ui, prop) { const tag = ui.html().match(new RegExp('<(?:input|select)\\b[^>]*\\bdata-slot-edit="' + prop + '"[^>]*>')); assert.ok(tag, 'visible detail field: ' + prop); return tag[0]; }
function detailValue(ui, prop) {
  const m = ui.html().match(new RegExp('<(input|select)\\b([^>]*\\bdata-slot-edit="' + prop + '"[^>]*)>([^]*?</select>)?')); assert.ok(m, 'visible detail field: ' + prop);
  if (m[1] === 'input') return (m[2].match(/\bvalue="([^"]*)"/) || [])[1];
  const opt = m[3].match(/<option\b([^>]*\bselected\b[^>]*)>([^<]*)<\/option>/); return opt ? ((opt[1].match(/value="([^"]*)"/) || [])[1] ?? opt[2]) : undefined;
}
// The harness can only type into elements with an id, so the page's real input handler is driven through the editor dialog
// temporarily carrying the visible field's data-slot-edit attribute (the only attribute that handler reads besides value).
function editDetail(ui, prop, value) {
  assert.doesNotMatch(detailField(ui, prop), /\bdisabled\b/, 'editable detail field: ' + prop);
  const dialog = ui.el('slot-editor'); dialog.attrs['data-slot-edit'] = prop; ui.input('slot-editor', value); delete dialog.attrs['data-slot-edit'];
}
function changeLesson(ui) {
  ui.click('se-content');
  editDetail(ui, 'date', '2026-09-12'); editDetail(ui, 'start', '18:30'); editDetail(ui, 'min', '90'); editDetail(ui, 'subject', '化学'); editDetail(ui, 'deliveryMode', 'online');
}

test('student single and batch confirmations carry exactly the displayed lesson snapshots', async () => {
  const a = slot('slot-a', { subject: '化学', min: 90 }), b = slot('slot-b');
  const ui = await studentReady(state([a, b])); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend');
  assert.deepEqual(ui.requests.at(-1).body.expectedSnapshots, [snapshot(a), snapshot(b)]);
  const single = await studentReady(state([a]));
  assert.match(single.html(), /data-action="askaccept"[^>]*>予定する<\/button>/);
  const before = single.requests.length;
  single.click('askaccept', { 'data-id': a.id });
  assert.match(single.html(), /<dialog id="schedule-accept-dialog"/);
  assert.match(single.html(), /の授業を予定しますか？/);
  assert.match(single.html(), /data-action="doaccept">OK<\/button>/);
  assert.equal(single.requests.length, before);
  single.click('closebar');
  assert.doesNotMatch(single.html(), /<dialog id="schedule-accept-dialog"/);
  assert.equal(single.requests.length, before);
  single.click('askaccept', { 'data-id': a.id }); single.click('doaccept');
  assert.deepEqual(single.requests.at(-1).body.expectedSnapshots, [snapshot(a)]);
});

test('chemistry can be selected for a new offer independently of the student default mode', async () => {
  // この日に予定を追加 opens the shared offer dialog for the shown student directly.
  const ui = await adminReady(); ui.click('calday', { 'data-date': '2026-09-15' }); ui.click('sdayadd'); assert.match(ui.html(), /<dialog id="board-editor"/); assert.match(ui.html(), /<option[^>]*>化学<\/option>/);
  ui.input('f-subject', '化学'); ui.input('f-date', '2026-09-15'); ui.input('f-start', '17:00'); ui.click('offerslot');
  assert.equal(ui.requests.at(-1).body.subject, '化学'); assert.equal(ui.requests.at(-1).body.deliveryMode, 'online');
});

test('the lessons calendar lists timed teacher breaks as 休み marks and the lessons of the day in start order (shared component)', async () => {
  const ui = createUI('admin', { hash: '#lessons' });
  const lessons = [offered({ start: '14:00', studentName: '【テスト】A' }), offered({ id: 'slot-b', start: '13:30', studentId: 'test-b', studentName: '【テスト】B' }),
    offered({ id: 'slot-c', start: '09:00', studentName: '【テスト】C', subject: '化学' })];
  ui.requests[0].reply({ admin: { today: '2026-09-08', slots: lessons, lessonsToday: [], lessonsWeek: [], pending: [], unpaid: [], students: [], meetings: [],
    teacherOff: [{ date: '2026-09-10', start: '12:00', end: '13:00' }, { date: '2026-09-10', start: '08:00', end: '08:30' }] } }); await flush();
  const html = ui.html(), cell = /data-date="2026-09-10">10<span class="calmarks"><\/span>([^]*?)<\/button>/.exec(html);
  assert.ok(cell, 'the day cell renders'); const marks = cell[1];
  // Teacher breaks and lessons share one chronological sequence.
  assert.deepEqual([...marks.matchAll(/class="t">(\d{2}:\d{2})/g)].map(m => m[1]), ['08:00','09:00','12:00','13:30','14:00']);
  assert.equal((marks.match(/calbox unavailable toff/g)||[]).length, 2);
  assert.doesNotMatch(html, /class="cbox|class="cgrp|title="時間が重なる授業"/);
});

test('offered editor keeps the old snapshot while submitting the corrected date, duration, chemistry and mode', async () => {
  const s = offered({ subject: '' }), ui = await editing(s); assert.match(ui.html(), /科目<\/th><td[^>]*><\/td>/, 'no subject is invented for the lesson'); changeLesson(ui); ui.click('se-detail-save');
  const req = ui.requests.at(-1).body;
  assert.equal(req.op, 'editOffered'); assert.equal(req.studentId, 'test-a'); assert.equal(req.slotId, 'slot-a');
  assert.deepEqual(req.expectedSnapshot, editorSnapshot(s));
  assert.deepEqual([req.date, req.start, req.min, req.subject, req.deliveryMode], ['2026-09-12', '18:30', 90, '化学', 'online']);
  assert.match(req.requestId, /^[A-Za-z0-9_-]{8,100}$/); assert.equal(ui.beforeUnload(), true);
  ui.click('se-detail-save'); assert.equal(ui.requests.length, 2, 'busy button cannot duplicate the mutation');
});

test('an ambiguous offered edit freezes the payload and retries it unchanged until a confirmed response', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-detail-save'); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.fail(); await flush(); assert.match(detailField(ui, 'date'), /\bdisabled\b/); assert.equal(ui.beforeUnload(), true);
  assert.match(ui.html(), /data-action="se-detail-save"[^>]*>同じ内容で結果を確認<\/button>/);
  ui.click('se-detail-save'); assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: false, pending: true, saved: true, errorCode: 'pending', error: '変更は保存しました。通知の準備を確認してください' }); await flush();
  assert.match(ui.html(), /変更は保存しました/); ui.click('se-detail-save'); assert.deepEqual(ui.requests.at(-1).body, payload);
  ui.requests.at(-1).reply({ ok: true, data: card({ lessons: [offered({ ...payload })] }), notificationWarning: '通知の到達が不明です。重複を避けるため再送しません' }); await flush();
  assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /通知の到達が不明/); assert.equal(ui.html().includes('data-action="se-detail-save"'), false);
});

test('a rest-day warning is confirmed in the DOM and only an explicit confirmation adds force', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-detail-save'); const original = ui.requests.at(-1).body;
  ui.requests.at(-1).reply({ error: '変更先は先生の休みです', needForce: true }); await flush();
  assert.equal(ui.confirms(), 0); assert.match(ui.html(), /変更先は先生の休み/); assert.equal(original.force, undefined);
  ui.click('se-force'); const forced = ui.requests.at(-1).body; assert.equal(forced.force, true);
  for (const k of ['date', 'start', 'min', 'subject', 'deliveryMode', 'expectedSnapshot']) assert.deepEqual(forced[k], original[k]);
});

for (const op of ['editOffered', 'setSlotDeliveryMode']) test('reload reconstructs pending ' + op + ' from the server and restores its original request ID', async () => {
  const before = snapshot(offered()), after = { ...before, deliveryMode: 'online', ...(op === 'editOffered' ? { date: '2026-09-12', subject: '化学', min: 90 } : {}) };
  const pending = { requestId: 'server-pending-edit', op, studentId: 'test-a', slotId: 'slot-a', before, after };
  const ui = await adminReady(card({ lessons: [offered({ ...after, status: op === 'editOffered' ? 'offered' : 'booked' })], pendingEdits: [pending] }));
  ui.click('se-resume', { 'data-request': pending.requestId }); assert.equal(ui.el('se-mode').disabled,true); ui.click('se-retry');
  const req = ui.requests.at(-1).body; assert.equal(req.op, op); assert.equal(req.requestId, pending.requestId); assert.equal(req.deliveryMode, 'online');
  if (op === 'editOffered') { assert.deepEqual(req.expectedSnapshot, before); assert.equal(req.subject, '化学'); assert.equal(req.date, after.date); }
  else { assert.equal(req.expectedMode, 'in_person'); assert.equal(req.expectedSnapshot, undefined); }
});

test('opening a lesson with an existing pending edit resumes that request instead of making another', async () => {
  const before = snapshot(offered()), pending = { requestId: 'pending-before-current-card', op: 'editOffered', studentId: 'test-a', slotId: 'slot-a', before, after: { ...before, subject: '化学' } };
  const ui = await adminReady(card({ lessons: [offered()], pendingEdits: [pending] })); openDay(ui); ui.click('slotedit', { 'data-id': 'slot-a' }); ui.click('se-retry');
  assert.equal(ui.requests.at(-1).body.requestId, pending.requestId); assert.equal(ui.requests.at(-1).body.subject, '化学');
});

// Booked lessons are edited in the same details table (editBooked: date, time, subject and mode) instead of a mode-only editor.
test('a booked lesson edit sends the shown snapshot and carries a stable request ID through retry', async () => {
  const s = offered({ status: 'booked' }), ui = await adminReady(card({ lessons: [s] })); openDay(ui);
  assert.doesNotMatch(ui.html(), /data-action="slotmode"/); ui.click('slotedit', { 'data-id': 'slot-a' }); ui.click('se-content');
  assert.equal(detailValue(ui, 'deliveryMode'), 'in_person'); assert.equal(ui.confirms(), 0); editDetail(ui, 'deliveryMode', 'online'); ui.click('se-detail-save');
  const req = structuredClone(ui.requests.at(-1).body); assert.equal(req.op, 'editBooked'); assert.deepEqual(req.expectedSnapshot, editorSnapshot(s));
  assert.deepEqual([req.date, req.start, req.min, req.subject, req.deliveryMode], [s.date, s.start, s.min, s.subject, 'online']); assert.match(req.requestId, /^[A-Za-z0-9_-]{8,100}$/);
  ui.requests.at(-1).reply({ error: 'Meetの準備中です', errorCode: 'pending' }); await flush(); ui.click('se-detail-save'); assert.deepEqual(ui.requests.at(-1).body, req);
});

test('a stale edit conflict can be closed and does not leave an unrecoverable pending request', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-detail-save');
  ui.requests.at(-1).reply({ error: '案内が変更されています', errorCode: 'conflict' }); await flush();
  assert.equal(ui.requests.at(-1).body.op, 'kanriStudent');
  const latest = offered({ date: '2026-09-14', subject: '数学', min: 60 }); ui.requests.at(-1).reply({ data: card({ lessons: [latest] }) }); await flush();
  assert.equal(detailValue(ui, 'date'), '2026-09-12', 'the unsaved draft survives refreshing its underlying card');
  assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /最新の案内/); ui.click('se-close'); assert.equal(ui.html().includes('aria-label="授業変更"'), false);
  // An unchanged save is a no-op, so the reopened lesson gets one real correction.
  openDay(ui, latest.date); ui.click('slotedit', { 'data-id': 'slot-a' }); ui.click('se-content'); assert.equal(detailValue(ui, 'date'), latest.date); editDetail(ui, 'start', '18:30'); ui.click('se-detail-save');
  assert.deepEqual(ui.requests.at(-1).body.expectedSnapshot, editorSnapshot(latest));
});

test('the admin student page no longer offers a task form; tasks come from the lesson record page', async () => {
  const ui = await adminReady(card({ lessons: [offered({ status: 'booked', subject: '化学' })], tasks: [{ id: 't1', type: '宿題', title: 'ワーク', due: '', done: false }] }));
  assert.equal(ui.el('tk-title'), undefined); assert.doesNotMatch(ui.html(), /data-action="taskadd"|<h2>宿題・持ち物/);
  assert.match(ui.html(), /aria-current="page">予定<\/a>/); assert.doesNotMatch(ui.html(), /予定・宿題/);
});

async function lessonReady(record = null, extra = {}) {
  const ui = createUI('admin', { hash: '#lesson?student=test-a&slot=slot-a' });
  const context = { student: { id: 'test-a', name: '【テスト】生徒A', active: true }, today: '2026-09-10', slot: offered({ subject: '化学', status: 'booked' }),
    record, previous: null, otherPrevious: [], openTasks: [], homeworkState: [], draft: null, pending: null, slotChanged: false, lessonChoices: [], ...extra };
  ui.requests[0].reply({ ok: true, context }); await flush(); return ui;
}

test('lesson save explains public content and private notes while new homework defaults to the next lesson', async () => {
  const ui = await lessonReady(); assert.match(ui.html(), /保存して公開/); assert.match(ui.html(), /先生だけのメモ.*非公開/);
  ui.input('lc-content', '化学反応式を練習'); ui.input('lc-teacherNote', 'SYNTHETIC_PRIVATE_NOTE');
  // a blank homework row is shown by default; a second one is added and left blank (ignored on save)
  // Only homework starts with a blank row; supplies/memos are optional additions.
  assert.ok(ui.el('lc-title-0') && !ui.el('lc-title-1'), 'one default row'); assert.doesNotMatch(ui.html(), /<option[^>]*>持ち物<\/option>/);
  // Each homework row shows its deadline choice inline (default: the next lesson); the date field appears only for 日付を指定.
  assert.equal(ui.el('lc-due-mode-0').value, 'nextLesson'); assert.equal(ui.el('lc-due-mode-2'), undefined); assert.equal(ui.el('lc-due-0'), undefined);
  ui.click('lc-add', { 'data-type': '持ち物' }); assert.ok(ui.el('lc-title-1')); assert.equal(ui.el('lc-title-1').getAttribute('aria-label'),'持ち物 1 の内容');
  ui.input('lc-title-0', '化学ワークp.10'); ui.click('lc-publish'); const req = ui.requests.at(-1).body;
  assert.equal(req.op, 'lessonRecordSave'); assert.equal(req.record.homework.length, 1); assert.equal(req.record.homework[0].dueMode, 'nextLesson'); assert.equal(req.record.homework[0].due, '');
  assert.ok(ui.html().indexOf('<h2>今回の記録</h2>') < ui.html().indexOf('前回の確認と現在の未完了宿題'), '今回の記録 comes first');
  assert.doesNotMatch(ui.html(), /単元とコメントだけで十分です|保存した授業記録を生徒・保護者と共有/);
  ui.click('help-toggle', { 'data-help': 'lesson' }); assert.match(ui.html(), /<h1[^>]*>授業記録<button[^>]*data-help="lesson"[^>]*aria-expanded="true"[^>]*>\?<\/button><\/h1><\/div>[^]*?<div class="card note"[^>]*>保存した授業記録を生徒・保護者と共有します/);
  assert.equal(req.record.teacherNote, 'SYNTHETIC_PRIVATE_NOTE');
  assert.equal(JSON.stringify([...ui.local, ...ui.session]).includes('SYNTHETIC_PRIVATE_NOTE'), false);
});

test('lesson homework deadline changes clear stale dates and retain the chosen policy through retry', async () => {
  const record = { id: 'synthetic-record', revision: 1, status: 'active', content: '保存された内容', publishedRevision: 1,
    homework: [{ itemId: 'synthetic-homework', title: '宿題', dueMode: 'date', due: '2026-09-20', type: '宿題' }] };
  const ui = await lessonReady(record); assert.match(ui.html(), /公開済み/); assert.match(ui.html(), /保存しても送信・公開されません/);
  // The saved date deadline is shown in the row's own deadline fields.
  assert.equal(ui.el('lc-due-mode-0').value,'date'); assert.equal(ui.el('lc-due-0').value,'2026-09-20');
  assert.equal(ui.el('lc-due-0').disabled, false); ui.input('lc-due-mode-0', 'nextLesson');
  assert.equal(ui.el('lc-due-0'), undefined, 'the date field is hidden unless 日付を指定'); ui.input('lc-due-mode-0', 'date'); assert.equal(ui.el('lc-due-0').value, ''); ui.input('lc-due-mode-0', 'nextLesson');
  ui.click('lc-publish'); const payload = structuredClone(ui.requests.at(-1).body); assert.equal(payload.record.homework[0].dueMode, 'nextLesson');
  ui.requests.at(-1).fail(); await flush(); ui.click('lc-retry'); assert.deepEqual(ui.requests.at(-1).body, payload);
});

test('student settings no longer exposes the removed email delivery panel', async () => {
  const ui = await adminReady(card(), 'settings');
  assert.doesNotMatch(ui.html(), /data-action="sm-load"|生徒メールの送信状況/);
});

test('offered edit survives teacher re-login with its request identity and input intact', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-detail-save'); const original = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({badAuth:true,error:'ログインし直してください'}); await flush();
  assert.ok(ui.el('a-email')); assert.equal(ui.beforeUnload(),true);
  ui.input('a-email','teacher@example.invalid'); ui.input('a-pass','test-password'); ui.click('login');
  ui.requests.at(-1).reply({ok:true,token:'new-teacher-token'}); await flush();
  ui.requests.at(-1).reply({data:card({lessons:[offered()]})}); await flush();
  assert.equal(detailValue(ui,'subject'),'化学'); ui.click('se-detail-save');
  assert.deepEqual(ui.requests.at(-1).body,{...original,token:'new-teacher-token'});
});

test('an old-token edit response cannot block recovery after another tab refreshed teacher login', async () => {
  const ui = await editing(); changeLesson(ui); ui.click('se-detail-save'); const first=ui.requests.at(-1),original=structuredClone(first.body);
  ui.local.set('sw_admt','new-teacher-token'); ui.click('reload'); ui.requests.at(-1).reply({data:card({lessons:[offered()]})}); await flush();
  first.reply({badAuth:true,error:'old authentication'}); await flush();
  assert.equal(ui.local.get('sw_admt'),'new-teacher-token'); assert.equal(detailValue(ui,'subject'),'化学'); ui.click('se-detail-save');
  assert.deepEqual(ui.requests.at(-1).body,{...original,token:'new-teacher-token'});
});


test('offer editing uses a dialog and withdraws the original offer once from inside it', async () => {
  const ui = await adminReady(card({lessons:[offered()]})); openDay(ui);
  assert.doesNotMatch(ui.html(), /data-action="delslot"/);
  ui.click('slotedit', {'data-id':'slot-a'});
  assert.match(ui.html(), /<dialog id="slot-editor" class="board-editor"/);
  // 予定を削除 withdraws the offer after one confirmation.
  ui.click('se-remove');
  const req = ui.requests.at(-1);
  assert.equal(req.body.op,'deleteSlot');
  assert.equal(req.body.slotId,'slot-a');
  assert.equal(req.body.studentId,'test-a');
  assert.equal(ui.confirms(),1);
  const count = ui.requests.length;
  // While the withdrawal is in flight the dialog's actions are disabled.
  ui.click('se-remove'); ui.click('se-delete'); ui.click('se-content'); ui.click('se-close');
  assert.equal(ui.requests.length,count); assert.equal(ui.confirms(),1);
  assert.match(ui.html(), /<dialog id="slot-editor"/);
  req.reply({ok:true,data:card({lessons:[]})}); await flush();
  assert.doesNotMatch(ui.html(), /<dialog id="slot-editor"/);
});

// Withdrawal and content editing are separate steps in the details dialog, so a failed withdrawal keeps the editor usable rather than a typed draft.
test('failed withdrawal keeps the offer editor open and usable for correction', async () => {
  const ui = await editing(); ui.click('se-remove');
  ui.requests.at(-1).reply({error:'この案内はすでに承認されています'}); await flush();
  assert.match(ui.html(), /すでに承認されています/);
  assert.match(ui.html(), /<dialog id="slot-editor"/); assert.doesNotMatch(ui.html(), /data-action="se-remove" disabled/);
  ui.click('se-content'); assert.equal(detailValue(ui,'start'),'17:00'); editDetail(ui,'start','18:30'); ui.click('se-detail-save');
  const req = ui.requests.at(-1).body; assert.equal(req.op,'editOffered'); assert.equal(req.slotId,'slot-a'); assert.equal(req.start,'18:30'); assert.deepEqual(req.expectedSnapshot, editorSnapshot(offered()));
  ui.requests.at(-1).reply({error:'この案内はすでに承認されています'}); await flush();
  ui.click('se-close'); assert.doesNotMatch(ui.html(), /<dialog id="slot-editor"/);
});


test('booked lessons show plain WEB text and release only through their edit modal', async () => {
  const ui = await adminReady(card({lessons:[offered({status:'booked',deliveryMode:'online'})]})); openDay(ui);
  assert.match(ui.html(), /<span class="small" style="color:var\(--primary\)"[^>]*>WEB<\/span>/);
  assert.doesNotMatch(ui.html(), /data-action="(?:slotmode|unbook)"/);
  ui.click('slotedit', {'data-id':'slot-a'});
  assert.match(ui.html(), /<dialog id="slot-editor"/);
  // 予定を削除 releases the booking (unbook); 欠席・キャンセルを登録 is the separate recorded-cancellation flow.
  assert.match(ui.html(), /data-action="se-remove"[^>]*>予定を削除<\/button>/);
  ui.click('se-remove'); const req = ui.requests.at(-1);
  assert.equal(req.body.op,'unbook'); assert.equal(req.body.slotId,'slot-a'); assert.equal(req.body.studentId,'test-a');
  assert.equal(ui.confirms(),1);
  req.reply({ok:true,data:card({lessons:[]})}); await flush();
  assert.doesNotMatch(ui.html(), /<dialog id="slot-editor"/);
});

// Completion is undone through the details table's 実施状況 field; a completed lesson cannot be released or cancelled there.
test('completed lessons move undo into the edit dialog and keep release disabled', async () => {
  const ui = await adminReady(card({lessons:[offered({status:'booked',done:true})]})); openDay(ui);
  assert.doesNotMatch(ui.html(), /data-action="(?:toggledone|unbook)"/);
  ui.click('slotedit', {'data-id':'slot-a'});
  assert.match(ui.html(), /data-action="se-delete" disabled/);
  assert.match(ui.html(), /data-action="se-remove" disabled/);
  ui.click('se-content');
  assert.match(detailField(ui,'deliveryMode'), /\bdisabled\b/); assert.match(detailField(ui,'date'), /\bdisabled\b/);
  ui.input('detail-done','false'); ui.click('se-detail-save'); const req=ui.requests.at(-1);
  assert.equal(req.body.op,'toggleDone'); assert.equal(req.body.done,false); assert.equal(req.body.expectedDone,'true');
  assert.equal(req.body.slotId,'slot-a'); assert.equal(req.body.studentId,'test-a');
  req.reply({ok:true,data:card({lessons:[offered({status:'booked',done:false})]})}); await flush();
  assert.doesNotMatch(ui.html(), /<dialog id="slot-editor"/);
});


test('dedicated planning page opens the proposal editor and refreshes saved defaults', async () => {
  const ui=createUI('admin',{hash:'#plans'});
  ui.requests[0].reply({data:{students:[{id:'test-a',name:'【テスト】生徒A',active:true}]}}); await flush();
  assert.ok(ui.html().includes('#plans?student=test-a'));
  ui.navigate('#plans?student=test-a');
  assert.equal(ui.requests.at(-1).body.section, 'billing');
  ui.requests.at(-1).reply({data:card({section:'billing',plan:{lines:[],defaultRows:[{subject:'英語',count:4}]}})}); await flush();
  assert.ok(ui.html().includes('現在の計画'));
  assert.ok(!ui.html().includes('請求・入金管理'));
  ui.click('pe-new'); assert.ok(ui.html().includes('id="plan-editor"'));
  ui.click('pe-cancel');
  ui.click('pl-fromdefault',{'data-ym':'2026-10'});
  assert.equal(ui.requests.at(-1).body.op,'planLinesFromDefault');
  assert.equal(ui.requests.at(-1).body.section, 'billing');
  ui.requests.at(-1).reply({data:card({section:'billing',name:'【テスト】更新済み'})}); await flush();
  assert.ok(ui.html().includes('【テスト】更新済みさんの授業計画'));
});


test('planning summary hides controls until details opens and retains editing in the dialog', async()=>{
 const ui=createUI('admin',{hash:'#plans?student=test-a'});
 const line={id:'test-plan',month:'2026-09',subject:'英語',kind:'',count:4,lessonMin:90,rate30:700,startDate:'2026-09-01',endDate:'2026-09-30',status:'proposed',revision:1};
 ui.requests[0].reply({data:card({section:'billing',plan:{lines:[line],defaultRows:[]}})});await flush();
 assert.ok(ui.html().includes('承認待ち'));
 assert.ok(ui.html().includes('<th>種類</th>'));
 ui.click('plan-comment',{'data-line':'test-plan'});
 assert.ok(ui.html().includes('colspan="8"'));
 assert.ok(ui.html().includes('コメントはありません'));
 ui.click('plan-comment',{'data-line':'test-plan'});
 assert.ok(ui.html().includes('colspan="8"'));
 assert.ok(ui.html().includes('white-space:nowrap;overflow:hidden;text-overflow:ellipsis'));
 assert.ok(ui.html().includes('<th>回数</th><th>時間</th>'));
 assert.ok(ui.html().includes('<td>通常</td>'));
 assert.ok(ui.html().includes('9/1〜9/30'));
 assert.ok(!ui.html().includes('data-action="pe-open"'));
 assert.ok(!ui.html().includes('id="plan-dialog"'));
 ui.click('plan-consent',{'data-line':'test-plan'});
 assert.ok(!ui.html().includes('open><summary>その他の操作</summary>'));
 assert.ok(ui.html().includes('open><summary>LINE・電話などで受けた承諾を記録</summary>'));
 ui.click('plan-close');
 ui.click('plan-detail',{'data-line':'test-plan'});
 assert.ok(ui.html().includes('id="plan-dialog"'));
 assert.ok(ui.html().includes('data-action="plancopy"'));
 assert.ok(ui.html().includes('class="btn-primary" data-action="pe-open"'));
 // Secondary actions are shown directly in the vertical details dialog, no longer folded under その他の操作.
 assert.ok(!ui.html().includes('<summary>その他の操作</summary>'));
 assert.ok(!ui.html().includes('data-action="po-open"'));
 assert.ok(!ui.html().includes('data-action="pl-approve"'));
 ui.click('pe-open',{'data-line':'test-plan'});
 assert.ok(ui.html().includes('id="plan-editor"'));
 assert.ok(ui.html().includes('<summary>授業内容の内訳（任意）</summary>'));
 const modal=ui.html().split('id="plan-dialog"')[1];
 assert.ok(modal.indexOf('id="pe-count"')<modal.indexOf('</table>'));
 assert.equal((modal.match(/id="pe-count"/g)||[]).length,1);
 ui.input('pe-count','7'); ui.input('pe-start','2026-09-02');
 ui.click('pe-send');
 assert.equal(ui.requests.at(-1).body.count,7);
 assert.equal(ui.requests.at(-1).body.startDate,'2026-09-02');
 ui.requests.at(-1).reply({data:card({section:'billing',plan:{lines:[line],defaultRows:[]}})});await flush();
 ui.click('plan-close');
 assert.ok(!ui.html().includes('id="plan-dialog"'));
});

 test('completed lesson subject editor submits the displayed snapshot and completion status', async()=>{
 const ui=await editing(offered({status:'booked',done:true,subject:'英数'}));
 ui.click('se-content');assert.equal(detailValue(ui,'subject'),'英数');assert.match(detailField(ui,'date'),/\bdisabled\b/);
 editDetail(ui,'subject','英語');ui.click('se-detail-save');const req=ui.requests.at(-1);
 assert.equal(req.body.op,'editLessonSubject');assert.equal(req.body.subject,'英語');assert.equal(req.body.expectedSnapshot.subject,'英数');assert.equal(req.body.expectedDone,'true');
 req.reply({ok:true,data:card({lessons:[offered({status:'booked',done:true,subject:'英語'})]})});await flush();assert.doesNotMatch(ui.html(),/<dialog id="slot-editor"/);
 });
