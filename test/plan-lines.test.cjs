'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const json = v => JSON.parse(JSON.stringify(v));
function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function rejected(r, code) { assert.ok(r && r.error, JSON.stringify(r)); if (code) assert.equal(r.errorCode, code, JSON.stringify(r)); return r; }
const base = { studentId: 'test-a', subject: '英語', kind: '通常', count: 4, startDate: '2026-09-01', endDate: '2026-09-30', lessonMin: 90, lessonFee: 4500, comment: '' };
const save = (h, args) => h.admin('planLineSave', { ...base, ...args });
const lines = h => json(h.context().planLinesFor_('test-a'));
const byKey = key => (x, y) => (key(x) > key(y)) - (key(x) < key(y));
const preview = (h, ym = '2026-09') => ok(h.admin('billingPreview', { studentId: 'test-a', ym })).billing;

test('a plan line validates its fields, derives rate30 from the per-lesson fee and starts as a draft', () => {
  const h = createSchedulingHarness();
  rejected(save(h, { subject: '' })); rejected(save(h, { count: 0 })); rejected(save(h, { kind: '講習' }), 'kindInvalid');
  rejected(save(h, { endDate: '2026-08-31' })); rejected(save(h, { endDate: '2027-09-02' })); rejected(save(h, { startDate: '2026-9-1' }));
  rejected(save(h, { lessonMin: 100 })); rejected(save(h, { lessonFee: -1 })); rejected(save(h, { comment: 'あ'.repeat(501) }));
  rejected(save(h, { studentId: 'nobody' }), 'notFound');
  const r = ok(save(h, { comment: '  学校の本文\r\n対策  ' }));
  assert.equal(r.line.status, 'draft'); assert.equal(r.line.rate30, 1500); assert.equal(r.line.lessonFee, 4500); assert.equal(r.line.revision, 1);
  assert.equal(r.line.period, '2026年9月'); assert.equal(r.line.month, '2026-09'); assert.equal(r.line.comment, '学校の本文\n対策');
  assert.equal(h.rows('planLines').length, 1); assert.equal(h.admin('kanriStudent', { studentId: 'test-a', section: 'billing' }).data.plan.lines.length, 1, 'kanri card carries lines');
  assert.equal(json(h.context().studentState_('synthetic-link-a')).planLines.length, 0, 'drafts are invisible to students');
  const span = ok(save(h, { subject: '数学', startDate: '2026-09-22', endDate: '2026-10-05', count: 6 }));
  assert.equal(span.line.period, '2026/9/22〜10/5'); assert.equal(span.line.month, '');
});

test('lines of the same subject and kind cannot overlap; other kinds and declined lines can', () => {
  const h = createSchedulingHarness(); ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60, standardFee: 3000 }));
  ok(save(h, {}));
  rejected(save(h, { startDate: '2026-09-22', endDate: '2026-10-05' }), 'overlap');
  ok(save(h, { kind: '演習', startDate: '2026-09-22', endDate: '2026-10-05', lessonMin: 60, lessonFee: 3000 }));
  ok(save(h, { startDate: '2026-10-01', endDate: '2026-10-31' }));
  assert.equal(lines(h).length, 3);
});

