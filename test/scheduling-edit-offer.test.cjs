'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness, failWriteOnce } = require('./helpers/scheduling-harness.cjs');

function request(h, slot, patch = {}) {
  return h.teacherRequest('editOffered', { studentId: slot.studentId, slotId: slot.id, requestId: 'synthetic-offer-edit',
    expectedSnapshot: h.snapshot(slot.id), ...h.snapshot(slot.id), date: '2026-09-16', start: '17:00', min: 90, subject: '化学', ...patch });
}
function saved(h) { return ['slots', 'offerEdits', 'acceptWrites'].map(name => h.rows(name)); }
function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function rejected(r, code) { assert.ok(r.error, JSON.stringify(r)); if (code) assert.equal(r.errorCode, code); return r; }
function freeze(h, ym) {
  h.context().ledgerSheet_('入金管理');
  const sheet = h.ledger.getSheetByName('入金管理'), invoice = { '年月': ym, '生徒ID': 'test-a', '状態': '未入金', '請求額': 3000 };
  sheet.appendRow(sheet.values[0].map(k => invoice[k] ?? ''));
}

test('offered editing keeps the slot identity, fixes a blank legacy subject and preserves unrelated fields', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot({ subject: '', req: 'synthetic-private-note' }), req = request(h, slot);
  ok(h.request(req));
  assert.equal(h.rows('slots').length, 1);
  assert.deepEqual(h.snapshot(slot.id), { id: slot.id, date: '2026-09-16', start: '17:00', min: 90, subject: '化学', deliveryMode: 'in_person' });
  assert.equal(h.rows('slots')[0].req, 'synthetic-private-note');
  assert.equal(h.rows('slots')[0].studentId, slot.studentId); assert.equal(h.rows('slots')[0].status, 'offered');
  assert.equal(h.rows('offerEdits')[0].status, 'done');
  assert.equal(h.spreadsheet.getSheetByName('offerEdits').values[0].length, 9);
  const before = saved(h); assert.equal(ok(h.request(req)).replayed, true); assert.deepEqual(saved(h), before);
});

test('offered editing requires teacher authorization, ownership, offered status and a full current snapshot', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot), before = saved(h);
  for (const changes of [{ token: 'not-authorized' }, { studentId: 'test-b' }, { expectedSnapshot: undefined },
    { expectedSnapshot: { ...req.expectedSnapshot, subject: '英語' } }, { requestId: 'short' }]) {
    rejected(h.request({ ...req, ...changes })); assert.deepEqual(saved(h), before);
  }
  h.setRow('slots', 'id', slot.id, { status: 'booked' }); rejected(h.request(req), 'notFound');
  assert.equal(h.rows('offerEdits').length, 0);
});

for (const patch of [{ min: 0 }, { min: 481 }, { min: 60.5 }, { start: '23:30', min: 60 }, { date: '2026-02-30' }, { subject: '' }, { subject: '=formula' }, { deliveryMode: '' }]) {
  test('invalid offered edit makes no writes: ' + JSON.stringify(patch), () => {
    const h = createSchedulingHarness(), slot = h.seedSlot(), before = saved(h);
    rejected(h.request(request(h, slot, patch))); assert.deepEqual(saved(h), before);
  });
}

for (const ym of ['2026-09', '2026-10']) test('editing across months respects invoice freeze in ' + ym, () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(); freeze(h, ym); const before = saved(h);
  rejected(h.request(request(h, slot, { date: '2026-10-01', force: true })), 'invoiceLocked');
  assert.deepEqual(saved(h), before);
});

test('moving earlier checks the target teacher day and student blocked times; force bypasses only those warnings', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot({ date: '2026-09-25' });
  h.append('teacherOff', { id: 'synthetic-off-day', date: '2026-09-10', start: '', end: '', note: 'private reason' });
  h.append('blocked', { id: 'synthetic-student-block', studentId: 'test-a', date: '2026-09-10', start: '16:00', end: '19:00' });
  const req = request(h, slot, { date: '2026-09-10' }), before = saved(h), warning = rejected(h.request(req));
  assert.equal(warning.needForce, true); assert.match(warning.error, /先生/); assert.match(warning.error, /生徒/); assert.deepEqual(saved(h), before);
  h.seedSlot({ studentId: 'test-b', date: req.date, start: req.start, deliveryMode: 'online' });
  rejected(h.request({ ...req, force: true }), 'capacity'); assert.equal(h.rows('offerEdits').length, 0);
  h.setRow('slots', 'id', h.rows('slots')[1].id, { status: 'open' }); ok(h.request({ ...req, force: true }));
});

test('same-student overlap remains forbidden while touching interval boundaries stays valid', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(); h.seedSlot({ date: '2026-09-16', start: '16:00' });
  rejected(h.request(request(h, slot, { start: '16:30', force: true })), 'capacity');
  ok(h.request(request(h, slot, { start: '17:00' })));
});

