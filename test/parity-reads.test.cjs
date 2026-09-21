'use strict';

// 並走テスト（段階 B）。
// 読み取りの処理を D1 の上で動かしても、スプレッドシートの上で動かしたときと
// 同じ JSON が返ることを確かめる。Worker へ移せる読み取りは、ここで一致したものだけ。
// 合成台帳（【テスト】生徒）だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');

// 予定・計画・授業記録・請求のどれにも中身がある台帳を作る
function ledgerWithContent() {
  const h = createBillingHarness();
  const offered = h.seedSlot({ date: '2026-09-25', start: '17:00', subject: '英語' });
  h.seedSlot({ date: '2026-09-01', status: 'booked', done: true });
  h.seedSlot({ date: '2026-09-08', status: 'booked', done: true, subject: '数学' });
  h.seedPlan();
  h.seedPayment({ '年月': '2026-08' }); // 当月に請求を立てると確定が止まるので前月にする
  const accepted = h.accept(offered.id);
  assert.ok(!accepted.error, '見本の確定が通らない: ' + (accepted.error || ''));
  h.admin('addOff', { date: '2026-09-30', start: '', end: '', note: '見本' });
  return h;
}

test('生徒マイページと管理画面の読み取りは D1 の上でも同じ JSON を返す', async () => {
  const p = await createParity(ledgerWithContent());

  p.compare('生徒マイページ（state）', h => h.context().studentState_('synthetic-link-a'));
  p.compare('管理画面の生徒ページ（概要）', h => h.admin('kanriStudent', { studentId: 'test-a', section: 'overview' }));
  p.compare('管理画面の生徒ページ（設定）', h => h.admin('kanriStudent', { studentId: 'test-a', section: 'settings' }));
  p.compare('管理画面の生徒ページ（学習）', h => h.admin('kanriStudent', { studentId: 'test-a', section: 'progress' }));
  p.compare('管理画面の生徒ページ（全部）', h => h.admin('kanriStudent', { studentId: 'test-a', section: 'all' }));
  p.compare('管理画面の生徒ページ（請求）', h => h.admin('kanriStudent', { studentId: 'test-a', section: 'billing' }));
  p.compare('管理画面のホーム（dashboard）', h => h.context().kanriDashboard_());
  p.compare('請求の下書き（billingPreview）', h => h.context().billingPreview_('test-a', '2026-09'));
  p.compare('先生のプレビュー（生徒ページ）', h => h.request({ action: 'preview', token: 'synthetic-teacher-token-only-for-test', studentId: 'test-a', view: 'student' }));

  assert.deepEqual(p.diffs, [], '台帳と D1 で結果が違う:\n' + p.diffs.join('\n'));
});

test('停止中の生徒・実施済みの授業など、真偽値の書き方が違う列も同じに読める', async () => {
  const h = createBillingHarness();
  h.seedSlot({ date: '2026-09-01', status: 'booked', done: true });
  h.seedSlot({ date: '2026-09-02', status: 'booked', done: '' });
  const p = await createParity(h);

  // 台帳では TRUE / 'true' / '1' の 3 通りが混在する。D1 は 0/1 に揃えてあるので、
  // 戻すときに列ごとの書き方へ直せていないと、ここで在籍や実施済みの判定が食い違う。
  p.compare('生徒の一覧（在籍の判定）', hh => hh.admin('state'));
  p.compare('生徒の行（在籍の書き方そのもの）', hh => hh.context().readRows_('students').map(s => [s.id, s.active]));
  // 数値列は D1 では数値として持つので、台帳に「文字列の数字」で入っていた値は数値で戻る
  // （台帳の実データでは tokenExpiresAt などがこの形）。GAS 側はこれらを必ず Number() を
  // 通してから使い、数値と数字文字列を区別する判定は無い。区別が要るのは「空欄かどうか」
  // だけで、そちらは NULL → '' で保たれる（下の 空欄 の確認）。
  p.compare('生徒を引く（空欄の保たれ方を含む）', hh => {
    const s = hh.context().systemStudent_('test-a');
    return { ...s, parentExp: Number(s.parentExp || 0), monthly: s.monthly, rate30: Number(s.rate30) };
  });
  p.compare('実施済みの授業（請求の対象）', hh => hh.context().billingPreview_('test-a', '2026-09'));
  p.compare('ホームの集計', hh => hh.context().kanriDashboard_());
  assert.deepEqual(p.diffs, [], '真偽値の扱いが食い違う:\n' + p.diffs.join('\n'));

  // 停止中の生徒が在籍扱いになっていないこと（0/1 を戻し損ねると起きる）
  const active = p.mirror.rows('students').filter(s => !(String(s.active) === 'false' || s.active === false));
  assert.equal(active.length, 2, '【テスト】停止中 は在籍に数えない');
});

test('D1 から戻した台帳は、行の並びと空欄の扱いまで元どおり', async () => {
  const h = createBillingHarness();
  for (const date of ['2026-09-11', '2026-09-10', '2026-09-12']) h.seedSlot({ date });
  const p = await createParity(h);
  assert.deepEqual(
    p.mirror.rows('slots').map(s => s.date),
    p.source.rows('slots').map(s => s.date),
    'シート上の行の並びをそのまま保つ');
  // 空欄は '' で戻す（null や 0 にしない）。GAS 側には
  // `standardFee !== '' && standardFee != null`、`approvedCount === '' || == null`、
  // `rate30 !== '' && rate30 != null` のように、空欄と 0 を分ける判定が残っている。
  // ここを 0 に潰すと料金や承認済み回数の分岐が変わるので、数値列は NULL 可にしてある。
  const mirrored = p.mirror.rows('slots')[0];
  assert.equal(mirrored.eventId, '');
  assert.equal(mirrored.req, '');
  const student = p.mirror.rows('students').find(s => s.id === 'test-a');
  assert.equal(student.monthly, '', '空欄の金額は 0 ではなく空欄のまま');
  assert.notEqual(student.rate30, '', '値のある金額は数値で戻る');
  const kinds = p.mirror.context().lessonKindRows_ ? p.mirror.context().lessonKindRows_() : null;
  if (kinds && kinds.length) assert.equal(kinds[0].standardMin, null, '未設定の標準時間は 0 と区別して null のまま');
});
