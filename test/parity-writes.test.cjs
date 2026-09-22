'use strict';

// 書き込みの並走テスト（段階 C）。
// 同じ操作を「本物の GAS（シート台帳）」と「Worker（D1）」の両方で流し、
// 台帳の中身が同じになること、付随処理（メール・カレンダー）が控えに入ることを確かめる。
// 合成台帳（【テスト】生徒）だけを使う。本番には触れない。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const K = 'synthetic-link-a';

// 自動生成の id と時刻は毎回変わるので伏せて比べる
function normalize(text) {
  return String(text)
    .replace(/"[0-9a-f]{8,32}"/g, '"id"')
    // 記録した時刻。シート台帳は日付そのもの、D1 は取り込みと同じ文字列で持つ。
    // どちらも「書いた瞬間」を表すので同じ扱いにする
    .replace(/"[^"]*T\d{2}:\d{2}:\d{2}[^"]*"/g, '"時刻"')
    .replace(/"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/g, '"時刻"')
    .replace(/"pending-[^"]*"/g, '"仮のID"');
}

// 見る表。どれも操作で変わりうる
// log は比べない。付随処理の結果（メールが送れたか）で本文が変わるため。
// 見本の GAS では送信が例外になり「メール通知に失敗」が残るが、Worker では控えに回る。
const WATCH = ['slots', 'wishes', 'blocked', 'events', 'tasks', 'cancellationRequests', 'acceptWrites'];

function ledgerOf(sheets) {
  const body = WATCH.map(n => [n, (sheets[n] || []).slice(1)]).filter(([, rows]) => rows.length);
  return normalize(JSON.stringify(body));
}

// 台帳を持つ見本を作る。通知を実際に測るため、名前は【テスト】以外にする
function ledger(extra) {
  const h = createBillingHarness();
  h.setRow('students', 'id', 'test-a', { name: '見本の生徒' });
  h.setRow('config', 'key', 'emailNotify', { value: 'on' });
  h.setRow('config', 'key', 'calendarSync', { value: 'on' });
  const slot = h.seedSlot({ date: '2026-09-25', start: '17:00', status: extra === 'booked' ? 'booked' : 'offered' });
  return { h, slot };
}

async function bothSides(body, kind) {
  const { h, slot } = ledger(kind);
  const req = JSON.parse(JSON.stringify(body).split('SLOT').join(slot.id));
  const p = await createParity(h);

  const gasResult = p.source.request(req);
  const gasLedger = ledgerOf(Object.fromEntries(WATCH.map(n => [n, (p.source.spreadsheet.getSheetByName(n) || { values: [] }).values])));

  const { runWrite } = await import('../cf/worker/write.mjs');
  const { books } = await import('../cf/lib/sheet-view.mjs');
  const done = await runWrite(req, { DB: p.d1, NL_ENABLED: '0' }, { now: h.now() });
  const view = await books(p.d1);
  const workerLedger = ledgerOf(view.app);

  return { p, gasResult, gasLedger, done, workerLedger };
}

test('生徒の書き込みは Worker でも台帳が同じ結果になる', async () => {
  const cases = [
    ['授業可能な日時を出す', { action: 'wishMany', k: K, kind: 'ok', dates: ['2026-09-24'], start: '16:00', end: '18:00', note: '', deliveryMode: 'in_person' }, null],
    ['授業不可を登録', { action: 'blockSet', k: K, add: ['2026-09-26'], removeIds: [], note: '', start: '', end: '' }, null],
    ['予定を共有', { action: 'eventAddMany', k: K, ranges: [{ date: '2026-09-27', dateTo: '2026-09-27' }], title: '見本の行事', alsoBlock: true, kind: 'event' }, null],
    ['宿題を追加', { action: 'taskAdd', k: K, type: '持ち物', title: '見本の持ち物' }, null],
    ['案内を辞退', { action: 'decline', k: K, slotId: 'SLOT' }, null],
    ['取消を依頼', { action: 'cancelReq', k: K, slotId: 'SLOT', reason: '見本の理由' }, 'booked'],
  ];
  const diffs = [];
  for (const [label, body, kind] of cases) {
    const r = await bothSides(body, kind);
    assert.ok(!r.gasResult.error, `${label}: 見本の入力が通らない: ${r.gasResult.error || ''}`);
    assert.ok(!r.done.result.error, `${label}: Worker 側が失敗した: ${r.done.result.error || ''}`);
    if (r.gasLedger !== r.workerLedger) {
      let i = 0;
      while (i < r.gasLedger.length && i < r.workerLedger.length && r.gasLedger[i] === r.workerLedger[i]) i++;
      diffs.push(`${label}\n  GAS   : ${r.gasLedger.slice(Math.max(0, i - 50), i + 70)}\n  Worker: ${r.workerLedger.slice(Math.max(0, i - 50), i + 70)}`);
    }
  }
  assert.deepEqual(diffs, [], '台帳の結果が違う:\n' + diffs.join('\n'));
});

test('メールとカレンダーは控えに溜まり、台帳には仮の予定IDが入る', async () => {
  // 先生への通知が出る操作
  const wish = await bothSides({ action: 'wishMany', k: K, kind: 'ok', dates: ['2026-09-24'], start: '16:00', end: '18:00', note: '', deliveryMode: 'in_person' }, null);
  const mails = wish.done.effects.filter(e => e.kind === 'mail');
  assert.equal(mails.length, 1, '先生への通知が控えに入る');
  assert.equal(mails[0].to, 'TEACHER', '宛先は目印。実アドレスは Worker に置かない');
  assert.ok(mails[0].subject.includes('授業希望'), '件名: ' + mails[0].subject);

  // 控えは _effects にも残る（あとで送り直せるように）
  const { recordEffects } = await import('../cf/worker/write.mjs');
  const ids = await recordEffects(wish.p.d1, wish.done.effects);
  assert.equal(ids.length, 1);
  const row = await wish.p.d1.prepare('select kind, status from _effects where id = ?').bind(ids[0]).first();
  assert.deepEqual(row, { kind: 'mail', status: 'pending' });
});

test('同時に書かれたら反映せず、やり直す', async () => {
  const { h } = ledger();
  const p = await createParity(h);
  const { runWrite } = await import('../cf/worker/write.mjs');
  const db = p.d1;
  // 「読んだあとに他の操作が入った」状態を作る
  const original = db.batch.bind(db);
  let interrupted = false;
  db.batch = async list => {
    if (!interrupted) { interrupted = true; await original([db.prepare('update _ledger set version = version + 1 where id = 1')]); }
    return original(list);
  };
  const done = await runWrite({ action: 'blockSet', k: K, add: ['2026-09-26'], removeIds: [], note: '', start: '', end: '' }, { DB: db, NL_ENABLED: '0' }, { now: h.now() });
  assert.ok(!done.result.error, done.result.error || '');
  assert.equal(done.attempts, 2, '1 回目は反映されず、2 回目で通る');
  const rows = await db.prepare('select count(*) as n from blocked').first();
  assert.equal(Number(rows.n), 1, 'やり直しても二重に入らない');
});

test('保護者のパスワード検証は GAS と同じ値になる（速い実装に差し替えても）', async () => {
  const { h } = ledger();
  const p = await createParity(h);
  const gas = h.context();
  const { pbkdf2Sync } = require('node:crypto');
  const bytes = s => Buffer.from(s, 'utf8');
  for (const [pass, salt] of [['Synthetic parent password!', 'salt-1234567890'], ['日本語のパスワード', 'ソルト']]) {
    const slow = gas.StepwiseParentCrypto.derive(new Uint8Array(bytes(pass)), new Uint8Array(bytes(salt)), 1000);
    const fast = pbkdf2Sync(bytes(pass), bytes(salt), 1000, 32, 'sha256').toString('hex');
    assert.equal(fast, slow, 'PBKDF2 の値が食い違う（保護者がログインできなくなる）');
  }
  assert.ok(p);
});

test('対面の確定はその場で完結し、予定IDが台帳に入る', async () => {
  const { h, slot } = ledger();
  h.setRow('students', 'id', 'test-a', { deliveryMode: 'in_person' });
  const p = await createParity(h);
  const { runWrite } = await import('../cf/worker/write.mjs');
  const req = { action: 'acceptMany', k: K, requestId: 'parity-accept-inperson', slotIds: [slot.id],
    expectedSnapshots: [{ id: slot.id, date: slot.date, start: slot.start, min: slot.min, subject: slot.subject, deliveryMode: 'in_person' }] };
  const done = await runWrite(req, { DB: p.d1, NL_ENABLED: '0' }, { now: h.now() });
  assert.ok(!done.result.error, done.result.error || '');
  const row = await p.d1.prepare('select status, eventId, meetUrl from slots where id = ?').bind(slot.id).first();
  assert.equal(row.status, 'booked');
  assert.match(row.eventId, /^st[0-9a-f]+@google\.com$/, '予定IDは計算で決まる（Google を待たない）');
  assert.equal(row.meetUrl, '', '対面に会議室は要らない');
  assert.deepEqual(done.effects.map(e => e.kind).sort(), ['calendarCreate', 'mail'], 'カレンダー登録と通知は控えに回る');
});

// Meet は Google 側で少し遅れて発行される。以前は発行を待ってから確定していたが、
// その待ち時間はそのまま生徒・先生の待ち時間になっていた。今は待たずに確定し、
// URL は付随処理が書き戻す。届くまで画面は「準備中」を出す。

async function onlineLedger() {
  const { h, slot } = ledger();
  h.setRow('students', 'id', 'test-a', { deliveryMode: 'online' });
  h.setRow('slots', 'id', slot.id, { deliveryMode: 'online' });
  const p = await createParity(h);
  const env = { DB: p.d1, NL_ENABLED: '0', WRITE_MODE: 'worker', GAS_URL: 'https://gas.example.invalid/exec', SYNC_KEY: 'x'.repeat(30) };
  const accept = { action: 'acceptMany', k: K, requestId: 'parity-accept-online1', slotIds: [slot.id],
    expectedSnapshots: [{ id: slot.id, date: slot.date, start: slot.start, min: slot.min, subject: slot.subject, deliveryMode: 'online' }] };
  return { h, p, slot, env, accept };
}

test('オンラインの確定は、Meet を待たずにその場で通る', async () => {
  const { h, p, slot, env, accept } = await onlineLedger();
  const { runWrite } = await import('../cf/worker/write.mjs');

  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { asked.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  let done;
  try { done = await runWrite(accept, env, { now: h.now() }); } finally { globalThis.fetch = original; }

  assert.ok(!done.result.error, done.result.error || '');
  assert.deepEqual(asked, [], '応答を返す前に Apps Script を待っている');
  const row = await p.d1.prepare('select status, eventId, meetUrl from slots where id = ?').bind(slot.id).first();
  assert.equal(row.status, 'booked', 'その場で確定していない');
  assert.match(row.eventId, /^st[0-9a-f]+@google\.com$/, '予定 ID は計算で決まる');
  assert.equal(row.meetUrl || '', '', 'まだ出ていない URL を入れている');
  const created = done.effects.filter(e => e.kind === 'calendarCreate');
  assert.equal(created.length, 1);
  assert.equal(created[0].wantMeet, true, 'オンラインなのに会議室を頼んでいない');
});

test('Meet が届いたら、確定済みの授業に書き戻される', async () => {
  const { h, p, slot, env, accept } = await onlineLedger();
  const { runWrite, recordEffects, deliverEffects } = await import('../cf/worker/write.mjs');
  const done = await runWrite(accept, env, { now: h.now() });
  const marker = done.effects.find(e => e.kind === 'calendarCreate').marker;

  const meet = 'https://meet.example.invalid/abc-defg-hij';
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, done: 2, failed: [],
    writebacks: [{ marker, eventId: marker + '@google.com', meetUrl: meet }] }) });
  try {
    const ids = await recordEffects(p.d1, done.effects);
    await deliverEffects(env, done.effects, ids);
  } finally { globalThis.fetch = original; }

  const row = await p.d1.prepare('select meetUrl from slots where id = ?').bind(slot.id).first();
  assert.equal(row.meetUrl, meet, '届いた URL が台帳に入っていない');
});