test('editing and fresh accept reject an obsolete screen without journal or booking writes', () => {
  const h = createSchedulingHarness(); h.approve(); h.approve({ subject: '化学' });
  const slot = h.seedSlot(), old = h.snapshot(slot.id), req = request(h, slot); ok(h.request(req));
  const before = saved(h);
  assert.equal(rejected(h.acceptMany([slot.id], 'stale-screen-accept', { expectedSnapshots: [old] }), 'conflict').refresh, true);
  assert.equal(rejected(h.request({ action: 'acceptMany', k: 'synthetic-link-a', slotIds: [slot.id], requestId: 'old-screen-no-snapshot' }), 'conflict').refresh, true);
  rejected(h.request({ action: 'accept', k: 'synthetic-link-a', slotId: slot.id }), 'conflict');
  rejected(h.request({ ...req, requestId: 'stale-teacher-edit' }), 'conflict');
  assert.deepEqual(saved(h), before); ok(h.acceptMany([slot.id], 'fresh-screen-accept'));
});

test('one stale item rejects the entire selected batch before any write', () => {
  const h = createSchedulingHarness(); h.approve();
  const a = h.seedSlot(), b = h.seedSlot({ date: '2026-09-20' }), snapshots = [h.snapshot(a.id), h.snapshot(b.id)];
  ok(h.request(request(h, b, { subject: '数学' }))); const before = saved(h);
  rejected(h.acceptMany([a.id, b.id], 'mixed-stale-batch', { expectedSnapshots: snapshots }), 'conflict'); assert.deepEqual(saved(h), before);
});

for (const [label, name, match] of [
  ['journal start', 'offerEdits', v => v[0][6] === 'pending'],
  ['edited slot', 'slots', v => v[0][1] === '2026-09-16'],
  ['journal receipt', 'offerEdits', v => v[0][6] === 'done']
]) for (const after of [false, true]) test(`offered edit recovers ${label} failure ${after ? 'after' : 'before'} persistence`, () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot);
  failWriteOnce(h.spreadsheet.getSheetByName(name), match, after);
  assert.equal(h.request(req).pending, true);
  ok(h.request(req)); assert.equal(h.rows('slots').length, 1); assert.equal(h.rows('offerEdits').length, 1);
  assert.equal(h.rows('offerEdits')[0].status, 'done'); assert.equal(h.snapshot(slot.id).subject, '化学');
});

test('durable slot recovery only finishes its receipt even if an invoice was issued afterward', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot);
  failWriteOnce(h.spreadsheet.getSheetByName('offerEdits'), v => v[0][6] === 'done');
  assert.equal(h.request(req).pending, true); freeze(h, '2026-09'); ok(h.request(req));
  assert.equal(h.rows('offerEdits')[0].status, 'done');
});

test('a pending edit reserves the destination, blocks slot mutations, and can be reconstructed after reload', () => {
  const h = createSchedulingHarness(); h.approve();
  const slot = h.seedSlot(), req = request(h, slot, { deliveryMode: 'online' });
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), v => v[0][1] === req.date);
  assert.equal(h.request(req).pending, true);
  const rows = JSON.parse(JSON.stringify(h.context().schedulingPendingEdits_('test-a')));
  assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]).sort(), ['after', 'before', 'op', 'requestId', 'slotId', 'studentId']);
  assert.deepEqual(Object.keys(rows[0].before).sort(), ['date', 'deliveryMode', 'id', 'min', 'start', 'subject']);
  assert.equal(h.context().schedulingPendingEdits_('test-b').length, 0);
  rejected(h.offer({ studentId: 'test-b', date: req.date, start: req.start }), 'capacity');
  rejected(h.acceptMany([slot.id], 'pending-edit-accept'), 'pending');
  rejected(h.admin('deleteSlot', { studentId: 'test-a', slotId: slot.id }), 'pending');
  rejected(h.request({ ...req, requestId: 'competing-teacher-edit' }), 'pending');
  const recovery = rows[0]; ok(h.request(h.teacherRequest(recovery.op, { studentId: recovery.studentId, slotId: recovery.slotId,
    requestId: recovery.requestId, expectedSnapshot: recovery.before, ...recovery.after })));
  assert.equal(h.context().schedulingPendingEdits_().length, 0);
});

test('a pending in-person move does not count the same learner twice in its overlapping old/new times', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot, { date: slot.date, start: '16:30' });
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), v => v[0][2] === '16:30'); assert.equal(h.request(req).pending, true);
  ok(h.offer({ studentId: 'test-b', start: '16:30' }));
  rejected(h.offer({ studentId: 'test-c', start: '16:30' }), 'capacity'); ok(h.request(req));
});

test('pending accept journals block edits, and legacy pending requests resume without client snapshots', () => {
  const h = createSchedulingHarness(); h.approve(); const slot = h.seedSlot();
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), v => v[0][4] === 'booked');
  assert.equal(h.acceptMany([slot.id], 'legacy-pending-retry').pending, true);
  rejected(h.request(request(h, slot)), 'pending');
  ok(h.request({ action: 'acceptMany', k: 'synthetic-link-a', slotIds: [slot.id], requestId: 'legacy-pending-retry' }));
});

