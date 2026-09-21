'use strict';

// 読み取りの振り分け。READ_API を設定したときだけ Worker に向き、
// 引き受けない・失敗・通信不能のときは Apps Script に回る。書き込みは常に Apps Script。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, flush } = require('./helpers/operations-ui-harness.cjs');

const WORKER = 'https://api.example.invalid';

// 画面のコードは READ_API = "" で出荷する。テストではそこだけ差し替えて振る舞いを見る
function withWorker(kind, options = {}) {
  return createUI(kind, { ...options, source: src => src.replace('var READ_API = "";', 'var READ_API = "' + WORKER + '";') });
}

test('振り分けが無効なら、読み取りも今までどおり Apps Script へ行く', async () => {
  const ui = createUI('student');
  await flush();
  assert.equal(ui.requests.length, 1);
  assert.match(ui.requests[0].url, /script\.google\.com/);
});

test('生徒マイページの読み取りは Worker へ行き、書き込みは Apps Script へ行く', async () => {
  const ui = withWorker('student');
  await flush();
  assert.equal(ui.requests.length, 1, '最初の読み取りは 1 回');
  assert.ok(ui.requests[0].url.startsWith(WORKER), '読み取りは Worker: ' + ui.requests[0].url);
  assert.equal(ui.requests[0].body.action, 'state');
});

test('Worker が引き受けない読み取りは Apps Script に回る', async () => {
  const ui = withWorker('student');
  await flush();
  ui.requests[0].reply({ error: 'この操作はまだ Worker にありません', errorCode: 'notImplemented' }, { status: 501 });
  await flush();
  assert.equal(ui.requests.length, 2, '同じ読み取りが 2 回目に出る');
  assert.match(ui.requests[1].url, /script\.google\.com/, '2 回目は Apps Script');
  assert.deepEqual(ui.requests[1].body, ui.requests[0].body, '中身は変えずにそのまま渡す');
});

test('Worker が落ちていても Apps Script に回るので画面は動く', async () => {
  for (const breakIt of [
    r => r.fail(),
    r => r.reply({ error: '読み取りに失敗しました', errorCode: 'workerError' }, { status: 500 }),
    r => r.reply({}, { status: 502 }),
  ]) {
    const ui = withWorker('student');
    await flush();
    breakIt(ui.requests[0]);
    await flush();
    assert.equal(ui.requests.length, 2);
    assert.match(ui.requests[1].url, /script\.google\.com/);
  }
});

test('管理画面も読み取りだけ Worker に向く', async () => {
  const ui = withWorker('admin', { hash: '#home' });
  await flush();
  const first = ui.requests[0];
  assert.equal(first.body.action, 'admin');
  assert.ok(['kanriDashboard', 'state', 'kanriStudent'].includes(first.body.op), '最初は読み取り: ' + first.body.op);
  assert.ok(first.url.startsWith(WORKER), '読み取りは Worker: ' + first.url);
});

test('先生のログインの札は Worker にもそのまま送る（Worker 側で確認する）', async () => {
  const ui = withWorker('admin', { hash: '#home' });
  await flush();
  assert.equal(ui.requests[0].body.token, 'test-teacher-token');
});
