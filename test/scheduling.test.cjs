'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness, failWriteOnce } = require('./helpers/scheduling-harness.cjs');

function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function reject(result, code) { assert.ok(result.error, JSON.stringify(result)); if (code) assert.equal(result.errorCode, code); return result; }
function data(h) { return ['students', 'slots', 'acceptWrites', 'plans', 'monthAgreements', 'approvalEvents'].map(name => h.rows(name)); }

test('schema preserves legacy values and leaves unknown modes explicitly unset', () => {
  const h = createSchedulingHarness();
  h.setRow('students', 'id', 'test-a', { deliveryMode: '' });
  const slot = h.seedSlot({ deliveryMode: '' }), before = data(h);
  h.context().ensureSchedulingSchema_();
  assert.deepEqual(data(h), before);
  reject(h.offer(), 'deliveryModeRequired');
  h.approve();
  reject(h.accept(slot.id), 'deliveryModeRequired');
});

test('teacher default affects new offers only; lesson override remains independent', () => {
  const h = createSchedulingHarness(), old = h.seedSlot({ date: '2026-09-01', status: 'booked', done: true }), future = h.seedSlot();
  ok(h.admin('setDeliveryMode', { studentId: 'test-a', deliveryMode: 'online' }));
  assert.equal(h.studentRow().deliveryMode, 'online');
  assert.equal(h.rows('slots').find(s => s.id === old.id).deliveryMode, 'in_person');
  assert.equal(h.rows('slots').find(s => s.id === future.id).deliveryMode, 'in_person');
  ok(h.offer({ date: '2026-09-16' }));
  ok(h.offer({ date: '2026-09-17', deliveryMode: 'in_person' }));
  assert.equal(h.rows('slots').find(s => s.date === '2026-09-16').deliveryMode, 'online');
  assert.equal(h.rows('slots').find(s => s.date === '2026-09-17').deliveryMode, 'in_person');
  reject(h.admin('setDeliveryMode', { studentId: 'test-a', deliveryMode: 'hybrid' }));
});

for (const [name, existing, candidate, accepted, code = 'capacity'] of [
  ['two in-person students at the same time', [{ studentId: 'test-b' }], {}, true],
  ['a third in-person student', [{ studentId: 'test-b' }, { studentId: 'test-c' }], { force: true }, false],
  ['a third student joining part way through', [{ studentId: 'test-b', start: '15:30' }, { studentId: 'test-c', start: '16:15' }], {}, false],
  ['online lesson blocks in-person', [{ studentId: 'test-b', deliveryMode: 'online' }], {}, false],
  ['in-person lesson blocks online', [{ studentId: 'test-b' }], { deliveryMode: 'online' }, false],
  ['the same student cannot overlap their own lesson', [{ studentId: 'test-a', start: '15:30' }], {}, false],
  ['end equals start is not an overlap', [{ studentId: 'test-b', start: '15:00', deliveryMode: 'online' }], {}, true],
  ['two sequential others fit one long lesson', [{ studentId: 'test-b', min: 30 }, { studentId: 'test-c', start: '16:30', min: 30 }], {}, true],
  ['cancel-request bookings still hold capacity', [{ studentId: 'test-b', status: 'booked', req: '{"kind":"cancel"}' }, { studentId: 'test-c' }], {}, false],
  ['open unassigned slots do not hold capacity', [{ studentId: '', status: 'open', deliveryMode: '' }], { deliveryMode: 'online' }, true],
  ['unknown overlapping mode blocks acceptance', [{ studentId: 'test-b', deliveryMode: '' }], {}, false, 'deliveryModeRequired'],
  ['unknown non-overlapping mode does not block the day', [{ studentId: 'test-b', deliveryMode: '', start: '18:00' }], {}, true],
  ['blank legacy subject at a distant time does not block new offers', [{ studentId: 'test-b', deliveryMode: 'online', subject: '', start: '08:00', min: 90 }], {}, true],
  ['blank legacy subject still occupies one in-person seat', [{ studentId: 'test-b', subject: '' }], {}, true],
  ['blank legacy subject counts toward the two-person limit', [{ studentId: 'test-b', subject: '' }, { studentId: 'test-c' }], {}, false],
  ['blank legacy subject still blocks overlapping online capacity', [{ studentId: 'test-b', subject: '', deliveryMode: 'online' }], {}, false],
  ['malformed active duration fails closed even with a blank subject', [{ studentId: 'test-b', subject: '', min: 'broken' }], {}, false],
  ['malformed active start fails closed even with a blank subject', [{ studentId: 'test-b', subject: '', start: 'broken' }], {}, false]
]) test(name, () => {
  const h = createSchedulingHarness(); existing.forEach(s => h.seedSlot(s));
  const before = h.rows('slots');
  const result = h.offer(candidate);
  if (accepted) { ok(result); assert.equal(h.rows('slots').length, before.length + 1); }
  else { reject(result, code); assert.deepEqual(h.rows('slots'), before); }
});