test('propose, parent approval with a reduced count, teacher consent record, and replay semantics', () => {
  const h = createSchedulingHarness();
  const sent = ok(save(h, { propose: true, comment: '入試対策' }));
  assert.equal(sent.line.status, 'proposed'); assert.equal(sent.line.revision, 1); assert.ok(sent.line.proposedAt);
  const st = json(h.context().studentState_('synthetic-link-a'));
  assert.equal(st.planLines.length, 1); assert.equal(st.planLines[0].comment, '入試対策'); assert.equal(st.planLines[0].lessonFee, 4500);
  const id = sent.line.id;
  // teacher consent record needs the current revision and evidence
  rejected(h.admin('planLineApproveTeacher', { studentId: 'test-a', lineId: id, expectedRevision: 0, via: '電話', consentDate: '2026-09-06' }), 'conflict');
  rejected(h.admin('planLineApproveTeacher', { studentId: 'test-a', lineId: id, expectedRevision: 1, via: '', consentDate: '2026-09-06' }));
  rejected(h.admin('planLineApproveTeacher', { studentId: 'test-a', lineId: id, expectedRevision: 1, via: '電話', consentDate: '2026-09-08' }));
  // parent reduces to 3
  const c = h.context(); const student = c.findStudent_('test-a');
  rejected(c.planLineParentDecide_(student, { lineId: id, expectedRevision: 1, approve: true, approvedCount: 5 }));
  const pd = ok(c.planLineParentDecide_(student, { lineId: id, expectedRevision: 1, approve: true, approvedCount: 3 }));
  const l = lines(h)[0]; assert.equal(l.status, 'approved'); assert.equal(l.approvedCount, 3); assert.equal(l.approvedVia, '保護者ページ'); assert.equal(l.consentDate, '2026-09-07');
  assert.equal(pd.data.planLines[0].approvedCount, 3);
  assert.equal(ok(h.context().planLineParentDecide_(student, { lineId: id, expectedRevision: 1, approve: true, approvedCount: 3 })).replayed, true);
  rejected(h.context().planLineParentDecide_(student, { lineId: id, expectedRevision: 1, approve: true, approvedCount: 2 }), 'conflict');
  assert.equal(preview(h).planStatus, 'approved');
  assert.equal(h.rows('approvalEvents').filter(e => e.id.startsWith(id)).map(e => e.event).join(','), 'proposed,approved');
  // editing an approved line invalidates the approval and bumps the revision
  const edited = ok(save(h, { lineId: id, count: 5, expectedRevision: 1 }));
  assert.equal(edited.line.status, 'draft'); assert.equal(edited.line.revision, 2); assert.equal(edited.line.approvedCount, null); assert.equal(edited.invalidated, true);
  rejected(save(h, { lineId: id, count: 5, expectedRevision: 1 }), 'conflict');
  const resent = ok(save(h, { lineId: id, count: 5, expectedRevision: 2, propose: true }));
  assert.equal(resent.line.revision, 3); assert.equal(resent.line.status, 'proposed');
  const decl = ok(h.context().planLineParentDecide_(student, { lineId: id, expectedRevision: 3, approve: false, memo: '今月は見送ります' }));
  assert.equal(lines(h)[0].status, 'declined'); assert.equal(lines(h)[0].approvedCount, 0); assert.equal(decl.data.planLines.length, 0);
});

test('booking is gated by the matching line across month boundaries and counts the whole period', () => {
  const h = createSchedulingHarness();
  const sent = ok(save(h, { subject: '数学', startDate: '2026-09-22', endDate: '2026-10-05', count: 2, propose: true }));
  const approved = h.approveLine(sent.line.id);
  assert.equal(approved.line.status, 'approved');
  const s1 = h.seedSlot({ date: '2026-09-25' }), s2 = h.seedSlot({ date: '2026-10-02' }), s3 = h.seedSlot({ date: '2026-10-03' }), out = h.seedSlot({ date: '2026-10-06' }), eng = h.seedSlot({ date: '2026-09-25', start: '18:00', subject: '英語' });
  ok(h.accept(s1.id)); ok(h.accept(s2.id));
  rejected(h.accept(s3.id), 'planLimit');
  rejected(h.accept(out.id), 'approvalRequired'); rejected(h.accept(eng.id), 'approvalRequired');
  // the line cannot shrink below or away from booked lessons, nor be deleted
  rejected(save(h, { lineId: sent.line.id, subject: '数学', startDate: '2026-09-22', endDate: '2026-10-05', count: 1, expectedRevision: 1 }), 'bookedOver');
  rejected(save(h, { lineId: sent.line.id, subject: '数学', startDate: '2026-09-22', endDate: '2026-09-30', count: 2, expectedRevision: 1 }), 'bookedOver');
  rejected(h.admin('planLineDelete', { studentId: 'test-a', lineId: sent.line.id }), 'bookedExists');
  ok(save(h, { lineId: sent.line.id, subject: '数学', startDate: '2026-09-22', endDate: '2026-10-10', count: 3, expectedRevision: 1 }));
  // batch acceptance also uses the line limit
  h.approveLine(sent.line.id, 2);
  const s4 = h.seedSlot({ date: '2026-10-08' }), s5 = h.seedSlot({ date: '2026-10-09' });
  const batch = h.acceptMany([s4.id, s5.id]); assert.equal(batch.errorCode, 'planLimit', JSON.stringify(batch));
});

