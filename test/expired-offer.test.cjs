'use strict';

// 返事がないまま授業の時間が終わった案内を、その日のうちに片付けられること。
//
// 授業の記録（内容・宿題）は確定済みの授業にしか付けられない。案内のままだと何も書けない。
// 以前は「実施済みにする」が翌日にならないと画面に出ず、実際に授業をした日に記録できなかった。
// 台帳側は開始を過ぎていれば受け付けていたので、出ていなかったのは画面の絞り込みだけの問題。
// 合成台帳（【テスト】生徒）だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingHarness } = require('./helpers/billing-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

// ハーネスの「今」は固定。その日の授業を作れるように、今日の日付と時刻を取り出す
function clock(h) {
  const now = new Date(h.now());
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return {
    today: jst.getUTCFullYear() + '-' + pad(jst.getUTCMonth() + 1) + '-' + pad(jst.getUTCDate()),
    hour: jst.getUTCHours(),
  };
}

function dashboard(h) {
  const res = h.request({ action: 'admin', op: 'kanriDashboard', token: TEACHER_TOKEN });
  assert.ok(res.ok, JSON.stringify(res).slice(0, 160));
  return res.data;
}

test('今日すでに終わった案内が、その日のうちに一覧へ出る', () => {
  const h = createBillingHarness();
  const { today, hour } = clock(h);
  assert.ok(hour >= 2, '前提: ハーネスの時刻が朝の授業を過去にできる（今は ' + hour + ' 時）');
  const slot = h.seedSlot({ date: today, start: '07:30', min: 90, status: 'offered' });

  const ids = (dashboard(h).expired || []).map(x => String(x.id));
  assert.ok(ids.includes(String(slot.id)), '終わった案内が一覧に出てこない: ' + JSON.stringify(ids));
});

test('まだ終わっていない今日の案内は、一覧に出ない', () => {
  const h = createBillingHarness();
  const { today } = clock(h);
  const slot = h.seedSlot({ date: today, start: '23:30', min: 30, status: 'offered' });
  const ids = (dashboard(h).expired || []).map(x => String(x.id));
  assert.ok(!ids.includes(String(slot.id)), 'これから始まる案内を「終わった」扱いにしている');
});

test('終わった案内を実施済みにすると、授業の記録を書けるようになる', () => {
  const h = createBillingHarness();
  const { today } = clock(h);
  const slot = h.seedSlot({ date: today, start: '07:30', min: 90, status: 'offered' });

  const done = h.request({ action: 'admin', op: 'finishOffered', token: TEACHER_TOKEN, slotId: slot.id, studentId: 'test-a' });
  assert.ok(done.ok, '実施済みにできない: ' + JSON.stringify(done).slice(0, 180));
  const after = h.rows('slots').find(s => String(s.id) === String(slot.id));
  assert.equal(after.status, 'booked', '確定になっていない');
  assert.ok(after.done === true || String(after.done) === 'true', '実施済みになっていない: ' + after.done);

  // 記録を書く入口が、この授業を受け付けること（内容の中身はここでは問わない）
  const context = h.request({ action: 'admin', op: 'lessonContext', token: TEACHER_TOKEN, slotId: slot.id, studentId: 'test-a' });
  assert.ok(!context.error || !/取消・変更されています|確定授業を選んで/.test(String(context.error)),
    '確定したのに記録を書けない: ' + JSON.stringify(context).slice(0, 180));
});

test('片付けたあとは、一覧から消える', () => {
  const h = createBillingHarness();
  const { today } = clock(h);
  const slot = h.seedSlot({ date: today, start: '07:30', min: 90, status: 'offered' });
  h.request({ action: 'admin', op: 'finishOffered', token: TEACHER_TOKEN, slotId: slot.id, studentId: 'test-a' });
  const ids = (dashboard(h).expired || []).map(x => String(x.id));
  assert.ok(!ids.includes(String(slot.id)), '片付けたのに残っている');
});

test('開始前の案内は、実施済みにできない', () => {
  const h = createBillingHarness();
  const { today } = clock(h);
  const slot = h.seedSlot({ date: today, start: '23:30', min: 30, status: 'offered' });
  const res = h.request({ action: 'admin', op: 'finishOffered', token: TEACHER_TOKEN, slotId: slot.id, studentId: 'test-a' });
  assert.ok(res.error, 'これからの授業を実施済みにできてしまう');
  assert.match(String(res.error), /まだ開始前/);
});
