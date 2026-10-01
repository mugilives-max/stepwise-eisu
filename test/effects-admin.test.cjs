'use strict';
// 送れなかった付随処理（メール・カレンダー）を先生が1件ずつ再送・見送りする口（cf/worker/effects-admin.mjs）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, TEACHER_TOKEN } = require('./gas-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

const NOW = Date.parse('2026-10-01T05:00:00Z');
async function fixture() {
  const h = createHarness({ iterations: 10 });
  h.spreadsheet.getSheetByName('slots').appendRow(['slot-online', '2026-10-03', '08:00', 90, 'booked', 'test-a', false, 'stmarker@google.com', '', '化学', '', 'online', '']);
  const p = await createParity(h);
  const env = { DB: p.d1, NL_ENABLED: '0', WRITE_MODE: 'worker', GAS_URL: 'https://gas.example.invalid/exec', SYNC_KEY: 'x'.repeat(30) };
  const add = async (createdAt, kind, status, payload) => p.d1.prepare('insert into _effects (createdAt, kind, payload, status, attempts, error) values (?, ?, ?, ?, 1, ?)')
    .bind(createdAt, kind, JSON.stringify(payload), status, status === 'failed' ? 'Error: 授業記録のシート構成が一致しません' : '').run();
  await add('2026-09-29T02:41:00Z', 'calendarCreate', 'failed', { kind: 'calendarCreate', marker: 'stmarker', body: { id: 'stmarker', summary: '【授業】テストさん 化学 (オンライン)', start: { dateTime: '2026-10-02T23:00:00.000Z', timeZone: 'Asia/Tokyo' } }, wantMeet: true });
  await add('2026-09-29T03:00:00Z', 'mail', 'failed', { kind: 'mail', to: 'student@example.invalid', subject: '【ステップワイズ】授業のご案内', body: '10/3 8:00 化学の授業をご案内します', name: '' });
  await add('2026-09-29T04:00:00Z', 'calendarMeet', 'failed', { kind: 'calendarMeet', eventId: 'stmarker@google.com' });
  await add('2026-09-27T00:00:00Z', 'mail', 'sent', { kind: 'mail', to: 'x@example.invalid', subject: '送信済み', body: '', name: '' });
  await add('2026-10-01T04:58:00Z', 'mail', 'pending', { kind: 'mail', to: 'y@example.invalid', subject: '送信中', body: '', name: '' });
  const { handleEffectsAdmin } = await import('../cf/worker/effects-admin.mjs');
  const call = (op, args = {}, token = TEACHER_TOKEN) => handleEffectsAdmin({ action: 'admin', op, token, ...args }, env, { now: NOW });
  const rows = async () => (await p.d1.prepare('select id, kind, status from _effects order by id').all()).results;
  return { p, env, call, rows };
}
async function withFetch(reply, fn) {
  const original = globalThis.fetch, asked = [];
  globalThis.fetch = async (url, init) => { asked.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => reply }; };
  try { await fn(); } finally { globalThis.fetch = original; }
  return asked;
}

