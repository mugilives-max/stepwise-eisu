'use strict';

// 予定のカードから、終わった案内をそのまま記録へ進めること。
//
// 実際に授業をしたのに登録が遅れると、案内のままでは記録を書けない（記録は確定済みの
// 授業にしか付けられない）。予定のカードに「実施済みにして記録」を出し、確認のうえで
// 確定してから記録の入力へ移る。合成の値だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, card, flush } = require('./helpers/operations-ui-harness.cjs');

const TODAY = '2026-09-08';

// その日の授業。終わった時刻かどうかは「今」と比べて決まるので、時刻を固定して作る
function lesson(overrides = {}) {
  return Object.assign({
    id: 'slot-past', date: TODAY, start: '07:30', min: 90, subject: '化学',
    status: 'offered', done: false, studentId: 'test-a', studentName: '【テスト】生徒A',
    deliveryMode: 'in_person',
  }, overrides);
}

// 生徒ページの予定カードを、その日を選んだ状態で出す
async function dayCard(lessons, now = TODAY + 'T13:00:00+09:00') {
  const ui = createUI('admin', { hash: '#s=test-a&tab=overview', now });
  ui.requests[0].reply({ data: card({ today: TODAY, lessons }) });
  await flush();
  return ui;
}

test('終わった案内には「実施済みにして記録」が出る', async () => {
  const ui = await dayCard([lesson()]);
  assert.match(ui.html(), /実施済みにして記録/, 'ボタンが出ていない');
  assert.match(ui.html(), /data-action="finishandrecord"/);
  assert.match(ui.html(), /取り下げ/, '取り下げも残っている');
});

test('まだ終わっていない案内には出さない', async () => {
  const ui = await dayCard([lesson({ start: '23:30', min: 30 })]);
  assert.doesNotMatch(ui.html(), /実施済みにして記録/, 'これからの授業に出ている');
});

test('確定済みの授業には出さない（そちらは元から記録へ進める）', async () => {
  const ui = await dayCard([lesson({ status: 'booked', done: true })]);
  assert.doesNotMatch(ui.html(), /実施済みにして記録/);
});

test('押すと確認があり、実施済みにしてから記録の入力へ移る', async () => {
  const ui = await dayCard([lesson()]);
  ui.click('finishandrecord');
  await flush();

  assert.equal(ui.confirms(), 1, '確認なしで確定している');
  const sent = ui.requests[ui.requests.length - 1];
  assert.equal(sent.body.op, 'finishOffered', '実施済みにしていない: ' + JSON.stringify(sent.body).slice(0, 140));
  assert.equal(sent.body.slotId, 'slot-past');
  assert.equal(sent.body.studentId, 'test-a');

  sent.reply({ ok: true, admin: { today: TODAY, slots: [], students: [] } });
  await flush();
  assert.match(ui.location.hash, /^#lesson\?student=test-a&slot=slot-past/, '記録の入力へ移っていない: ' + ui.location.hash);
});

test('確定に失敗したら、記録の入力へは移らない', async () => {
  const ui = await dayCard([lesson()]);
  const before = ui.location.hash;
  ui.click('finishandrecord');
  await flush();
  ui.requests[ui.requests.length - 1].reply({ error: '重なる授業があります' }, { status: 200 });
  await flush();
  assert.equal(ui.location.hash, before, '失敗したのに記録の入力へ移っている');
});
