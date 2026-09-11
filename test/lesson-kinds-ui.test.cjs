'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createUI, state, slot, studentReady, flush } = require('./helpers/operations-ui-harness.cjs');
const kinds = [{ name: '通常', standardMin: 90, standardFee: 6000, active: true }, { name: '演習', standardMin: 60, standardFee: 4000, active: true }, { name: '講習', standardMin: null, standardFee: null, active: false }];
function admin(extra = {}) { return { today: '2026-09-08', lessonKinds: kinds, students: [{ id: 'a', active: true, name: '【テスト】A', deliveryMode: 'in_person' }], slots: [], blocked: [], teacherOff: [], wishes: [], events: [], plans: [], log: [], ...extra }; }
async function lessons(extra) { const ui = createUI('admin', { hash: '#lessons' }); ui.requests[0].reply({ admin: admin(extra) }); await flush(); return ui; }

test('the offer form requires a kind (default 通常, inactive kinds hidden) and sends it with the offer', async () => {
  const ui = await lessons(); ui.click('board-new');
  assert.match(ui.html(), /<label for="f-kind">種類（必須）<\/label><select id="f-kind" required><option value="通常" selected>通常<\/option><option value="演習">演習<\/option><\/select>/);
  assert.doesNotMatch(ui.html(), /<option value="講習"/);
  ui.change('f-student', 'a'); ui.change('f-subject', '英語'); ui.change('f-kind', '演習'); ui.input('f-start', '17:00'); ui.change('f-min', '60'); ui.click('offerslot');
  assert.equal(ui.requests.at(-1).body.op, 'offer'); assert.equal(ui.requests.at(-1).body.kind, '演習'); assert.equal(ui.requests.at(-1).body.subject, '英語');
});

test('the settings page manages lesson kinds and lists lessons with their kind', async () => {
  const ui = await lessons({ slots: [{ id: 's1', date: '2026-09-10', start: '17:00', min: 60, status: 'offered', studentId: 'a', studentName: '【テスト】A', subject: '英語', kind: '演習', deliveryMode: 'in_person', done: false }] });
  assert.match(ui.html(), /英語（演習）/);
  ui.navigate('#settings');
  assert.match(ui.html(), /<h2>授業の種類<\/h2>/); assert.match(ui.html(), /<td>通常<\/td><td><input type="number" id="lk-min-0"[^>]*value="90"/); assert.match(ui.html(), /id="lk-active-0" checked disabled/);
  assert.match(ui.html(), /<td>講習<\/td>[^]*?id="lk-active-2">/);
  ui.input('lk-new-name', '英検対策'); ui.input('lk-new-min', '60'); ui.input('lk-new-fee', '5000'); ui.click('kindadd');
  assert.deepEqual({ op: ui.requests.at(-1).body.op, name: ui.requests.at(-1).body.name, standardMin: ui.requests.at(-1).body.standardMin, standardFee: ui.requests.at(-1).body.standardFee, active: ui.requests.at(-1).body.active }, { op: 'lessonKindSave', name: '英検対策', standardMin: '60', standardFee: '5000', active: true });
  ui.requests.at(-1).reply({ ok: true, lessonKinds: kinds.concat([{ name: '英検対策', standardMin: 60, standardFee: 5000, active: true }]), admin: admin({ lessonKinds: kinds.concat([{ name: '英検対策', standardMin: 60, standardFee: 5000, active: true }]) }) }); await flush();
  assert.match(ui.html(), /<td>英検対策<\/td>/);
  ui.input('lk-fee-1', '4500'); ui.click('kindsave', { 'data-name': '演習' });
  assert.equal(ui.requests.at(-1).body.name, '演習'); assert.equal(ui.requests.at(-1).body.standardFee, '4500'); assert.equal(ui.requests.at(-1).body.active, true);
  ui.requests.at(-1).reply({ ok: true, lessonKinds: kinds, admin: admin() }); await flush();
  assert.match(ui.html(), /<h2>授業の種類<\/h2>/);
});