test('Apps Script に届かなくても、確定は成立する', async () => {
  const { h, p, slot, accept } = await onlineLedger();
  const { runWrite } = await import('../cf/worker/write.mjs');
  // 頼む先がない状態
  const done = await runWrite(accept, { DB: p.d1, NL_ENABLED: '0', WRITE_MODE: 'worker' }, { now: h.now() });
  assert.ok(!done.result.error, '付随処理の都合で確定を断っている: ' + JSON.stringify(done.result).slice(0, 160));
  const row = await p.d1.prepare('select status, meetUrl from slots where id = ?').bind(slot.id).first();
  assert.equal(row.status, 'booked');
  assert.equal(row.meetUrl || '', '');
});

test('URL がまだ無いオンライン授業は、次に画面を見たときに取り直す', async () => {
  const { h, p, slot, env, accept } = await onlineLedger();
  const { runWrite, backfillMeet } = await import('../cf/worker/write.mjs');
  await runWrite(accept, { DB: p.d1, NL_ENABLED: '0', WRITE_MODE: 'worker' }, { now: h.now() });
  const stored = await p.d1.prepare('select eventId from slots where id = ?').bind(slot.id).first();

  const meet = 'https://meet.example.invalid/zzz-zzzz-zzz';
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, done: 1, failed: [],
      writebacks: [{ marker: stored.eventId, eventId: stored.eventId, meetUrl: meet }] }) };
  };
  let second;
  try {
    const first = await backfillMeet(env);
    assert.equal(first.asked, 1, '取り直しを頼んでいない');
    assert.deepEqual(asked[0].items.map(i => i.kind), ['calendarMeet']);
    second = await backfillMeet(env);
  } finally { globalThis.fetch = original; }

  const row = await p.d1.prepare('select meetUrl from slots where id = ?').bind(slot.id).first();
  assert.equal(row.meetUrl, meet, '取り直した URL が入っていない');
  assert.equal(second.asked, 0, '入ったあとも頼みつづけている');
});

test('取り直しは、間を置かずに同じ予定を頼み直さない', async () => {
  const { h, p, env, accept } = await onlineLedger();
  const { runWrite, backfillMeet } = await import('../cf/worker/write.mjs');
  await runWrite(accept, { DB: p.d1, NL_ENABLED: '0', WRITE_MODE: 'worker' }, { now: h.now() });
  const original = globalThis.fetch;
  // 取れなかったことにする（書き戻し無し）
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, done: 1, failed: [], writebacks: [] }) });
  try {
    assert.equal((await backfillMeet(env)).asked, 1);
    assert.equal((await backfillMeet(env)).asked, 0, '立て続けに頼み直している');
  } finally { globalThis.fetch = original; }
});
