'use strict';

// MCP 更新系(mcpOfferLessons / mcpAddTeacherOff / mcpAddStudentNg / mcpAddStudentWishes)のローカル検証。
// 本番の Google サービスは使わない(gas-harness の疑似サービス)。設計: docs/MCP_DESIGN.md「2026-09-08合意」
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const { MCP_KEY } = require('./gas-harness.cjs');

function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function statuses(result) { return result.results.map(r => r.status); }
function harness() {
  const h = createSchedulingHarness();
  return Object.assign(h, {
    mcp: (op, args = {}) => h.request({ action: 'admin', mcpKey: MCP_KEY, client: 'synthetic-test', requestId: 'req-' + Math.random().toString(36).slice(2), op, ...args }),
    props: () => h.context().PropertiesService.getScriptProperties(),
  });
}
const DATES = ['2026-09-15', '2026-09-22', '2026-09-29'];
const offerArgs = { studentId: 'test-a', subject: '数学', start: '16:00', min: 60, items: DATES.map(date => ({ date })) };

test('ping reports write ops and the default test-only scope', () => {
  const h = harness();
  const ping = ok(h.mcp('mcpPing'));
  assert.deepEqual(ping.writeOps, ['mcpOfferLessons', 'mcpAddTeacherOff', 'mcpAddStudentNg', 'mcpAddStudentWishes']);
  assert.equal(ping.writeScope, 'test');
});

test('offer batch registers each date once; resending reports exists and adds nothing', () => {
  const h = harness();
  const first = ok(h.mcp('mcpOfferLessons', offerArgs));
  assert.deepEqual(statuses(first), ['added', 'added', 'added']);
  assert.equal(first.added, 3);
  assert.equal(first.notificationStatus, 'skipped', 'test student without verified email: no mail');
  const slots = h.rows('slots').filter(s => s.studentId === 'test-a');
  assert.equal(slots.length, 3);
  assert.ok(slots.every(s => s.status === 'offered' && s.deliveryMode === 'in_person' && s.subject === '数学'));
  const again = ok(h.mcp('mcpOfferLessons', offerArgs));
  assert.deepEqual(statuses(again), ['exists', 'exists', 'exists']);
  assert.equal(again.added, 0);
  assert.equal(h.rows('slots').filter(s => s.studentId === 'test-a').length, 3);
  assert.equal(h.effects.filter(e => e.kind === 'email').length, 0);
  const log = h.rows('mcpLog');
  assert.ok(log.length >= 2 && log.every(l => l.op === 'mcpOfferLessons' && l.client === 'synthetic-test' && l.requestId));
  assert.ok(!JSON.stringify(log).includes(MCP_KEY));
});

test('dry run evaluates without writing', () => {
  const h = harness();
  const preview = ok(h.mcp('mcpOfferLessons', { ...offerArgs, dryRun: true }));
  assert.deepEqual(statuses(preview), ['wouldAdd', 'wouldAdd', 'wouldAdd']);
  assert.equal(preview.added, 0);
  assert.equal(h.rows('slots').length, 0);
});

test('partial failure: capacity conflicts are reported per item while other dates are registered', () => {
  const h = harness();
  h.seedSlot({ studentId: 'test-b', date: '2026-09-22', status: 'booked' });
  h.seedSlot({ studentId: 'test-c', date: '2026-09-22', status: 'offered' });
  const r = ok(h.mcp('mcpOfferLessons', offerArgs));
  assert.deepEqual(statuses(r), ['added', 'conflict', 'added']);
  assert.equal(r.results[1].code, 'capacity');
  assert.equal(h.rows('slots').filter(s => s.studentId === 'test-a').length, 2);
  // 再送: 残りの1件だけが対象のまま(成功分は exists)
  const retry = ok(h.mcp('mcpOfferLessons', offerArgs));
  assert.deepEqual(statuses(retry), ['exists', 'conflict', 'exists']);
});

test('student NG and teacher off need force; online mode is honoured per request', () => {
  const h = harness();
  h.append('blocked', { id: 'ng-1', studentId: 'test-a', date: '2026-09-22', note: '大会', start: '', end: '' });
  const r = ok(h.mcp('mcpOfferLessons', offerArgs));
  assert.deepEqual(statuses(r), ['added', 'needsConfirm', 'added']);
  assert.match(r.results[1].reason, /授業できない日時/);
  const forced = ok(h.mcp('mcpOfferLessons', { ...offerArgs, force: true }));
  assert.deepEqual(statuses(forced), ['exists', 'added', 'exists']);
  const online = ok(h.mcp('mcpOfferLessons', { studentId: 'test-b', subject: '英語', start: '18:00', min: 90, deliveryMode: 'online', items: [{ date: '2026-09-16' }] }));
  assert.equal(online.results[0].status, 'added');
  assert.equal(h.rows('slots').find(s => s.studentId === 'test-b').deliveryMode, 'online');
  // オンラインは同時間帯に他の授業を置けない
  const clash = ok(h.mcp('mcpOfferLessons', { studentId: 'test-c', subject: '英語', start: '18:30', min: 60, items: [{ date: '2026-09-16' }] }));
  assert.equal(clash.results[0].status, 'conflict');
});