test('new lesson candidates still require a valid subject', () => {
  const h = createSchedulingHarness();
  reject(h.offer({ subject: '' }), 'validation');
  assert.deepEqual(h.rows('slots'), []);
  h.approve(); const legacy = h.seedSlot({ subject: '' });
  reject(h.accept(legacy.id), 'validation');
  assert.equal(h.rows('slots')[0].status, 'offered');
});

test('weekly offer validates every occurrence before one write and force cannot bypass capacity', () => {
  const h = createSchedulingHarness();
  h.seedSlot({ studentId: 'test-b', date: '2026-09-22', deliveryMode: 'online' });
  const before = h.rows('slots');
  const res = reject(h.offer({ repeat: 3, force: true }), 'capacity');
  assert.deepEqual(res.conflicts.map(c => c.date), ['2026-09-22']);
  assert.deepEqual(h.rows('slots'), before);
  ok(h.offer({ repeat: 3, start: '18:00' }));
  assert.equal(h.rows('slots').length, before.length + 3);
  assert.ok(h.rows('slots').slice(1).every(s => s.deliveryMode === 'in_person'));
});

test('single confirmation preserves approval gates and refuses an overlapping capacity violation', () => {
  const h = createSchedulingHarness(), slot = h.seedSlot();
  reject(h.accept(slot.id), 'approvalRequired');
  h.approve();
  h.seedSlot({ studentId: 'test-b', deliveryMode: 'online' });
  reject(h.accept(slot.id), 'capacity');
  assert.equal(h.rows('slots')[0].status, 'offered');
});

test('12 selected offers become booked with one final student state and replay does not write again', () => {
  const h = createSchedulingHarness(); h.approve();
  const ids = Array.from({ length: 12 }, (_, i) => h.seedSlot({ date: '2026-09-' + String(i + 10).padStart(2, '0') }).id);
  let stateCalls = 0;
  const req = { action: 'acceptMany', k: 'synthetic-link-a', slotIds: ids, requestId: 'twelve-offer-request', expectedSnapshots: ids.map(h.snapshot) };
  const result = ok(h.requestWith(req, ctx => { const original = ctx.studentState_; ctx.studentState_ = code => { stateCalls++; return original(code); }; }));
  assert.equal(stateCalls, 1); assert.equal(result.completed, 12); assert.equal(result.pending, false);
  assert.equal(result.notification, 'skipped'); assert.ok(result.results.every(r => r.status === 'booked'));
  const before = data(h);
  ok(h.acceptMany(ids.slice().reverse(), 'twelve-offer-request'));
  assert.deepEqual(data(h), before);
  assert.equal(h.effects.filter(e => ['calendar', 'email'].includes(e.kind)).length, 0);
});

test('aggregate monthly limit is validated before any selected booking or journal write', () => {
  const h = createSchedulingHarness(); h.approve({ count: 1 });
  const ids = [h.seedSlot().id, h.seedSlot({ date: '2026-09-16' }).id], before = data(h);
  reject(h.acceptMany(ids), 'planLimit');
  assert.deepEqual(data(h), before);
});

