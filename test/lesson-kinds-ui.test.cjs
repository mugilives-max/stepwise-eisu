'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createUI, state, slot, studentReady, flush } = require('./helpers/operations-ui-harness.cjs');
const kinds = [{ name: '通常', standardMin: 90, standardFee: 6000, active: true }, { name: '演習', standardMin: 60, standardFee: 4000, active: true }, { name: '講習', standardMin: null, standardFee: null, active: false }];
function admin(extra = {}) { return { today: '2026-09-08', lessonKinds: kinds, students: [{ id: 'a', active: true, name: '【テスト】A', deliveryMode: 'in_person' }], slots: [], blocked: [], teacherOff: [], wishes: [], events: [], plans: [], log: [], ...extra }; }
async function lessons(extra) { const ui = createUI('admin', { hash: '#lessons' }); ui.requests[0].reply({ admin: admin(extra) }); await flush(); return ui; }

test('the offer form requires a kind (default 通常, inactive kinds hidden) and sends it with the offer', async () => {
  const ui = await lessons(); ui.click('calendar-add');
  // The offer form is a label/field table (84f3a9c, 089c9e2).
  assert.match(ui.html(), /<th scope="row"><label for="f-kind">種類（必須）<\/label><\/th><td><select id="f-kind" required><option value="通常" selected>通常<\/option><option value="演習">演習<\/option><\/select><\/td>/);
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
  // Plan progress is a table with a 種類 column (6853e03); each kind keeps its own line and counts.
  assert.match(ui.html(), /<th>期間<\/th><th>科目<\/th><th>種類<\/th><th>計画回数<\/th><th>登録回数<\/th><th>実施回数<\/th>/);
  assert.match(ui.html(), /<tr><td>9\/1〜9\/30<\/td><td>英語<\/td><td>通常<\/td><td>2回<\/td><td>0回<\/td><td>0回<\/td>/);
  assert.match(ui.html(), /<tr><td>9\/1〜9\/30<\/td><td>英語<\/td><td>演習<\/td><td>1回<\/td><td>0回<\/td><td>0回<\/td>/);
});