test('invalid items are rejected individually', () => {
  const h = harness();
  const r = ok(h.mcp('mcpOfferLessons', { studentId: 'test-a', subject: '数学', start: '16:00', min: 60,
    items: [{ date: '2026-02-30' }, { date: '2026-09-01' }, { date: '2026-09-15', start: '25:00' }, { date: '2026-09-15' }, { date: '2026-09-15' }] }));
  assert.deepEqual(statuses(r), ['invalid', 'invalid', 'invalid', 'added', 'duplicate']);
  assert.equal(h.rows('slots').length, 1);
  assert.ok(h.mcp('mcpOfferLessons', { studentId: 'test-a', items: [] }).error);
  assert.equal(h.mcp('mcpOfferLessons', { studentId: 'nobody', items: [{ date: '2026-09-15' }] }).errorCode, 'notFound');
});

test('teacher off: all-day and time ranges, duplicates, affected lessons', () => {
  const h = harness();
  h.context().mcpEnableWrites(); // 先生の休みは生徒に紐づかないため scope=all が必要
  const slot = h.seedSlot({ studentId: 'test-a', date: '2026-09-20', start: '15:00', status: 'booked' });
  const r = ok(h.mcp('mcpAddTeacherOff', { items: [
    { date: '2026-09-20' }, { date: '2026-09-21', start: '13:00', end: '17:00', note: '学会' }, { date: '2026-09-21', start: '13:00', end: '17:00' },
    { date: '2026-09-22', start: '17:00' }, { date: '2026-09-01' }
  ] }));
  assert.deepEqual(statuses(r), ['added', 'added', 'duplicate', 'invalid', 'invalid']);
  assert.equal(r.results[0].affectedLessons.length, 1);
  assert.equal(r.results[0].affectedLessons[0].slotId, slot.id);
  assert.equal(r.results[0].affectedLessons[0].student.name, '【テスト】保護者認証A');
  const rows = h.rows('teacherOff');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].note, '学会');
  const again = ok(h.mcp('mcpAddTeacherOff', { items: [{ date: '2026-09-20', start: '10:00', end: '12:00' }, { date: '2026-09-21', start: '13:00', end: '17:00' }] }));
  assert.deepEqual(statuses(again), ['exists', 'exists'], 'all-day covers ranges; identical range is a duplicate');
  assert.equal(h.rows('teacherOff').length, 2);
});

test('student NG proxy registration dedupes and keeps the note', () => {
  const h = harness();
  const r = ok(h.mcp('mcpAddStudentNg', { studentId: 'test-a', note: 'LINE連絡(9/8)', items: [
    { date: '2026-09-18', start: '09:00', end: '17:00' }, { date: '2026-09-19' }, { date: '2026-09-19', start: '10:00', end: '11:00' }
  ] }));
  assert.deepEqual(statuses(r), ['added', 'added', 'exists'], 'an all-day entry covers a later time range on the same day');
  const rows = h.rows('blocked').filter(b => b.studentId === 'test-a');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(b => b.note === 'LINE連絡(9/8)'));
  const again = ok(h.mcp('mcpAddStudentNg', { studentId: 'test-a', items: [{ date: '2026-09-18', start: '09:00', end: '17:00' }, { date: '2026-09-19', start: '13:00', end: '14:00' }] }));
  assert.deepEqual(statuses(again), ['exists', 'exists']);
  assert.equal(h.rows('blocked').filter(b => b.studentId === 'test-a').length, 2);
  // 登録後に案内しようとすると needsConfirm になる(画面と同じ検証)
  const offer = ok(h.mcp('mcpOfferLessons', { studentId: 'test-a', subject: '数学', start: '10:00', min: 60, items: [{ date: '2026-09-18' }] }));
  assert.equal(offer.results[0].status, 'needsConfirm');
});