test('monthly billing applies each lesson to its line rate, flags unapproved lessons and locks lines once invoiced', () => {
  const h = createSchedulingHarness(); h.advance(40 * 86400000); ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60, standardFee: 3000 }));
  const a = ok(save(h, { subject: '数学', propose: true })); h.approveLine(a.line.id);
  const b = ok(save(h, { subject: '数学', kind: '演習', startDate: '2026-09-22', endDate: '2026-10-05', count: 3, lessonMin: 60, lessonFee: 3000, propose: true })); h.approveLine(b.line.id);
  h.seedSlot({ date: '2026-09-02', status: 'booked', done: true, min: 90 });
  h.seedSlot({ date: '2026-09-25', status: 'booked', done: true, min: 60, kind: '演習' });
  h.seedSlot({ date: '2026-10-02', status: 'booked', done: true, min: 60, kind: '演習' });
  let p = preview(h); assert.equal(p.canBill, true, p.reason); assert.equal(p.amount, 7500); assert.equal(p.count, 2); assert.equal(p.rate30, 1500);
  assert.deepEqual(p.lessons.map(l => [l.date, l.amount, l.lineId === a.line.id ? 'a' : l.lineId === b.line.id ? 'b' : '?']), [['2026-09-02', 4500, 'a'], ['2026-09-25', 3000, 'b']]);
  const oct = preview(h, '2026-10'); assert.equal(oct.amount, 3000); assert.equal(oct.canBill, true, oct.reason);
  h.seedSlot({ date: '2026-09-10', status: 'booked', done: true, min: 60, subject: '英語' });
  p = preview(h); assert.equal(p.canBill, false); assert.equal(p.reason, '承認されていない科目・回数の授業があります'); assert.equal(p.provisional, true); assert.equal(p.amount, 7500 + 3000);
  h.setRow('slots', 'date', '2026-09-10', { subject: '数学' });
  p = preview(h); assert.equal(p.canBill, true, p.reason); assert.equal(p.amount, 7500 + 3000);
  const inv = ok(h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'plan-lines-invoice-1' }));
  assert.equal(inv.invoice.amount, 10500);
  rejected(save(h, { lineId: b.line.id, subject: '数学', kind: '演習', startDate: '2026-09-22', endDate: '2026-10-05', count: 4, lessonMin: 60, lessonFee: 3000 }), 'invoiceLocked');
  rejected(h.admin('planLineDelete', { studentId: 'test-a', lineId: a.line.id }), 'invoiceLocked');
  ok(save(h, { subject: '数学', startDate: '2026-11-01', endDate: '2026-11-30' }));
  const months = h.admin('kanriStudent', { studentId: 'test-a', section: 'billing' });
  assert.ok(months.data.billingMonths.some(m => m.ym === '2026-11'), 'a future line adds its month to the list');
  assert.equal(months.data.plan.lines.length, 3);
});