test('historical edit replay neither rolls back a later edit nor accepts a changed payload', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), first = request(h, slot); ok(h.request(first));
  const second = request(h, slot, { requestId: 'second-offer-edit', start: '18:00' }); ok(h.request(second));
  const before = saved(h); assert.equal(ok(h.request(first)).replayed, true); assert.deepEqual(saved(h), before);
  rejected(h.request({ ...first, start: '19:00' }), 'conflict'); assert.deepEqual(saved(h), before);
});

test('edit notifications use one stable event key after durable save and warnings do not undo edits', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot), events = new Set(), notices = [];
  const configure = ctx => { ctx.studentEmailNotifyOfferChanged_ = (student, key, before, after) => {
    assert.ok(['pending', 'done'].includes(h.rows('offerEdits')[0].status)); assert.equal(h.snapshot(slot.id).subject, '化学');
    if (!events.has(key)) { events.add(key); notices.push({ before, after }); }
    return { ok: true, recorded: true, status: 'uncertain', warning: 'Synthetic ambiguous notification; do not resend' };
  }; };
  const result = ok(h.requestWith(req, configure)); assert.equal(result.notificationStatus, 'uncertain'); assert.ok(result.notificationWarning);
  ok(h.requestWith(req, configure)); assert.equal(notices.length, 1); assert.equal(events.size, 1);
  assert.equal(notices[0].before.date, slot.date); assert.equal(notices[0].after.subject, '化学');
});

test('an offered mode change uses the same durable change notice and rejects old mode clients', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = h.teacherRequest('setSlotDeliveryMode', {
    studentId: 'test-a', slotId: slot.id, expectedMode: 'in_person', deliveryMode: 'online' });
  rejected(h.request({ ...req, requestId: undefined }), 'conflict');
  let key, calls = 0; const configure = ctx => { ctx.studentEmailNotifyOfferChanged_ = (student, eventKey, before, after) => {
    calls++; assert.equal(before.deliveryMode, 'in_person'); assert.equal(after.deliveryMode, 'online');
    if (key) assert.equal(eventKey, key); key = eventKey; return { ok: true, recorded: true, status: 'sent' };
  }; };
  ok(h.requestWith(req, configure)); assert.equal(ok(h.requestWith(req, configure)).replayed, true);
  assert.equal(calls, 2); assert.equal(h.rows('offerEdits').length, 1);
});

test('an unrecorded notification keeps a reloadable edit while a failed but recorded send does not block it', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot(), req = request(h, slot);
  const first = h.requestWith(req, ctx => { ctx.studentEmailNotifyOfferChanged_ = () => ({ ok: false, recorded: false, status: 'failed', warning: 'Synthetic outbox unavailable' }); });
  assert.equal(first.pending, true); assert.equal(first.saved, true); assert.equal(h.snapshot(slot.id).subject, '化学');
  assert.equal(h.context().schedulingPendingEdits_().length, 1);
  const resumed = ok(h.requestWith(req, ctx => { ctx.studentEmailNotifyOfferChanged_ = () => ({ ok: true, recorded: true, status: 'failed', warning: 'Synthetic quota unavailable' }); }));
  assert.equal(resumed.notificationStatus, 'failed'); assert.ok(resumed.notificationWarning);
  assert.equal(h.context().schedulingPendingEdits_().length, 0);
});

for (const [status, after, expectedMail] of [
  ['pending', false, 1], ['pending', true, 1], ['uncertain', false, 1],
  ['uncertain', true, 0], ['sent', false, 1], ['sent', true, 1]
]) test(`real change outbox recovers ${status} write failure ${after ? 'after' : 'before'} persistence without duplicate mail`, () => {
  const h = createSchedulingHarness(), slot = h.seedSlot({ subject: '' }), req = request(h, slot);
  h.setRow('students', 'id', 'test-a', { email: 'synthetic-student@example.invalid' });
  h.append('studentEmails', { studentId: 'test-a', email: 'synthetic-student@example.invalid', verifiedAt: '2026-09-07T00:00:00.000Z', revision: 1 });
  let mails = 0;
  const configure = ctx => {
    ctx.studentEmailTest_ = () => false; ctx.studentEmailQuota_ = () => 100;
    ctx.studentEmailDeliverMail_ = (student, to, subject, body) => {
      mails++; assert.equal(to, 'synthetic-student@example.invalid'); assert.match(body, /未登録/); assert.match(body, /化学/);
      assert.equal(body.includes('synthetic-link-a'), false); return 'sent';
    };
  };
  failWriteOnce(h.spreadsheet.getSheetByName('studentEmailOutbox'), v => v[0][7] === status, after);
  const first = h.requestWith(req, configure); assert.ok(first.ok || first.saved, JSON.stringify(first));
  const resumed = ok(h.requestWith(req, configure));
  assert.equal(mails, expectedMail); assert.equal(h.rows('studentEmailOutbox').length, 1); assert.equal(h.rows('offerEdits').length, 1);
  assert.equal(h.rows('offerEdits')[0].status, 'done'); assert.equal(h.snapshot(slot.id).subject, '化学');
  if (status === 'uncertain' && after) { assert.equal(resumed.notificationStatus, 'uncertain'); assert.ok(resumed.notificationWarning); }
  ok(h.requestWith(req, configure)); assert.equal(mails, expectedMail);
});