test('students see the kind next to the subject and plan labels stay consistent', async () => {
  const s = state([slot('slot-a', { subject: '英語', kind: '演習' }), slot('slot-b', { subject: '英語', kind: '' })]);
  s.planMonths = [{ ym: '2026-09', status: 'approved', plan: { '英語': 2, '英語（演習）': 1 } }];
  const ui = await studentReady(s);
  assert.match(ui.html(), /英語（演習）/);
  assert.match(ui.html(), /<strong>英語<\/strong> <span class="tag gray">演習<\/span> 実施 0・予定 0<span class="muted">／計画 1回<\/span>/);
});

test('the admin plan card has a comment box that saves through planCommentSave', async () => {
  const { adminReady, card } = require('./helpers/operations-ui-harness.cjs');
  const c = card({ plan: { month: '2026-09', current: {}, fromDefault: false, monthRows: [], defaultRows: [], months: [{ ym: '2026-09', status: 'proposed', revision: 3, termsKnown: true, lessonMin: 90, rate30: 1500, monthly: 0, rows: [{ subject: '英語', count: 4 }], total: 4, comment: '既存のコメント' }] } });
  const ui = await adminReady(c, 'billing');
  assert.match(ui.html(), /<textarea id="pl-comment-2026-09" data-plan-ym="2026-09" data-plan-field="comment"[^>]*>既存のコメント<\/textarea>/);
  ui.input('pl-comment-2026-09', '英検対策なので回数を増やします'); ui.click('plancomment', { 'data-ym': '2026-09' });
  const r = ui.requests.at(-1); assert.equal(r.body.op, 'planCommentSave'); assert.equal(r.body.studentId, 'test-a'); assert.equal(r.body.ym, '2026-09'); assert.equal(r.body.comment, '英検対策なので回数を増やします');
});

test('the admin plan card is one form: rows, lesson time, per-lesson fee and comment submitted together, no revision number', async () => {
  const { adminReady, card } = require('./helpers/operations-ui-harness.cjs');
  const c = card({ plan: { month: '2026-09', current: {}, fromDefault: false, monthRows: [], defaultRows: [], months: [{ ym: '2026-09', status: 'proposed', revision: 4, termsKnown: true, lessonMin: 90, rate30: 1500, monthly: 0, rows: [{ subject: '英語', count: 4 }], total: 4, comment: '' }] } });
  const ui = await adminReady(c, 'billing');
  assert.doesNotMatch(ui.html(), /第4版|30分単価/); assert.match(ui.html(), /1回の授業料 <input type="number" id="pl-fee-2026-09" data-plan-ym="2026-09" data-plan-field="lessonFee"[^>]*value="4500"/);
  assert.match(ui.html(), /<select data-plan-row="0" data-plan-rowfield="subject"[^>]*><option value="">科目を選択<\/option><option value="英語" selected>/);
  assert.match(ui.html(), /設定 → 授業の種類/);
  ui.click('planrowadd', { 'data-ym': '2026-09' }); assert.match(ui.html(), /data-plan-row="1" data-plan-rowfield="count"/);
  ui.change('pl-comment-2026-09', 'x'); ui.input('pl-comment-2026-09', '英検対策');
  ui.click('plansubmit', { 'data-ym': '2026-09' }); assert.equal(ui.requests.length, 1);
  ui.click('planrowdel', { 'data-i': '1' }); ui.click('plansubmit', { 'data-ym': '2026-09' });
  const r = ui.requests.at(-1).body; assert.equal(r.op, 'planSubmit'); assert.equal(r.ym, '2026-09'); assert.equal(r.expectedRevision, 4); assert.equal(r.lessonMin, 90); assert.equal(r.lessonFee, 4500); assert.equal(r.comment, '英検対策');
  assert.deepEqual(r.rows, [{ subject: '英語', kind: '通常', count: 4 }]);
});
