'use strict';

// 読み取りの振り分け。READ_API を設定したときだけ Worker に向き、
// 引き受けない・失敗・通信不能のときは Apps Script に回る。書き込みは常に Apps Script。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, flush } = require('./helpers/operations-ui-harness.cjs');

// 出荷している画面には Worker の URL が入っている。テストでは差し替えて振る舞いを見る
const WORKER = 'https://api.example.invalid';
const SHIPPED = /var READ_API = "[^"]*";/;

function withWorker(kind, options = {}) {
  return createUI(kind, { ...options, source: src => src.replace(SHIPPED, 'var READ_API = "' + WORKER + '";') });
}
// 正本が Apps Script にあった頃の状態（読み取りだけ Worker、失敗したら Apps Script に回る）。
// 台帳が Worker に移ったあとは回り道をしない（Apps Script が書き込みを断るため意味がない）
function beforeCutover(kind, options = {}) {
  return createUI(kind, { ...options, source: src => src
    .replace(SHIPPED, 'var READ_API = "' + WORKER + '";')
    .replace('var WRITE_TO_WORKER = true;', 'var WRITE_TO_WORKER = false;') });
}
// 振り分けを切った状態（不具合が出たときに戻す設定）
function withoutWorker(kind, options = {}) {
  return createUI(kind, { ...options, source: src => src.replace(SHIPPED, 'var READ_API = "";') });
}

test('出荷している画面には Worker の宛先が入っている', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const rel of ['../assets/portal.js', '../kanri/index.html']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const m = SHIPPED.exec(src);
    assert.ok(m, rel + ' に READ_API がない');
    assert.match(m[0], /https:\/\/[a-z0-9.-]+workers\.dev/, rel + ' の宛先が Worker ではない: ' + m[0]);
  }
});

test('振り分けを切れば、読み取りも今までどおり Apps Script へ行く', async () => {
  const ui = withoutWorker('student');
  await flush();
  assert.equal(ui.requests.length, 1);
  assert.match(ui.requests[0].url, /script\.google\.com/, '空にすれば元の経路に戻る');
});

test('生徒マイページの読み取りは Worker へ行き、書き込みは Apps Script へ行く', async () => {
  const ui = withWorker('student');
  await flush();
  assert.equal(ui.requests.length, 1, '最初の読み取りは 1 回');
  assert.ok(ui.requests[0].url.startsWith(WORKER), '読み取りは Worker: ' + ui.requests[0].url);
  assert.equal(ui.requests[0].body.action, 'state');
});

test('切り替え前は、Worker が引き受けない読み取りが Apps Script に回る', async () => {
  const ui = beforeCutover('student');
  await flush();
  ui.requests[0].reply({ error: 'この操作はまだ Worker にありません', errorCode: 'notImplemented' }, { status: 501 });
  await flush();
  assert.equal(ui.requests.length, 2, '同じ読み取りが 2 回目に出る');
  assert.match(ui.requests[1].url, /script\.google\.com/, '2 回目は Apps Script');
  assert.deepEqual(ui.requests[1].body, ui.requests[0].body, '中身は変えずにそのまま渡す');
});

test('切り替え前は、Worker が落ちても Apps Script に回るので画面は動く', async () => {
  for (const breakIt of [
    r => r.fail(),
    r => r.reply({ error: '読み取りに失敗しました', errorCode: 'workerError' }, { status: 500 }),
    r => r.reply({}, { status: 502 }),
  ]) {
    const ui = beforeCutover('student');
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

test('切り替え後は、書き込みも読み取りも Worker へ行く（回り道はしない）', async () => {
  const ui = withWorker('student');   // 出荷している状態（WRITE_TO_WORKER = true）
  await flush();
  assert.equal(ui.requests.length, 1);
  assert.ok(ui.requests[0].url.startsWith(WORKER), '最初の読み取りが Worker: ' + ui.requests[0].url);
  // 落ちても Apps Script には回さない。Apps Script は台帳への書き込みを断るので回っても意味がない
  ui.requests[0].fail();
  await flush();
  assert.equal(ui.requests.length, 1, '回り道の追加要求を出さない');
});