test('student wishes proxy: availability recorded, replay is idempotent, teacher mail suppressed', () => {
  const h = harness();
  h.setRow('config', 'key', 'emailNotify', { value: 'on' });
  h.append('students', { id: 'real-x', name: '架空 実生徒', active: true, code: 'synthetic-link-x', rate30: 1500, deliveryMode: 'in_person' });
  h.props().setProperty('MCP_WRITE_SCOPE', 'all');
  // 9/22 16:00 を満員にしておく(対面2人)
  h.seedSlot({ studentId: 'test-b', date: '2026-09-22', status: 'booked' });
  h.seedSlot({ studentId: 'test-c', date: '2026-09-22', status: 'booked' });
  const r = ok(h.mcp('mcpAddStudentWishes', { studentId: 'real-x', kind: 'want', start: '16:00', min: 60, dates: ['2026-09-15', '2026-09-22'], note: 'LINE連絡' }));
  assert.deepEqual(r.days.map(d => d.status), ['available', 'full']);
  assert.equal(r.added, 2);
  const wishes = h.rows('wishes');
  assert.equal(wishes.length, 2);
  assert.deepEqual(wishes.map(w => w.availability), ['available', 'full']);
  assert.equal(wishes[0].kind, 'want');
  const replay = ok(h.mcp('mcpAddStudentWishes', { studentId: 'real-x', kind: 'want', start: '16:00', min: 60, dates: ['2026-09-15', '2026-09-22'], note: 'LINE連絡' }));
  assert.equal(replay.replayed, true);
  assert.equal(h.rows('wishes').length, 2);
  // 代理登録では先生宛ての希望メールを送らない(送ろうとすると疑似 MailApp が失敗ログを残す)
  assert.equal(h.effects.filter(e => e.kind === 'email').length, 0);
  assert.ok(!h.rows('log').some(l => String(l.message).includes('メール通知に失敗')));
  // 生徒本人の登録では従来どおり通知を試みる(疑似環境では失敗としてログに残る)
  h.request({ action: 'wish', k: 'synthetic-link-x', kind: 'want', date: '2026-09-29', start: '16:00', min: 60 });
  assert.equal(h.effects.filter(e => e.kind === 'email').length, 1);
  const okKind = ok(h.mcp('mcpAddStudentWishes', { studentId: 'real-x', kind: 'ok', start: '13:00', end: '18:00', dates: ['2026-09-16'] }));
  assert.equal(okKind.end, '18:00');
  assert.equal(h.mcp('mcpAddStudentWishes', { studentId: 'real-x', kind: 'want', start: '16:00', min: 60, dates: [] }).errorCode, 'validation');
  assert.ok(h.mcp('mcpAddStudentWishes', { studentId: 'real-x', kind: 'want', start: '16:00', min: 60, dates: ['2026-09-15'], note: '別のメモ' }).error, 'same time with different note is refused');
  assert.ok(!JSON.stringify([r, replay, okKind]).includes('synthetic-link'), 'student link code never leaves GAS');
});

test('write scope: real students are refused until mcpEnableWrites; reads unaffected', () => {
  const h = harness();
  h.append('students', { id: 'real-x', name: '架空 実生徒', active: true, code: 'synthetic-link-x', rate30: 1500, deliveryMode: 'in_person' });
  const refused = h.mcp('mcpOfferLessons', { studentId: 'real-x', subject: '数学', start: '16:00', min: 60, items: [{ date: '2026-09-15' }] });
  assert.equal(refused.errorCode, 'scope');
  assert.equal(h.mcp('mcpAddTeacherOff', { items: [{ date: '2026-09-20' }] }).errorCode, 'scope');
  assert.equal(h.mcp('mcpAddStudentNg', { studentId: 'real-x', items: [{ date: '2026-09-20' }] }).errorCode, 'scope');
  assert.equal(h.rows('slots').length + h.rows('teacherOff').length + h.rows('blocked').length, 0);
  ok(h.mcp('mcpOfferLessons', { studentId: 'test-a', subject: '数学', start: '16:00', min: 60, items: [{ date: '2026-09-15' }] }));
  ok(h.mcp('mcpSchedule', {}));
  h.context().mcpEnableWrites();
  assert.equal(h.mcp('mcpPing').writeScope, 'all');
  ok(h.mcp('mcpAddTeacherOff', { items: [{ date: '2026-09-20' }] }));
  ok(h.mcp('mcpOfferLessons', { studentId: 'real-x', subject: '数学', start: '17:00', min: 60, items: [{ date: '2026-09-15' }] }));
  h.context().mcpRestrictWritesToTest();
  assert.equal(h.mcp('mcpPing').writeScope, 'test');
  assert.equal(h.mcp('mcpAddTeacherOff', { items: [{ date: '2026-09-21' }] }).errorCode, 'scope');
  // 許可リスト外の更新 op は従来どおり拒否
  assert.match(h.mcp('deleteSlot', { slotId: 'x' }).error, /MCP から実行できません/);
  assert.match(h.mcp('addStudent', { name: 'x' }).error, /MCP から実行できません/);
});

test('invoice-locked month blocks new offers like the admin screen', () => {
  const h = harness();
  h.approve();
  h.seedSlot({ date: '2026-09-01', min: 90, status: 'booked', done: true });
  const invoice = h.admin('kanriAddPayment', { studentId: 'test-a', ym: '2026-09', requestId: 'synthetic-invoice-1' });
  assert.equal(invoice.ok, true, JSON.stringify(invoice));
  const r = ok(h.mcp('mcpOfferLessons', { studentId: 'test-a', subject: '数学', start: '18:00', min: 60, items: [{ date: '2026-09-23' }, { date: '2026-10-07' }] }));
  assert.equal(r.results[0].status, 'conflict');
  assert.equal(r.results[0].code, 'invoiceLocked');
  assert.equal(r.results[1].status, 'added');
});
