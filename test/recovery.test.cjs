'use strict';

// 一括確定が途中で止まったあとの立て直し。
//
// 本番で起きたこと（2026-09-22）: Worker のカレンダー模擬実装が誤っていたため確定が失敗し、
// acceptWrites に status='pending' の記録だけが残った。記録が残っている間、その日時は
// 先生側から変更できず（schedulingPendingSlotMutation_）、生徒側は「同じ処理を再試行」
// でしか進めない。つまり再試行が通ることが、唯一の出口になっている。
//
// ここでは (1) 止まった記録からの再試行が最後まで通ること、(2) 対面の授業でカレンダーの
// 予定が作られること（＝あの不具合の再発を捕まえる）を、合成台帳の上で確かめる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const K = 'synthetic-link-a';
const REQUEST_ID = 'stuck-request-0001';

// 案内が 1 件出ていて、その確定が途中で止まっている台帳を作る
async function stuckLedger() {
  const h = createBillingHarness();
  // 【テスト】で始まる名前だとカレンダーも通知も意図的に抑止される。
  // カレンダーの不具合を捕まえたいので、合成台帳の中だけ名前を変える（実在の生徒ではない）
  h.setRow('students', 'id', 'test-a', { name: '見本の生徒' });
  h.setRow('config', 'key', 'calendarSync', { value: 'on' });
  const slot = h.seedSlot({ date: '2026-09-23', start: '17:00', min: 90, subject: '英語', status: 'offered' });
  // schedulingSnapshot_ と同じ形・同じ並びでないと「途中で案内が変わった」と判定される
  const snapshot = { id: String(slot.id), studentId: 'test-a', date: slot.date, start: slot.start, min: Number(slot.min), subject: slot.subject, deliveryMode: slot.deliveryMode };
  h.context().sheet_('acceptWrites').appendRow([
    'stuck-journal-0001', 'test-a', REQUEST_ID, JSON.stringify([snapshot]), '[]',
    'pending', 'pending', new Date(h.now()).toISOString(), new Date(h.now()).toISOString(), '一括確定の途中です。同じ選択で再送してください',
  ]);
  const p = await createParity(h);
  return { h, p, slot, env: { ...p.env, WRITE_MODE: 'worker' } };
}

test('止まった記録が残っていると、その日時は先生側から変えられない', async () => {
  const { h, slot } = await stuckLedger();
  const { TEACHER_TOKEN } = require('./gas-harness.cjs');
  const r = h.request({ action: 'admin', op: 'deleteSlot', token: TEACHER_TOKEN, slotId: slot.id });
  assert.match(String(r.error || ''), /一括確定を処理中/, '止まった記録が取消を止めていない: ' + JSON.stringify(r).slice(0, 160));
});

test('止まった記録は、生徒の「同じ処理を再試行」で最後まで通る', async () => {
  const { p, slot, env } = await stuckLedger();
  const { runWrite } = await import('../cf/worker/write.mjs');

  // 画面が再試行で送る形。記録がすでにあるので expectedSnapshots は付かない
  const out = await runWrite({ action: 'acceptMany', k: K, slotIds: [slot.id], requestId: REQUEST_ID }, env, { now: p.source.now() });
  assert.ok(out.result.ok, '再試行が通らない: ' + JSON.stringify(out.result).slice(0, 220));
  assert.equal(out.result.pending, false, '再試行のあとも未完了のまま');

  const after = await p.d1.prepare('select status, eventId from slots where id = ?').bind(String(slot.id)).first();
  assert.equal(after.status, 'booked', '授業が確定していない');
  assert.ok(String(after.eventId || ''), 'カレンダーの予定 ID が入っていない（不具合の再発）');

  const journal = await p.d1.prepare('select status, completedJson from acceptWrites where requestId = ?').bind(REQUEST_ID).first();
  assert.equal(journal.status, 'done', '記録が done になっていない（先生側の取消が塞がれたまま）');
  assert.deepEqual(JSON.parse(journal.completedJson).map(c => c.slotId), [String(slot.id)]);
});

test('立て直したあとは、先生側の取消もできるようになる', async () => {
  const { p, slot, env } = await stuckLedger();
  const { runWrite } = await import('../cf/worker/write.mjs');
  await runWrite({ action: 'acceptMany', k: K, slotIds: [slot.id], requestId: REQUEST_ID }, env, { now: p.source.now() });
  const { handleRead } = await import('../cf/worker/read.mjs');
  const state = await handleRead({ action: 'state', k: K }, env, { now: p.source.now() });
  assert.deepEqual(state.pendingAccepts || [], [], '画面にまだ未完了の確定処理が出ている');
});

test('対面の授業の確定で、カレンダーの予定が控えに積まれる', async () => {
  const { p, slot, env } = await stuckLedger();
  const { runWrite } = await import('../cf/worker/write.mjs');
  const out = await runWrite({ action: 'acceptMany', k: K, slotIds: [slot.id], requestId: REQUEST_ID }, env, { now: p.source.now() });
  const created = out.effects.filter(e => e.kind === 'calendarCreate');
  assert.equal(created.length, 1, 'カレンダーの予定が控えに積まれていない: ' + JSON.stringify(out.effects.map(e => e.kind)));
  assert.equal(created[0].wantMeet, false, '対面なのに会議室を作ろうとしている');
});

test('カレンダーの本物の ID が、確定した授業に書き戻される', async () => {
  const { p, slot, env } = await stuckLedger();
  const { runWrite, recordEffects, deliverEffects } = await import('../cf/worker/write.mjs');
  const out = await runWrite({ action: 'acceptMany', k: K, slotIds: [slot.id], requestId: REQUEST_ID }, env, { now: p.source.now() });

  // 台帳に入るのは iCalUID の形（<marker>@google.com）。Apps Script が返す marker は素の ID で、
  // 形が違う。ここが合っていないと書き戻しが黙って空振りする（本番で実際に起きた）
  const marker = out.effects.find(e => e.kind === 'calendarCreate').marker;
  const before = await p.d1.prepare('select eventId from slots where id = ?').bind(String(slot.id)).first();
  assert.notEqual(before.eventId, marker, '前提が変わった（台帳の ID と marker が同じ形になった）');

  // Apps Script の代わりに、本物の予定を作った体で応答を返す
  const real = 'real-event-0001@google.com';
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, done: 1, writebacks: [{ marker: marker, eventId: real, meetUrl: '' }], failed: [] }) });
  try {
    const ids = await recordEffects(p.d1, out.effects);
    const sent = await deliverEffects({ ...env, GAS_URL: 'https://example.invalid/exec', SYNC_KEY: 'k' }, out.effects, ids);
    assert.equal(sent.writebacks, 1, '書き戻しが届いていない');
  } finally { globalThis.fetch = saved; }

  const after = await p.d1.prepare('select eventId from slots where id = ?').bind(String(slot.id)).first();
  assert.equal(after.eventId, real, 'カレンダーの本物の ID に置き換わっていない（書き戻しの空振り）');
});