test('drafts can be created from the monthly defaults using kind standards, and deleted while unused', () => {
  const h = createSchedulingHarness(); ok(h.admin('lessonKindSave', { name: '演習', standardMin: 60, standardFee: 3000 }));
  ok(h.admin('planSet', { studentId: 'test-a', subject: '英語', count: 4 }));
  ok(h.admin('planSet', { studentId: 'test-a', subject: '数学', kind: '演習', count: 2 }));
  rejected(h.admin('planSet', { studentId: 'test-a', ym: '2026-09', subject: '英語', count: 4 }));
  const made = ok(h.admin('planLinesFromDefault', { studentId: 'test-a', ym: '2026-10' }));
  assert.equal(made.created, 2);
  const ls = lines(h).sort(byKey(l => l.subject));
  assert.deepEqual(ls.map(l => [l.subject, l.kind, l.count, l.startDate, l.endDate, l.lessonMin, l.rate30, l.status]), [['数学', '演習', 2, '2026-10-01', '2026-10-31', 60, 1500, 'draft'], ['英語', '', 4, '2026-10-01', '2026-10-31', 90, 1500, 'draft']]);
  assert.equal(ok(h.admin('planLinesFromDefault', { studentId: 'test-a', ym: '2026-10' })).skipped, 2);
  ok(h.admin('planLineDelete', { studentId: 'test-a', lineId: ls[0].id }));
  assert.equal(lines(h).length, 1);
  assert.equal(ok(h.admin('planLineDelete', { studentId: 'test-a', lineId: ls[0].id })).replayed, true);
});

test('legacy month agreements, plans and comments migrate to lines once', () => {
  const h = createSchedulingHarness();
  const c = h.context(); c.PropertiesService.getScriptProperties().deleteProperty('PLAN_LINES_MIGRATED');
  h.spreadsheet.getSheetByName('monthAgreements').appendRow(['agr1', 'test-a', '2026-08', 3, 'approved', JSON.stringify([{ subject: '英語', count: 4 }, { subject: '数学', count: 2, kind: '演習' }]), 1500, 0, '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z', 'LINE', '2026-07-21', '承諾メモ', '', 90, JSON.stringify([{ subject: '英語', count: 3 }, { subject: '数学', count: 2, kind: '演習' }])]);
  h.spreadsheet.getSheetByName('monthAgreements').appendRow(['agr2', 'test-a', '2026-09', 1, 'proposed', JSON.stringify([{ subject: '英語', count: 4 }]), 2000, 0, '2026-08-25T00:00:00Z', '', '', '', '', '', 60, '']);
  h.spreadsheet.getSheetByName('plans').appendRow(['pl1', 'test-a', '2026-10', '国語', 2, 'draft', '', '', '', '', '']);
  h.spreadsheet.getSheetByName('plans').appendRow(['pl2', 'test-a', 'default', '英語', 4, 'draft', '', '', '', '', '']);
  const pc = h.spreadsheet.getSheetByName('planComments') || h.spreadsheet.insertSheet('planComments');
  if (pc.getLastRow() === 0) pc.appendRow(['studentId', 'ym', 'comment', 'updatedAt']);
  pc.appendRow(['test-a', '2026-08', '夏の復習', '']);
  c.memoClear_(); c.planLinesMigrate_();
  const ls = lines(h).sort(byKey(l => l.startDate + l.subject));
  assert.deepEqual(ls.map(l => [l.startDate, l.endDate, l.subject, l.kind, l.count, l.approvedCount, l.status, l.revision, l.lessonMin, l.rate30, l.comment]), [
    ['2026-08-01', '2026-08-31', '数学', '演習', 2, 2, 'approved', 3, 90, 1500, '夏の復習'],
    ['2026-08-01', '2026-08-31', '英語', '', 3, 3, 'approved', 3, 90, 1500, '夏の復習'],
    ['2026-09-01', '2026-09-30', '英語', '', 4, null, 'proposed', 1, 60, 2000, ''],
    ['2026-10-01', '2026-10-31', '国語', '', 2, null, 'draft', 1, 90, 1500, '']
  ]);
  assert.equal(ls[1].approvedVia, 'LINE'); assert.equal(ls[1].consentDate, '2026-07-21');
  c.memoClear_(); c.planLinesMigrate_(); assert.equal(lines(h).length, 4, 'migration is idempotent');
  assert.equal(json(h.context().studentState_('synthetic-link-a')).planLines.map(l => l.status).join(','), 'proposed');
});

