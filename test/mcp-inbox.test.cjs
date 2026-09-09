'use strict';

// MCP 連絡欄の処理(mcpInboxList / mcpInboxClaim / 登録 op の紐づけ / mcpInboxResolve)のローカル検証。
// 設計: docs/MCP_DESIGN.md「連絡欄の定期処理への引き継ぎ」。本番の Google サービスは使わない。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const { MCP_KEY } = require('./gas-harness.cjs');

function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); return r; }
let seq = 0;
function harness() {
  const h = createSchedulingHarness();
  return Object.assign(h, {
    mcp: (op, args = {}) => h.request({ action: 'admin', mcpKey: MCP_KEY, client: 'synthetic-test', requestId: 'req-' + (++seq), op, ...args }),
    send: (args = {}) => ok(h.request({ action: 'learningService', op: 'messageSend', k: 'synthetic-link-a', requestId: 'msg-req-' + (++seq), category: 'schedule', body: '来週火曜と木曜の17時から希望です', ...args })).message,
    journal: () => h.rows('contactProcessing'),
    messages: () => h.rows('contactMessages'),
  });
}

test('inbox lists received messages with JST receipt time, thread and claim state', () => {
  const h = harness();
  const m = h.send();
  const fix = h.send({ replyTo: m.id, body: '訂正: 水曜ではなく木曜です' });
  h.send({ k: 'synthetic-link-b', body: '質問です', category: 'question' });
  const list = ok(h.mcp('mcpInboxList'));
  assert.equal(list.messages.length, 3);
  const first = list.messages[0];
  assert.equal(first.messageId, m.id);
  assert.equal(first.student.name, '【テスト】保護者認証A');
  assert.match(first.receivedAtJst, /^2026-09-07 13:00\(月\)$/);
  assert.equal(first.thread.length, 1);
  assert.equal(first.thread[0].messageId, fix.id);
  assert.equal(first.claim, null);
  assert.equal(list.counts.received, 3);
  assert.equal(ok(h.mcp('mcpInboxList', { studentId: 'test-b' })).messages.length, 1);
  assert.equal(ok(h.mcp('mcpInboxList', { statuses: ['closed'] })).messages.length, 0);
  assert.ok(!JSON.stringify(list).includes('synthetic-link'));
});

test('claim is exclusive per message, replayable per processId, and expires', () => {
  const h = harness();
  const m = h.send();
  const c1 = ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000001' }));
  assert.equal(c1.claim.status, 'processing');
  assert.equal(c1.claim.claimedRevision, 1);
  assert.ok(Array.isArray(c1.rules) && c1.rules.length >= 4);
  const other = h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000002' });
  assert.equal(other.errorCode, 'claimed');
  const replay = ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000001' }));
  assert.equal(replay.replayed, true);
  assert.equal(h.journal().length, 1);
  assert.equal(ok(h.mcp('mcpInboxList')).messages[0].claim.processId, 'proc-000001');
  assert.equal(h.mcp('mcpInboxClaim', { messageId: 'nope', processId: 'proc-000003' }).errorCode, 'notFound');
  assert.equal(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'x' }).errorCode, 'validation');
  h.advance(16 * 60 * 1000);
  ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000002' }));
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000001', status: 'closed' }).errorCode, 'claimExpired');
});

test('write ops linked to a message require the claim, keep the student fixed, and are journaled', () => {
  const h = harness();
  const m = h.send();
  const args = { studentId: 'test-a', subject: '数学', start: '17:00', min: 60, items: [{ date: '2026-09-15' }, { date: '2026-09-17' }] };
  assert.equal(h.mcp('mcpOfferLessons', { ...args, messageId: m.id, processId: 'proc-000010' }).errorCode, 'claimRequired');
  ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000010' }));
  assert.equal(h.mcp('mcpOfferLessons', { ...args, studentId: 'test-b', messageId: m.id, processId: 'proc-000010' }).errorCode, 'studentMismatch');
  assert.equal(h.mcp('mcpAddStudentNg', { studentId: 'test-b', items: [{ date: '2026-09-20' }], messageId: m.id, processId: 'proc-000010' }).errorCode, 'studentMismatch');
  assert.equal(h.rows('slots').length, 0);
  const wish = ok(h.mcp('mcpAddStudentWishes', { studentId: 'test-a', kind: 'want', start: '17:00', min: 60, dates: ['2026-09-15', '2026-09-17'], note: 'AI: 連絡欄より', messageId: m.id, processId: 'proc-000010' }));
  assert.equal(wish.added, 2);
  const failed = h.mcp('mcpOfferLessons', { ...args, items: [{ date: '2026-02-30' }], messageId: m.id, processId: 'proc-000010' });
  ok(failed); // invalid item -> ok with per-item result, added 0
  const items = JSON.parse(h.journal()[0].itemsJson);
  assert.equal(items.length, 4, 'refusals are journaled too (audit)');
  assert.equal(items[0].error && items[1].error && true, true);
  assert.equal(items[2].op, 'mcpAddStudentWishes');
  assert.equal(items[2].added, 2);
  assert.deepEqual(items[2].results.map(r => r.status), ['available', 'available']);
  assert.equal(items[3].added, 0);
  // 連絡に紐づかない通常の登録は従来どおり(ジャーナルに入らない)
  ok(h.mcp('mcpAddStudentNg', { studentId: 'test-a', items: [{ date: '2026-09-21' }] }));
  assert.equal(JSON.parse(h.journal()[0].itemsJson).length, 4);
});

