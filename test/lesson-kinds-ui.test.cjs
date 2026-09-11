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
  const { line } = require('./helpers/operations-ui-harness.cjs');
  s.planLines = [line({ id: 'l1', status: 'approved', approvedCount: 2, count: 2 }), line({ id: 'l2', kind: '演習', status: 'approved', approvedCount: 1, count: 1 })];
  const ui = await studentReady(s);
  assert.match(ui.html(), /英語（演習）/);
  assert.match(ui.html(), /<strong>英語<\/strong> <span class="tag gray">演習<\/span> 実施 0・予定 0<span class="muted">／計画 1回<\/span>/);
});

test('the admin plan card lists lines with status, opens one editor at a time, and sends line operations with the line id and revision', async () => {
  const { adminReady, card, line } = require('./helpers/operations-ui-harness.cjs');
  const lines = [line({ id: 'p1', status: 'proposed', revision: 3, comment: '既存のコメント' }), line({ id: 'a1', subject: '数学', kind: '演習', status: 'approved', approvedCount: 3, count: 4, startDate: '2026-09-22', endDate: '2026-10-05', period: '2026/9/22〜10/5', month: '', lessonMin: 60, lessonFee: 3000, approvedVia: 'LINE', consentDate: '2026-09-05' }), line({ id: 'd1', subject: '国語', status: 'draft', revision: 1 })];
  const ui = await adminReady(card({ plan: { lines, defaultRows: [{ subject: '英語', kind: '', count: 4 }] } }), 'billing');
  assert.match(ui.html(), /<div class="plan-grid"><div class="plan-gh">科目（種類）<\/div><div class="plan-gh">回数<\/div><div class="plan-gh">期間<\/div><div class="plan-gh">時間・料金<\/div><div class="plan-gr" data-line="p1"><div class="plan-gc">英語（通常）<\/div><div class="plan-gc">4回<\/div><div class="plan-gc">9月<\/div><div class="plan-gc">90分・3,000円<\/div><\/div><div class="plan-gs" data-line="p1">[^]*?<button class="btn-quiet btn-sm" data-action="pe-open" data-line="p1"[^>]*>✎<\/button><button class="btn-quiet btn-sm" data-action="plancopy" data-line="p1">/);
  assert.match(ui.html(), /<div class="plan-gr" data-line="a1"><div class="plan-gc">数学（演習）<\/div><div class="plan-gc">4回<br><span class="small muted">承認 3回<\/span><\/div><div class="plan-gc">9\/22〜10\/5<\/div><div class="plan-gc">60分・3,000円<\/div><\/div>/); assert.match(ui.html(), /承諾: 2026-09-05・LINE/);
  assert.doesNotMatch(ui.html(), /class="tag (amber|gray)">(承認待ち|下書き)</); assert.doesNotMatch(ui.html(), /2026年9月|2026\/9\/22/); assert.match(ui.html(), /<div class="plan-gs" data-line="d1"><div class="row"[^>]*><button class="btn-primary btn-sm" data-action="pl-send" data-line="d1" data-rev="1">送信<\/button><button class="btn-quiet btn-sm" data-action="pe-open" data-line="d1"/); assert.doesNotMatch(ui.html(), /案内を送信<\/button>|data-action="pl-delete"/);
  assert.match(ui.html(), /data-action="plancopy" data-line="p1"/); assert.doesNotMatch(ui.html(), /data-action="plancopy" data-line="d1"/);
  assert.match(ui.html(), /既定から10月の下書きを作る/); assert.doesNotMatch(ui.html(), /第\d+版|30分単価/);
  assert.match(ui.html(), /<h3 class="plan-group"[^>]*>送信済み（保護者の承認待ち） <span[^>]*>1件<\/span><\/h3>[^]*data-line="p1"[^]*<h3 class="plan-group"[^>]*>下書き <span[^>]*>1件<\/span><\/h3>[^]*data-line="d1"[^]*<h3 class="plan-group"[^>]*>承認済み <span[^>]*>1件<\/span><\/h3>[^]*data-line="a1"/); assert.doesNotMatch(ui.html(), /plan-group[^>]*>見送り/);
  // teacher consent record for the proposed line
  ui.input('pa-memo-p1', 'LINEで承諾'); ui.click('pl-approve', { 'data-line': 'p1' });
  let r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineApproveTeacher'); assert.equal(r.lineId, 'p1'); assert.equal(r.expectedRevision, 3); assert.equal(r.via, 'LINE'); assert.equal(r.memo, 'LINEで承諾');
  ui.requests.at(-1).reply({ ok: true, data: card({ plan: { lines, defaultRows: [] } }) }); await require('./helpers/operations-ui-harness.cjs').flush();
  // send a draft directly
  ui.click('pl-send', { 'data-line': 'd1' }); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineSave'); assert.equal(r.lineId, 'd1'); assert.equal(r.expectedRevision, 1); assert.equal(r.propose, true); assert.equal(r.subject, '国語');
  ui.requests.at(-1).reply({ ok: true, data: card({ plan: { lines, defaultRows: [] } }) }); await require('./helpers/operations-ui-harness.cjs').flush();
  // delete
  ui.click('pe-open', { 'data-line': 'd1' }); assert.match(ui.html(), /data-action="pe-delete"/); ui.click('pe-delete'); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineDelete'); assert.equal(r.lineId, 'd1'); assert.equal(r.expectedRevision, 1);
  ui.requests.at(-1).reply({ ok: true, data: card({ plan: { lines, defaultRows: [] } }) }); await require('./helpers/operations-ui-harness.cjs').flush();
  // editor: opening a second line replaces the first editor; comment travels with the payload
  ui.click('pe-open', { 'data-line': 'p1' }); assert.equal(ui.el('pe-comment').value, '既存のコメント'); assert.match(ui.html(), /送信済みの案内です/);
  ui.click('pe-open', { 'data-line': 'a1' }); assert.equal(ui.el('pe-count').value, '4'); assert.equal(ui.el('pe-min').value, '60'); assert.match(ui.html(), /承認済みの案内です。保存すると承認が失効/);
  ui.input('pe-comment', '講習の続き'); ui.click('pe-draft');
  r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineSave'); assert.equal(r.lineId, 'a1'); assert.equal(r.kind, '演習'); assert.equal(r.propose, false); assert.equal(r.comment, '講習の続き'); assert.equal(r.lessonMin, 60); assert.equal(r.lessonFee, 3000);
  // from default
  ui.requests.at(-1).reply({ ok: true, data: card({ plan: { lines, defaultRows: [{ subject: '英語', kind: '', count: 4 }] } }) }); await require('./helpers/operations-ui-harness.cjs').flush();
  ui.click('pl-fromdefault'); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLinesFromDefault'); assert.equal(r.ym, '2026-10');
});