test('addon lines top up an approved line: same subject and kind, period inside the parent, own comment and approval, summed booking limit', () => {
  const h = createSchedulingHarness();
  const parent = ok(save(h, { subject: '数学', count: 2, propose: true, comment: '通常の予習' })); h.approveLine(parent.line.id);
  const addon = args => save(h, { subject: '数学', parentId: parent.line.id, count: 1, startDate: '2026-09-20', endDate: '2026-09-30', comment: '定期テスト前に演習量を増やすため', ...args });
  rejected(addon({ subject: '英語' })); rejected(addon({ endDate: '2026-10-05' })); rejected(addon({ parentId: 'nope' }), 'notFound');
  // a new plain line over the same period is still an overlap, and the error points at the addon route
  assert.match(rejected(save(h, { subject: '数学', startDate: '2026-09-20', endDate: '2026-09-30' }), 'overlap').error, /追加/);
  const a1 = ok(addon({ propose: true }));
  assert.equal(a1.line.addon, true); assert.equal(a1.line.parentId, parent.line.id); assert.equal(a1.line.comment, '定期テスト前に演習量を増やすため'); assert.equal(a1.line.status, 'proposed');
  // a second addon may overlap the first one
  const a2 = ok(addon({ count: 2, startDate: '2026-09-25', endDate: '2026-09-30', lessonFee: 6000, comment: '追加分は講習料金' }));
  assert.equal(a2.line.rate30, 2000);
  const st = json(h.context().studentState_('synthetic-link-a'));
  assert.deepEqual(st.planLines.map(l => [l.subject, l.count, l.addon, l.status]), [['数学', 1, true, 'proposed'], ['数学', 2, false, 'approved']]);
  // the parent cannot be deleted while addons exist; an addon can be deleted while unused
  rejected(h.admin('planLineDelete', { studentId: 'test-a', lineId: parent.line.id }), 'addonExists');
  // booking: parent limit 2, addon not yet approved → third lesson is over the limit
  const s1 = h.seedSlot({ date: '2026-09-10' }), s2 = h.seedSlot({ date: '2026-09-12' }), s3 = h.seedSlot({ date: '2026-09-22' }), s4 = h.seedSlot({ date: '2026-09-26' });
  ok(h.accept(s1.id)); ok(h.accept(s2.id)); rejected(h.accept(s3.id), 'planLimit');
  h.approveLine(a1.line.id); ok(h.accept(s3.id));
  rejected(h.accept(s4.id), 'planLimit');
  h.approveLine(a2.line.id); ok(h.accept(s4.id));
  // billing: the first two lessons use the parent rate, the next the addon rates in order
  h.advance(40 * 86400000);
  for (const id of [s1.id, s2.id, s3.id, s4.id]) h.setRow('slots', 'id', id, { done: true });
  const p = preview(h); assert.equal(p.canBill, true, p.reason);
  assert.deepEqual(p.lessons.map(l => [l.date, l.lineId === parent.line.id ? 'parent' : l.lineId === a1.line.id ? 'a1' : l.lineId === a2.line.id ? 'a2' : '?', l.amount]), [['2026-09-10', 'parent', 3000], ['2026-09-12', 'parent', 3000], ['2026-09-22', 'a1', 3000], ['2026-09-26', 'a2', 4000]]);
  assert.equal(p.amount, 13000);
  // the parent's count cannot drop below what its lessons need once the addons are full
  rejected(save(h, { lineId: parent.line.id, subject: '数学', count: 1, expectedRevision: h.context().planLine_('test-a', parent.line.id).revision }), 'bookedOver');
  // the month summary counts parent and addons
  assert.equal(h.context().billingMonthInfo_('test-a', '2026-09').total, 5);
});