test('the list shows failed mail and calendar work only, newest work in flight and automatic Meet retries excluded', async () => {
  const { call } = await fixture();
  const list = await call('effectsList');
  assert.equal(list.ok, true); assert.equal(list.count, 2);
  assert.deepEqual(list.items.map(x => x.kind), ['calendarCreate', 'mail']);
  assert.deepEqual([list.items[0].label, list.items[0].title, list.items[0].when, list.items[0].meet], ['カレンダーに予定を作る', '【授業】テストさん 化学 (オンライン)', '10/3 08:00', true]);
  assert.deepEqual([list.items[1].to, list.items[1].title], ['student@example.invalid', '【ステップワイズ】授業のご案内']);
  assert.match(list.items[1].preview, /化学の授業/);
  assert.equal((await call('effectsList', { countOnly: true })).items.length, 0, 'count only does not carry contents');
  assert.equal((await call('effectsList', {}, 'wrong-token')).badAuth, true);
  assert.equal((await call('effectsList', {}, 'in1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64))).badAuth, true, 'instructors cannot see it');
});

test('retrying a calendar creation sends the stored request once and writes the Meet link back', async () => {
  const { call, rows, p } = await fixture();
  const list = await call('effectsList'), create = list.items[0];
  let res;
  const asked = await withFetch({ ok: true, writebacks: [{ marker: 'stmarker', eventId: 'stmarker@google.com', meetUrl: 'https://meet.example.invalid/abc' }] }, async () => { res = await call('effectRetry', { id: create.id }); });
  assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].items.map(i => [i.kind, i.marker]), [['calendarCreate', 'stmarker']]);
  assert.equal((await rows()).find(r => r.id === create.id).status, 'sent');
  assert.equal((await p.d1.prepare("select meetUrl from slots where id = 'slot-online'").first()).meetUrl, 'https://meet.example.invalid/abc');
  assert.equal((await call('effectRetry', { id: create.id })).errorCode, 'conflict', 'a sent item is not sent again');
  assert.equal((await call('effectsList')).count, 1);
});

test('a failed retry stays in the list with the new error, and dismissing removes an item without sending it', async () => {
  const { call, rows } = await fixture();
  const mail = (await call('effectsList')).items[1];
  let res;
  await withFetch({ error: 'Apps Script が止まっています' }, async () => { res = await call('effectRetry', { id: mail.id }); });
  assert.equal(res.errorCode, 'upstream'); assert.match(res.error, /Apps Script が止まっています/);
  assert.equal((await call('effectsList')).items.find(x => x.id === mail.id).error, 'Apps Script が止まっています');
  const asked = await withFetch({ ok: true }, async () => { res = await call('effectDismiss', { id: mail.id }); });
  assert.equal(res.ok, true); assert.equal(asked.length, 0, 'dismissing sends nothing');
  assert.equal((await rows()).find(r => r.id === mail.id).status, 'dismissed');
  assert.equal((await call('effectsList')).count, 1);
  const meet = (await rows()).find(r => r.kind === 'calendarMeet');
  assert.equal((await call('effectRetry', { id: meet.id })).errorCode, 'notFound', 'automatic Meet retries are not handled here');
});

test('the Meet backfill query avoids LIKE patterns that D1 rejects for long event IDs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cf', 'worker', 'write.mjs'), 'utf8');
  assert.match(src, /instr\(e\.payload, s\.eventId\) > 0/);
  assert.doesNotMatch(src, /like '%' \|\| s\.eventId/);
  const index = fs.readFileSync(path.join(__dirname, '..', 'cf', 'worker', 'index.mjs'), 'utf8');
  assert.match(index, /EFFECT_ADMIN_OPS\.indexOf\(String\(body\.op \|\| ""\)\) >= 0/);
});

test('the send log lists mail newest first with status, filters by kind and status, and pages by 50', async () => {
  const { call, p } = await fixture();
  let log = await call('effectsLog');
  assert.equal(log.ok, true); assert.equal(log.kind, 'mail');
  assert.deepEqual(log.items.map(x => [x.title, x.status]), [['送信中', 'pending'], ['送信済み', 'sent'], ['【ステップワイズ】授業のご案内', 'failed']]);
  log = await call('effectsLog', { status: 'sent' });
  assert.deepEqual(log.items.map(x => x.title), ['送信済み']);
  log = await call('effectsLog', { kind: 'calendar', status: 'problem' });
  assert.deepEqual(log.items.map(x => x.kind), ['calendarCreate'], 'automatic Meet retries are not part of the log');
  for (let i = 0; i < 55; i++) await p.d1.prepare("insert into _effects (createdAt, kind, payload, status, sentAt) values (?, 'mail', ?, 'sent', ?)").bind('2026-09-30T00:00:00Z', JSON.stringify({ kind: 'mail', to: 't@example.invalid', subject: '件名' + i, body: '' }), '2026-09-30T00:00:05Z').run();
  const first = await call('effectsLog', { status: 'sent' });
  assert.equal(first.items.length, 50); assert.equal(first.more, true); assert.equal(first.items[0].title, '件名54');
  const second = await call('effectsLog', { status: 'sent', before: first.next });
  assert.equal(second.items.length, 6); assert.equal(second.more, false); assert.equal(second.items.at(-1).title, '送信済み');
  assert.equal((await call('effectsLog', {}, 'wrong-token')).badAuth, true);
});