test('resolve: registered needs a real write, reply is mandatory, message status and journal are updated', () => {
  const h = harness();
  const m = h.send();
  ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000020' }));
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'registered', reply: '登録しました' }).errorCode, 'noWrite');
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'needs_confirmation', reply: '' }).errorCode, 'validation');
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'bogus', reply: 'x' }).errorCode, 'validation');
  // dry run だけでは registered にならない
  ok(h.mcp('mcpAddStudentWishes', { studentId: 'test-a', kind: 'want', start: '17:00', min: 60, dates: ['2026-09-15'], dryRun: true, messageId: m.id, processId: 'proc-000020' }));
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'registered', reply: '登録しました' }).errorCode, 'noWrite');
  ok(h.mcp('mcpAddStudentWishes', { studentId: 'test-a', kind: 'want', start: '17:00', min: 60, dates: ['2026-09-15', '2026-09-17'], messageId: m.id, processId: 'proc-000020' }));
  const done = ok(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'registered', reply: '9/15(火)・9/17(木) 17:00〜18:00 の希望として登録しました。先生が案内を作ると通知が届きます', note: 'want 2件' }));
  assert.equal(done.status, 'registered');
  assert.equal(done.revision, 2);
  const row = h.messages()[0];
  assert.equal(row.status, 'registered');
  assert.match(row.reply, /9\/15/);
  assert.equal(Number(row.revision), 2);
  const j = h.journal()[0];
  assert.equal(j.status, 'done');
  assert.match(j.summary, /"writes":1/);
  // 再送は replayed、処理済みの再 claim は state エラー
  assert.equal(ok(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000020', status: 'registered', reply: 'x' })).replayed, true);
  assert.equal(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000021' }).errorCode, 'state');
  assert.ok(h.rows('log').some(l => /MCP\(synthetic-test\)が.*連絡を処理: registered/.test(String(l.message))));
  // 生徒側からも返信が見える
  const pub = ok(h.request({ action: 'learningService', op: 'list', k: 'synthetic-link-a' }));
  assert.equal(pub.messages[0].status, 'registered');
});

test('teacher reply during processing yields a conflict; release frees the claim; needs_confirmation stays claimable', () => {
  const h = harness();
  const m = h.send({ body: '夕方に授業をお願いします' });
  ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000030' }));
  ok(h.admin('serviceMessageReply', { studentId: 'test-a', id: m.id, expectedRevision: 1, status: 'needs_confirmation', reply: '何時ごろですか?' }));
  const c = h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000030', status: 'needs_confirmation', reply: '何日ですか' });
  assert.equal(c.errorCode, 'conflict');
  assert.equal(c.message.revision, 2);
  ok(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000030', status: 'released', note: '先生が対応済み' }));
  assert.equal(h.journal()[0].status, 'released');
  assert.equal(h.messages()[0].status, 'needs_confirmation');
  // needs_confirmation の連絡は再度 claim できる(利用者の訂正を待って処理するため)
  const again = ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000031' }));
  assert.equal(again.claim.claimedRevision, 2);
  ok(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000031', status: 'needs_confirmation', reply: '何日の夕方でしょうか。候補日を教えてください' }));
  assert.equal(Number(h.messages()[0].revision), 3);
});

test('closed without reply is allowed; failed requires reply; scope restricts real students', () => {
  const h = harness();
  const m = h.send({ category: 'question', body: 'ありがとうございました' });
  ok(h.mcp('mcpInboxClaim', { messageId: m.id, processId: 'proc-000040' }));
  ok(h.mcp('mcpInboxResolve', { messageId: m.id, processId: 'proc-000040', status: 'closed' }));
  assert.equal(h.messages()[0].status, 'closed');
  const m2 = h.send({ body: '登録お願いします' });
  ok(h.mcp('mcpInboxClaim', { messageId: m2.id, processId: 'proc-000041' }));
  assert.equal(h.mcp('mcpInboxResolve', { messageId: m2.id, processId: 'proc-000041', status: 'failed' }).errorCode, 'validation');
  ok(h.mcp('mcpInboxResolve', { messageId: m2.id, processId: 'proc-000041', status: 'failed', reply: '満員のため登録できませんでした' }));
  h.append('students', { id: 'real-x', name: '架空 実生徒', active: true, code: 'synthetic-link-x', rate30: 1500, deliveryMode: 'in_person' });
  const real = ok(h.request({ action: 'learningService', op: 'messageSend', k: 'synthetic-link-x', requestId: 'msg-real-1', category: 'schedule', body: 'test' })).message;
  assert.equal(h.mcp('mcpInboxClaim', { messageId: real.id, processId: 'proc-000042' }).errorCode, 'scope');
  assert.equal(ok(h.mcp('mcpInboxList')).messages.some(x => x.messageId === real.id), true, 'reads are not scoped');
  h.context().mcpEnableWrites();
  ok(h.mcp('mcpInboxClaim', { messageId: real.id, processId: 'proc-000042' }));
  assert.ok(!JSON.stringify(h.mcp('mcpInboxList')).includes('synthetic-link'));
});