test('invalid selection is atomic, scoped to the student, bounded and cannot reuse a key with changed selection', () => {
  const h = createSchedulingHarness(); h.approve();
  const a = h.seedSlot(), b = h.seedSlot({ date: '2026-09-16', studentId: 'test-b' }), before = data(h);
  for (const ids of [[a.id, b.id], [a.id, a.id], [a.id, 'missing'], [], Array.from({ length: 32 }, (_, i) => 'fake-' + i)]) {
    reject(h.acceptMany(ids)); assert.deepEqual(data(h), before);
  }
  reject(h.acceptMany([a.id], 'bad')); assert.deepEqual(data(h), before);
  ok(h.acceptMany([a.id]));
  reject(h.acceptMany([a.id, b.id]), 'conflict');
});

for (const [label, target, match] of [
  ['initial journal', 'acceptWrites', v => v[0][4] === '[]'],
  ['first booked slot', 'slots', v => v[0][0] === 'first-slot' && v[0][4] === 'booked'],
  ['second booked slot', 'slots', v => v[0][0] === 'second-slot' && v[0][4] === 'booked'],
  ['per-slot receipt', 'acceptWrites', v => v[0][4] === '[{"slotId":"first-slot"}]'],
  ['completed receipt', 'acceptWrites', v => v[0][5] === 'done']
]) for (const after of [false, true]) test(`batch recovers after ${label} interruption ${after ? 'after durable write' : 'before write'}`, () => {
  const h = createSchedulingHarness(); h.approve();
  const ids = [h.seedSlot({ id: 'first-slot' }).id, h.seedSlot({ id: 'second-slot', date: '2026-09-16' }).id];
  failWriteOnce(h.spreadsheet.getSheetByName(target), match, after);
  const first = h.acceptMany(ids);
  assert.ok(first.pending || first.ok, JSON.stringify(first));
  const resumed = ok(h.acceptMany(ids));
  assert.equal(resumed.completed, 2);
  assert.equal(h.rows('slots').filter(s => s.status === 'booked').length, 2);
  assert.equal(h.rows('acceptWrites').length, 1);
  assert.equal(h.rows('acceptWrites')[0].status, 'done');
});

test('pending batch protects its lessons from another key and teacher/student mutations until resumed', () => {
  const h = createSchedulingHarness(); h.approve();
  const first = h.seedSlot(), second = h.seedSlot({ date: '2026-09-16' });
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), v => v[0][0] === second.id && v[0][4] === 'booked');
  assert.equal(h.acceptMany([first.id, second.id]).pending, true);
  reject(h.acceptMany([second.id], 'different-batch-key'), 'pending');
  for (const [op, args] of [
    ['unbook', { slotId: first.id }], ['deleteSlot', { slotId: second.id }],
    ['setSlotDeliveryMode', { slotId: second.id, requestId: 'synthetic-mode-pending', expectedMode: 'in_person', deliveryMode: 'online' }]
  ]) reject(h.admin(op, { studentId: 'test-a', ...args }), 'pending');
  reject(h.request({ action: 'decline', k: 'synthetic-link-a', slotId: second.id }), 'pending');
  ok(h.acceptMany([first.id, second.id]));
});

test('lesson override requires current mode, checks occupancy and keeps completed lesson form fixed', () => {
  const h = createSchedulingHarness(), a = h.seedSlot(), b = h.seedSlot({ studentId: 'test-b' });
  const req = { studentId: 'test-a', slotId: a.id, requestId: 'synthetic-mode-change', expectedMode: 'in_person', deliveryMode: 'online' };
  reject(h.admin('setSlotDeliveryMode', req), 'capacity');
  reject(h.admin('setSlotDeliveryMode', { ...req, expectedMode: '' }), 'conflict');
  reject(h.admin('setSlotDeliveryMode', { ...req, studentId: 'test-b' }), 'notFound');
  h.setRow('slots', 'id', b.id, { status: 'open' });
  ok(h.admin('setSlotDeliveryMode', req));
  assert.equal(h.rows('slots')[0].deliveryMode, 'online');
  h.setRow('slots', 'id', a.id, { status: 'booked', done: true });
  reject(h.admin('setSlotDeliveryMode', { ...req, expectedMode: 'online', deliveryMode: 'in_person' }), 'conflict');
});

