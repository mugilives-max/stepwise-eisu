'use strict';

// 保護者ページの読み取りが、D1 の上（Worker）でも GAS と同じ JSON を返すかを見る。
// ログインの確認はセッションの照合（SHA-256）を通るので、Worker 側の
// Utilities.computeDigest が GAS と同じ結果を出せていないとここで落ちる。
// 台帳は合成（【テスト】生徒）だけ。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyHarness } = require('./helpers/family-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

const PASS = 'Synthetic parent password!';

test.before(async () => {
  const { generate } = await import('../scripts/build-gas-bundle.mjs');
  generate();
});

const ok = r => { assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200)); return r; };

// 保護者アカウントを作り、ログインまで通した台帳を用意する
function familyLedger() {
  const h = createFamilyHarness();
  h.admin('state');
  ok(h.admin('kanriSaveProfile', {studentId:'test-a',profile:{'姓':'【テスト】','名':'保護者認証A'}}));
  const created = ok(h.admin('familyCreate', { label: '【テスト】並走', studentIds: ['test-a'] }));
  ok(h.family('familyRegister', { inviteCode: created.inviteCode, email: 'parity@example.invalid', pass: PASS }));
  const challenge = h.latestChallenge();
  ok(h.family('familyVerify', { challenge }));
  ok(h.family('familyCompleteRegistration', { challenge, pass: PASS }));
  const session = ok(h.family('familyLogin', { email: 'parity@example.invalid', pass: PASS }));
  // 予定と請求に中身を入れる（空同士の比較にならないように）
  h.admin('addOff', { date: '2026-09-30', start: '', end: '', note: '見本' });
  return { h, ftoken: session.ftoken };
}

test('保護者ページの読み取りは Worker でも GAS と同じ JSON を返す', async () => {
  const { h, ftoken } = familyLedger();
  const p = await createParity(h);

  await p.compareWorker('家族の枠（familyHome）',
    src => src.request({ action: 'familyHome', ftoken }),
    { action: 'familyHome', ftoken });

  await p.compareWorker('子どもの情報（familyData）',
    src => src.request({ action: 'familyData', ftoken, studentId: 'test-a' }),
    { action: 'familyData', ftoken, studentId: 'test-a' });

  await p.compareWorker('子どものマイページ（familyStudentState）',
    src => src.request({ action: 'familyStudentState', ftoken, studentId: 'test-a' }),
    { action: 'familyStudentState', ftoken, studentId: 'test-a' });

  await p.compareWorker('お知らせ（familyNotices）',
    src => src.request({ action: 'familyNotices', ftoken }),
    { action: 'familyNotices', ftoken });

  assert.deepEqual(p.diffs, [], 'GAS と Worker で結果が違う:\n' + p.diffs.join('\n'));
});

test('ログインしていない保護者の読み取りは断る', async () => {
  const { h } = familyLedger();
  const p = await createParity(h);
  for (const body of [
    { action: 'familyHome', ftoken: 'invalid' },
    { action: 'familyHome' },
    { action: 'familyData', ftoken: 'fa1.00000000000000000000000000000000.' + 'a'.repeat(64), studentId: 'test-a' },
  ]) {
    const res = await p.worker(body);
    assert.ok(res && res.error, JSON.stringify(body) + ' が通ってしまう');
    assert.match(res.error, /ログインし直して/);
  }
});

test('他の家族の子どもは読めない', async () => {
  const { h, ftoken } = familyLedger();
  const p = await createParity(h);
  const res = await p.worker({ action: 'familyData', ftoken, studentId: 'test-b' });
  assert.ok(res.error, '紐付いていない生徒が読めてしまう');
  assert.match(res.error, /この生徒の情報は利用できません/);
});

test('書き込みを伴う保護者の操作は Worker では扱わない', async () => {
  const { h, ftoken } = familyLedger();
  const p = await createParity(h);
  for (const body of [
    { action: 'familyNoticeRead', ftoken, noticeId: 'x' },
    { action: 'familyEmailPrefs', ftoken },
    { action: 'familyLogin', email: 'parity@example.invalid', pass: PASS },
    { action: 'familyLogout', ftoken },
  ]) assert.equal(await p.worker(body), null, JSON.stringify(body.action) + ' は Worker が引き受けない');
});

test('セッションの照合に使う SHA-256 が GAS と同じ結果になる', async () => {
  const { h } = familyLedger();
  const p = await createParity(h);
  const { createRuntime } = await import('../cf/worker/read.mjs');
  const worker = await createRuntime(p.env, { now: h.now() });
  const gas = h.context();
  // parentDigest_ はセッションの照合に使う。1文字でも違えば保護者はログインできなくなる
  for (const [kind, id, value] of [['family-session', 'abc', 'fa1.abc.def'], ['x', '', ''], ['日本語', 'test-a', 'かぎ']])
    assert.equal(worker.parentDigest_(kind, id, value), gas.parentDigest_(kind, id, value), `${kind} の値が食い違う`);
});

test('parent name registration persists through Worker transactions',async()=>{const {h,ftoken}=familyLedger();const p=await createParity(h);const {runWrite}=await import('../cf/worker/write.mjs');const result=await runWrite({action:'familyProfileSave',ftoken,kind:'name',familyName:'試験',givenName:'保護者'},p.env,{now:h.now()});assert.equal(result.result.ok,true,JSON.stringify(result.result));const home=await p.worker({action:'familyHome',ftoken});assert.equal(home.family.familyName,'試験');assert.equal(home.family.givenName,'保護者');});
