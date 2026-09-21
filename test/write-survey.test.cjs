'use strict';

// 段階 C の下調べ。
// 生徒・保護者・先生の書き込みを「D1 の上で GAS のコードをそのまま動かす」形で流し、
//   (1) 台帳の結果が本物の GAS と一致するか
//   (2) その書き込みが Google のサービス（メール・カレンダー）を使うか
// を実際に動かして調べる。本番には触れない。合成台帳（【テスト】生徒）だけを使う。
//
// ここで一致し、かつ Google を使わない書き込みが、Worker へ先に移せる候補になる。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

// 調べる書き込み。画面が実際に送っている形に合わせる（assets/portal.js が正）
const K = 'synthetic-link-a';
function cases(slot) {
  return [
    ['授業可能な日時を出す（生徒）', { action: 'wishMany', k: K, kind: 'ok', dates: ['2026-09-24'], start: '16:00', end: '18:00', note: '', deliveryMode: 'in_person' }],
    ['授業不可を登録（生徒）', { action: 'blockSet', k: K, add: ['2026-09-26'], removeIds: [], note: '', start: '', end: '' }],
    ['予定を共有（生徒）', { action: 'eventAddMany', k: K, ranges: [{ date: '2026-09-27', dateTo: '2026-09-27' }], title: '見本の行事', alsoBlock: false, kind: 'event' }],
    ['宿題を追加（生徒）', { action: 'taskAdd', k: K, type: '持ち物', title: '見本の持ち物' }],
    ['案内を辞退（生徒）', { action: 'decline', k: K, slotId: slot.id }],
    ['取消を依頼（生徒）', { action: 'cancelReq', k: K, slotId: slot.id, reason: '見本の理由' }],
  ];
}

// D1 の上で GAS の doPost を動かす。台帳への書き込みは D1 用の入れ物に溜まる
async function runOnD1(parity, body, now) {
  const { createServices } = await import('../cf/lib/gas-services.mjs');
  const { createGas } = await import('../cf/worker/generated/gas.mjs');
  const { books } = await import('../cf/lib/sheet-view.mjs');
  const view = await books(parity.d1);
  const services = createServices({
    books: view,
    properties: Object.fromEntries(parity.source.properties),
    now,
    mutable: true,
    record: true, // メールやカレンダーは止めずに、呼ばれた記録だけ残す
  });
  const gas = createGas(services);
  const out = gas.doPost({ postData: { contents: JSON.stringify(body) } });
  return { result: JSON.parse(out.getContent()), services, view };
}