test('teacher finish and mark-done use the same occupancy rule', () => {
  const h = createSchedulingHarness(); h.approve();
  const a = h.seedSlot({ date: '2026-09-01' });
  h.seedSlot({ studentId: 'test-b', date: '2026-09-01', deliveryMode: 'online' });
  reject(h.admin('finishOffered', { studentId: 'test-a', slotId: a.id }), 'capacity');
  h.setRow('slots', 'id', a.id, { status: 'booked' });
  reject(h.admin('toggleDone', { studentId: 'test-a', slotId: a.id, done: true }), 'capacity');
  assert.notEqual(h.rows('slots')[0].done, true);
});

test('student state restores only its own pending request without exposing journal internals', () => {
  const h = createSchedulingHarness(); h.approve(); h.approve({ studentId: 'test-b' });
  const a = h.seedSlot(), b = h.seedSlot({ date: '2026-09-16' }), other = h.seedSlot({ date: '2026-09-17', studentId: 'test-b' });
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), values => values[0][0] === b.id && values[0][4] === 'booked');
  assert.equal(h.acceptMany([a.id, b.id], 'pending-student-a').pending, true);
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), values => values[0][0] === other.id && values[0][4] === 'booked');
  assert.equal(h.acceptMany([other.id], 'pending-student-b', { k: 'synthetic-link-b' }).pending, true);
  const stateA = h.get({ action: 'state', k: 'synthetic-link-a' }), stateB = h.get({ action: 'state', k: 'synthetic-link-b' });
  assert.equal(stateA.pendingAccepts.length, 1); assert.equal(stateB.pendingAccepts.length, 1);
  assert.equal(stateA.pendingAccepts[0].requestId, 'pending-student-a');
  assert.deepEqual(stateA.pendingAccepts[0].slotIds, [a.id, b.id].sort());
  assert.deepEqual(Object.keys(stateA.pendingAccepts[0]).sort(), ['requestId', 'slotIds', 'slots']);
  assert.deepEqual(Object.keys(stateA.pendingAccepts[0].slots[0]).sort(), ['date', 'deliveryMode', 'id', 'min', 'start', 'subject']);
  assert.equal(JSON.stringify(stateA).includes('pending-student-b'), false);
  assert.equal(JSON.stringify(stateB).includes('pending-student-a'), false);
  assert.equal(h.get({ action: 'state', k: 'missing-code' }).pendingAccepts, undefined);
  ok(h.acceptMany(stateA.pendingAccepts[0].slotIds, stateA.pendingAccepts[0].requestId));
  assert.deepEqual(h.get({ action: 'state', k: 'synthetic-link-a' }).pendingAccepts, []);
});

test('reload recovers an unfinished receipt even when all selected lessons are already booked', () => {
  const h = createSchedulingHarness(); h.approve(); const a = h.seedSlot();
  const interrupted = h.requestWith({ action: 'acceptMany', k: 'synthetic-link-a', slotIds: [a.id], requestId: 'last-receipt-pending', expectedSnapshots: [h.snapshot(a.id)] }, ctx => {
    const original = ctx.schedulingWrite_;
    ctx.schedulingWrite_ = w => { if (w.status === 'done') throw new Error('Synthetic last receipt unavailable'); return original(w); };
  });
  assert.equal(interrupted.ok, false); assert.equal(interrupted.pending, true);
  assert.equal(h.rows('slots')[0].status, 'booked'); assert.equal(h.rows('acceptWrites')[0].status, 'pending');
  const resumedPage = h.get({ action: 'state', k: 'synthetic-link-a' });
  assert.equal(resumedPage.slots.filter(s => s.st === 'offer').length, 0);
  assert.equal(resumedPage.pendingAccepts.length, 1);
  const request = resumedPage.pendingAccepts[0];
  ok(h.acceptMany(request.slotIds, request.requestId));
  assert.equal(h.rows('acceptWrites')[0].status, 'done');
  assert.deepEqual(h.get({ action: 'state', k: 'synthetic-link-a' }).pendingAccepts, []);
  assert.equal(h.rows('slots').length, 1);
});