// The student billing tab no longer carries the plan card (e9a2f9e). Plans are managed on the planning page as one row per line,
// and each line's actions live in its details dialog (e8cf2f9, b568df1).
test('the planning page lists lines with status, opens one line dialog at a time, and sends line operations with the line id and revision', async () => {
  const { card, line } = require('./helpers/operations-ui-harness.cjs');
  const lines = [line({ id: 'p1', status: 'proposed', revision: 3, comment: '既存のコメント' }), line({ id: 'a1', subject: '数学', kind: '演習', status: 'approved', approvedCount: 3, count: 4, startDate: '2026-09-22', endDate: '2026-10-05', period: '2026/9/22〜10/5', month: '', lessonMin: 60, lessonFee: 3000, approvedVia: 'LINE', consentDate: '2026-09-05' }), line({ id: 'd1', subject: '国語', status: 'draft', revision: 1 })];
  // Addon defaults use the current day; keep this fixture stable after September 22.
  const ui = createUI('admin', {hash:'#plans?student=test-a', now:'2026-09-22T12:00:00+09:00'});
  ui.requests[0].reply({data:card({ section: 'billing', plan: { lines, defaultRows: [{ subject: '英語', kind: '', count: 4 }] } })}); await flush();
  const dialog = () => ui.html().split('<dialog id="plan-dialog"')[1] || '';
  assert.match(ui.html(), /<th>期間<\/th><th>科目<\/th><th>種類<\/th><th>回数<\/th><th>時間<\/th><th>1回の料金<\/th><th>状態<\/th>/);
  assert.match(ui.html(), /<tr><td>9\/1〜9\/30<\/td><td>英語<\/td><td>通常<\/td><td>4回<\/td><td>90分<\/td><td>3,000円<\/td><td><button type="button" class="tag amber" data-action="plan-consent" data-line="p1"[^>]*>承認待ち<\/button><\/td><td><button class="btn-quiet btn-sm" data-action="plan-detail" data-line="p1">詳細<\/button><\/td><\/tr>/);
  assert.match(ui.html(), /<tr><td>9\/22〜10\/5<\/td><td>数学<\/td><td>演習<\/td><td>4回<\/td><td>60分<\/td><td>3,000円<\/td><td><span class="tag blue">承認済み<\/span><\/td>/);
  assert.match(ui.html(), /<tr><td>9\/1〜9\/30<\/td><td>国語<\/td><td>通常<\/td><td>4回<\/td><td>90分<\/td><td>3,000円<\/td><td><span class="tag gray">下書き<\/span><\/td>/);
  assert.doesNotMatch(ui.html(), /2026年9月|2026\/9\/22|第\d+版|30分単価|data-action="pl-delete"/);
  // Line actions are only in the line's dialog.
  assert.doesNotMatch(ui.html(), /data-action="(?:pl-send|pl-approve|pe-open|pe-addon|plancopy)"/);
  assert.match(ui.html(), /data-action="pl-fromdefault" data-ym="2026-10">翌月の下書きを作成<\/button>/); assert.match(ui.html(), /毎月の既定: 英語（通常）4回/);
  // teacher consent record for the proposed line, opened from its 承認待ち status
  ui.click('plan-consent', { 'data-line': 'p1' }); assert.match(dialog(), /open><summary>LINE・電話などで受けた承諾を記録<\/summary>/); assert.match(dialog(), /data-action="plancopy" data-line="p1"/);
  ui.input('pa-memo-p1', 'LINEで承諾'); ui.click('pl-approve', { 'data-line': 'p1' });
  let r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineApproveTeacher'); assert.equal(r.lineId, 'p1'); assert.equal(r.expectedRevision, 3); assert.equal(r.via, 'LINE'); assert.equal(r.memo, 'LINEで承諾');
  ui.requests.at(-1).reply({ ok: true, data: card({ section: 'billing', plan: { lines, defaultRows: [] } }) }); await flush();
  ui.click('plan-close'); assert.equal(dialog(), '');
  // the approved line shows its recorded consent
  ui.click('plan-detail', { 'data-line': 'a1' }); assert.match(dialog(), /承諾: 2026-09-05・LINE/); assert.match(dialog(), /data-action="plancopy" data-line="a1"/); assert.doesNotMatch(dialog(), /data-action="pl-send"/);
  ui.click('plan-close');
  // send a draft directly from its dialog; a draft has no parent message to copy
  ui.click('plan-detail', { 'data-line': 'd1' }); assert.match(dialog(), /<button class="btn-primary btn-sm" data-action="pl-send" data-line="d1" data-rev="1">送信<\/button>/); assert.doesNotMatch(dialog(), /data-action="plancopy"/);
  ui.click('pl-send', { 'data-line': 'd1' }); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineSave'); assert.equal(r.lineId, 'd1'); assert.equal(r.expectedRevision, 1); assert.equal(r.propose, true); assert.equal(r.subject, '国語');
  ui.requests.at(-1).reply({ ok: true, data: card({ section: 'billing', plan: { lines, defaultRows: [] } }) }); await flush();
  // delete
  ui.click('pe-open', { 'data-line': 'd1' }); assert.match(dialog(), /data-action="pe-delete"/); ui.click('pe-delete'); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineDelete'); assert.equal(r.lineId, 'd1'); assert.equal(r.expectedRevision, 1);
  ui.requests.at(-1).reply({ ok: true, data: card({ section: 'billing', plan: { lines, defaultRows: [] } }) }); await flush();
  // editor: one line dialog and one editor at a time; comment travels with the payload
  ui.click('plan-close'); ui.click('plan-detail', { 'data-line': 'p1' }); ui.click('pe-open', { 'data-line': 'p1' }); assert.equal(ui.el('pe-comment').value, '既存のコメント'); assert.match(dialog(), /変更を保存すると、再送信・再承認が必要になります/);
  assert.equal((ui.html().match(/id="plan-editor"/g) || []).length, 1);
  ui.change('pe-kind','演習'); ui.input('pe-count','5'); ui.input('pe-comment','復習を追加します'); ui.click('pe-send');
  r=ui.requests.at(-1).body; assert.equal(r.lineId,'p1'); assert.equal(r.kind,'演習'); assert.equal(r.count,5); assert.equal(r.comment,'復習を追加します'); assert.equal(r.propose,true);
  ui.requests.at(-1).reply({ok:true,data:card({section:'billing',plan:{lines,defaultRows:[]}})}); await flush();
  ui.click('plan-close'); ui.click('plan-detail', { 'data-line': 'a1' }); ui.click('pe-open', { 'data-line': 'a1' }); assert.equal(ui.el('pe-count').value, '4'); assert.equal(ui.el('pe-min').value, '60'); assert.match(dialog(), /保存して案内を再送信（承認は失効）/);
  assert.equal((ui.html().match(/id="plan-editor"/g) || []).length, 1); assert.doesNotMatch(dialog(), /data-line="p1"/);
  ui.input('pe-comment', '講習の続き'); ui.click('pe-draft');
  r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineSave'); assert.equal(r.lineId, 'a1'); assert.equal(r.kind, '演習'); assert.equal(r.propose, false); assert.equal(r.comment, '講習の続き'); assert.equal(r.lessonMin, 60); assert.equal(r.lessonFee, 3000);
  // from default
  ui.requests.at(-1).reply({ ok: true, data: card({ section: 'billing', plan: { lines, defaultRows: [{ subject: '英語', kind: '', count: 4 }] } }) }); await flush();
  // addon (topping) on the approved line: same subject/kind locked, period inside the parent, comment required by the label, parentId in the payload
  ui.click('plan-close'); ui.click('plan-detail', { 'data-line': 'a1' }); ui.click('pe-addon', { 'data-line': 'a1' });
  assert.match(dialog(), /追加案内（トッピング）/); assert.match(dialog(), /<select id="pe-subject" data-pe-field="subject" disabled>/); assert.match(dialog(), /<input id="pe-start" data-pe-field="startDate" type="date" value="2026-09-22" min="2026-09-22" max="2026-10-05">/);
  assert.equal(ui.el('pe-count').value, '1'); assert.equal(ui.el('pe-fee').value, '3000'); assert.match(dialog(), /なぜ追加が必要か/); assert.doesNotMatch(dialog(), /data-action="pe-month"/);
  ui.input('pe-count', '2'); ui.input('pe-comment', 'テスト前に演習を増やすため'); ui.click('pe-send');
  r = ui.requests.at(-1).body; assert.equal(r.op, 'planLineSave'); assert.equal(r.parentId, 'a1'); assert.equal(r.lineId, undefined); assert.equal(r.subject, '数学'); assert.equal(r.kind, '演習'); assert.equal(r.count, 2); assert.equal(r.propose, true); assert.equal(r.comment, 'テスト前に演習を増やすため');
  ui.requests.at(-1).reply({ ok: true, data: card({ section: 'billing', plan: { lines: lines.concat([line({ id: 'x1', subject: '数学', kind: '演習', parentId: 'a1', addon: true, count: 2, status: 'proposed', startDate: '2026-09-22', endDate: '2026-10-05', period: '2026/9/22〜10/5', month: '', lessonMin: 60, lessonFee: 3000, comment: 'テスト前' })]), defaultRows: [{ subject: '英語', kind: '', count: 4 }] } }) }); await flush();
  assert.match(ui.html(), /<tr><td>9\/22〜10\/5<\/td><td>数学（追加）<\/td><td>演習<\/td><td>2回<\/td>/);
  ui.click('plan-close'); ui.click('plan-detail', { 'data-line': 'x1' }); assert.match(dialog(), /data-line="x1"/); assert.doesNotMatch(dialog(), /data-action="pe-addon"/);
  ui.click('plan-close'); ui.click('pl-fromdefault'); r = ui.requests.at(-1).body; assert.equal(r.op, 'planLinesFromDefault'); assert.equal(r.ym, '2026-10');
});