// 自動生成される id と時刻は毎回変わる。出てきた順に置き換えて比べられるようにする
function normalize(text) {
  // 自動生成の id と時刻は毎回変わる。番号を振らず一律に伏せて比べる
  return String(text)
    .replace(/"(ms|createdAt|updatedAt|receivedAt|deadlineAt|proposedAt|approvedAt|readAt|sentAt|claimedAt|expiresAt|time|at)":("[^"]*"|\d+)/g, '"$1":"-"')
    .replace(/"[0-9a-f]{8,32}"/g, '"id"')
    .replace(/"[^"]*T\d{2}:\d{2}:\d{2}[^"]*"/g, '"時刻"');
}

// 台帳の中身を比べられる形にする。見出し行は落とし、データ行だけを見る
// （D1 には空の表も存在するが、台帳側はまだシートが無いことがある。中身が空なら同じ扱い）
function ledgerText(sheets) {
  const body = Object.keys(sheets).sort().map(n => [n, (sheets[n] || []).slice(1)]).filter(([, rows]) => rows.length);
  return normalize(JSON.stringify(body));
}

test('生徒の書き込みを D1 の上で流し、結果と Google 依存を調べる', async t => {
  const report = [];
  const probe = createBillingHarness();
  const shape = probe.seedSlot({ date: '2026-09-25', start: '17:00', status: 'offered' });
  for (const [label, body] of cases(shape)) {
    const h = createBillingHarness();
    // 取消の依頼は確定済みの授業に対して行う
    const booked = body.action === 'cancelReq';
    const slot = h.seedSlot({ date: '2026-09-25', start: '17:00', status: booked ? 'booked' : 'offered' });
    const req = JSON.parse(JSON.stringify(body).split(shape.id).join(slot.id));
    // 【テスト】で始まる名前だと通知もカレンダーも意図的に抑止される。
    // Google への依存を測るために、合成の台帳の中だけ名前を変える（実在の生徒ではない）
    h.setRow('students', 'id', 'test-a', { name: '見本の生徒' });
    h.setRow('config', 'key', 'emailNotify', { value: 'on' });   // 既定は off。通知の有無を測るため入れる
    h.setRow('config', 'key', 'calendarSync', { value: 'on' });
    const p = await createParity(h);

    // 本物の GAS（台帳）で実行。一括確定は「同じ選択で再送」を求める二段構えなので、
    // 画面と同じようにもう一度送る
    const resend = r => r && /再送してください/.test(String(r.error || ''));
    let gasResult = p.source.request(req);
    const retried = resend(gasResult);
    if (retried) gasResult = p.source.request(req);
    const watched = ['slots', 'wishes', 'blocked', 'events', 'tasks', 'cancellationRequests', 'acceptWrites'];
    const gasLedger = ledgerText(Object.fromEntries(watched.map(n => [n, (p.source.spreadsheet.getSheetByName(n) || { values: [] }).values])));

    // D1 の上で同じことを実行
    let calls = [], touched = [], d1Ledger = null, failure = '', d1Error = '';
    try {
      let run = await runOnD1(p, req, h.now());
      if (retried) run = await runOnD1(p, req, h.now());
      d1Error = (run.result && run.result.error) || '';
      calls = run.services._calls;
      touched = [...run.services._touched];
      d1Ledger = ledgerText(Object.fromEntries(watched.map(n => [n, run.view.app[n] || []])));
    } catch (e) {
      failure = String((e && e.message) || e).slice(0, 120);
    }

    const sameResult = failure ? false : String(gasResult.error || '') === String(d1Error || '');
    const sameLedger = failure ? false : gasLedger === d1Ledger;
    const google = [...new Set(calls.map(c => c.service))];
    report.push({ label, sameResult, sameLedger, google, touched, failure, gasError: gasResult && gasResult.error, gasLedger, d1Ledger });
  }

  // 調べた結果を読める形で残す（この一覧が段階 C の判断材料になる）
  const lines = report.map(r => [
    r.label.padEnd(24),
    r.failure ? '×失敗: ' + r.failure : (r.sameResult && r.sameLedger ? '一致' : '不一致'),
    r.google.length ? 'Google: ' + r.google.join('/') : 'Google 不要',
    '書いた表: ' + (r.touched.join(',') || 'なし'),
  ].join('  '));
  t.diagnostic('\n' + lines.join('\n'));

  // 失敗したものが無いこと（＝どの書き込みも D1 の上で最後まで動く）
  assert.deepEqual(report.filter(r => r.failure).map(r => r.label + ': ' + r.failure), [], 'D1 の上で動かない書き込みがある');
  // 台帳の結果が本物と一致すること
  const differing = report.filter(r => !r.sameLedger).map(r => {
    const a = r.gasLedger || '', b = r.d1Ledger || '';
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `${r.label}
    GAS: ${a.slice(Math.max(0, i - 40), i + 60)}
    D1 : ${b.slice(Math.max(0, i - 40), i + 60)}`;
  });
  assert.deepEqual(differing, [], '台帳の結果が本物と違う');
  assert.deepEqual(report.filter(r => !r.sameResult).map(r => r.label), [], '応答が本物と違う');
  // 本物の GAS 側で失敗した操作は、比べたことにならない（両方同じエラーを返しただけ）
  assert.deepEqual(report.filter(r => r.gasError).map(r => r.label + ': ' + r.gasError), [], '見本の入力が通っていない');

  // Google を使わない書き込みが実際にあること（先に移せる候補）
  const free = report.filter(r => !r.google.length).map(r => r.label);
  assert.ok(free.length >= 3, 'Google 不要の書き込みが見つからない: ' + JSON.stringify(report.map(r => [r.label, r.google])));
});