// The plan heading and its help moved off the billing tab with the plan card (e9a2f9e); the billing heading keeps its ? toggle.
test('the billing heading carries a ? help toggle instead of an always-visible explanation', async () => {
  const { adminReady, card } = require('./helpers/operations-ui-harness.cjs');
  const ui = await adminReady(card(), 'billing');
  assert.doesNotMatch(ui.html(), /対象月に実施した授業のうち|請求済みの履歴は/);
  ui.click('help-toggle', { 'data-help': 'billing' }); assert.match(ui.html(), /<h2>請求・入金管理<button[^>]*aria-expanded="true"[^>]*>\?<\/button><\/h2><div class="card note"[^>]*>対象月に実施した授業のうち、承認済みの授業計画に当てはまる分だけを請求します/);
  ui.click('help-toggle', { 'data-help': 'billing' }); assert.doesNotMatch(ui.html(), /対象月に実施した授業のうち/);
});

// The 消化状況 card left with the plan card (e9a2f9e); plan progress is now the 授業計画・実施状況 table on the student overview (d046b20).
test('the student overview plan progress shows planned, registered and done counts per line with addons folded in', async () => {
  const { adminReady, card, line } = require('./helpers/operations-ui-harness.cjs');
  const lines = [line({ id: 'p', status: 'approved', approvedCount: 4 }), line({ id: 'x', parentId: 'p', addon: true, status: 'approved', count: 2, approvedCount: 2, startDate: '2026-09-20', endDate: '2026-09-30', period: '2026/9/20〜9/30', month: '' }), line({ id: 'q', subject: '数学', status: 'approved', approvedCount: 3, count: 3 }), line({ id: 'd', subject: '理科', status: 'proposed' })];
  const ui = await adminReady(card({ plan: { lines, defaultRows: [], usage: { p: { done: 2, planned: 1 }, x: { done: 1, planned: 0 }, q: { done: 3, planned: 0 } } } }));
  const progress = ui.html().split('<h2>授業計画・実施状況</h2>')[1];
  assert.ok(progress, 'the progress table renders');
  assert.match(progress, /<th>期間<\/th><th>科目<\/th><th>種類<\/th><th>計画回数<\/th><th>登録回数<\/th><th>実施回数<\/th><th>状態<\/th>/);
  // the addon x is folded into p: planned 4+2, registered (2+1)+(1+0), done 2+1
  assert.match(progress, /<tr><td>9\/1〜9\/30<\/td><td>英語<\/td><td>通常<\/td><td>6回<\/td><td>4回<\/td><td>3回<\/td><td>承認済み<\/td><\/tr>/);
  assert.match(progress, /<tr><td>9\/1〜9\/30<\/td><td>数学<\/td><td>通常<\/td><td>3回<\/td><td>3回<\/td><td>3回<\/td><td>承認済み<\/td><\/tr>/);
  assert.match(progress, /<tr><td>9\/1〜9\/30<\/td><td>理科<\/td><td>通常<\/td><td>4回<\/td><td>0回<\/td><td>0回<\/td><td>承認待ち<\/td><\/tr>/);
  assert.doesNotMatch(progress, /（追加）|9\/20〜9\/30/);
});
