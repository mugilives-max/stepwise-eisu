'use strict';

// ホーム画面のアプリとして入れられるようにした（段階 D）。
//
// 生徒のページは専用リンク（?k=）で本人を見分けている。ホーム画面から開くとその ?k= が
// 付かないので、端末が鍵を覚えていないと何もできない画面になる。貼り直せる入口を出し、
// そこが確かに働くことを確かめる。合成の値だけを使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createUI, state, flush } = require('./helpers/operations-ui-harness.cjs');

const root = f => path.resolve(__dirname, '..', f);

test('生徒・保護者のページがホーム画面に入れられる', () => {
  for (const page of ['yoyaku', 'hogosha']) {
    const html = fs.readFileSync(root(page + '/index.html'), 'utf8');
    assert.match(html, /rel="manifest" href="manifest.webmanifest"/, page + ': manifest がつながっていない');
    assert.match(html, /rel="apple-touch-icon"/, page + ': iPhone 用のアイコンがない');
    const manifest = JSON.parse(fs.readFileSync(root(page + '/manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.start_url, '/' + page + '/');
    assert.equal(manifest.scope, '/' + page + '/');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      const file = root(icon.src.replace(/^\//, ''));
      assert.ok(fs.existsSync(file), '無いアイコンを指している: ' + icon.src);
      const bytes = fs.readFileSync(file);
      const size = Number(icon.sizes.split('x')[0]);
      assert.equal(bytes.readUInt32BE(16), size, icon.src + ': 幅が宣言と違う');
      assert.equal(bytes.readUInt32BE(20), size, icon.src + ': 高さが宣言と違う');
    }
  }
});

test('生徒と保護者と管理で、別々のアイコンになっている', () => {
  const seen = new Map();
  for (const page of ['yoyaku', 'hogosha', 'kanri']) {
    const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(root(page + '/icon-512.png'))).digest('hex');
    assert.ok(!seen.has(hash), page + ' と ' + seen.get(hash) + ' が同じアイコンになっている');
    seen.set(hash, page);
  }
});

// ---- 鍵を覚えていない状態で開いたとき ----

function guardUI() { return createUI('student', { local: new Map() }); }

test('鍵が無ければ、リンクを貼る入口を出す', async () => {
  const ui = guardUI();
  await flush();
  assert.match(ui.html(), /専用リンクからひらいてください/);
  assert.match(ui.html(), /data-action="guardopen"/, 'リンクを貼る入口が無い');
  assert.deepEqual(ui.requests, [], '鍵が無いのに問い合わせている');
});

test('リンクを貼ると、その生徒として読み込む', async () => {
  const ui = guardUI();
  await flush();
  ui.input('guard-link', 'https://www.stepwise-education.jp/yoyaku/?k=synthetic-link-a');
  ui.click('guardopen');
  await flush();
  assert.equal(ui.requests.length, 1, '読み込みに行っていない');
  assert.equal(ui.requests[0].body.k, 'synthetic-link-a', '貼ったリンクの鍵を使っていない');
  ui.requests[0].reply(state());
  await flush();
  assert.match(ui.html(), /授業登録|今後の予定/, '画面が出ていない: ' + ui.html().slice(0, 160));
  assert.equal(ui.local.get('sw_k'), 'synthetic-link-a', '次回のために覚えていない');
});

test('鍵だけを貼っても通る', async () => {
  const ui = guardUI();
  await flush();
  ui.input('guard-link', '  synthetic-link-a  ');
  ui.click('guardopen');
  await flush();
  assert.equal(ui.requests[0].body.k, 'synthetic-link-a');
});

test('リンクとして読めないものは、覚えずに知らせる', async () => {
  const ui = guardUI();
  await flush();
  for (const bad of ['', 'わかりません', 'https://www.stepwise-education.jp/yoyaku/', 'https://example.invalid/?k=<script>']) {
    ui.input('guard-link', bad);
    ui.click('guardopen');
    await flush();
    assert.deepEqual(ui.requests, [], '読めない入力で問い合わせている: ' + bad);
    assert.equal(ui.local.get('sw_k'), undefined, '読めない入力を覚えている: ' + bad);
    assert.match(ui.html(), /リンクを読み取れませんでした/, '知らせていない: ' + bad);
  }
});

test('ひらけないリンクなら、その旨を知らせる', async () => {
  const ui = guardUI();
  await flush();
  ui.input('guard-link', 'https://www.stepwise-education.jp/yoyaku/?k=synthetic-unknown');
  ui.click('guardopen');
  await flush();
  ui.requests[0].reply({ error: '専用リンクからひらき直してください' });
  await flush();
  assert.match(ui.html(), /ひらけませんでした/, '失敗を知らせていない: ' + ui.html().slice(0, 200));
});

// ---- Meet のリンクは、届くまで「準備中」 ----
// 確定は Meet の発行を待たない。届くまで画面は準備中を出し、リンクが入ったら差し替わる。

const { studentReady } = require('./helpers/operations-ui-harness.cjs');

function onlineSlot(extra) {
  return Object.assign({ id: 'slot-online', date: '2026-09-10', start: '17:00', min: 60, subject: '英語',
    deliveryMode: 'online', st: 'mine' }, extra || {});
}

test('URL がまだ無いオンライン授業は、準備中と出す', async () => {
  const ui = await studentReady(state([onlineSlot()]));
  const html = ui.html();
  assert.match(html, /Meetのリンクを準備しています/, '準備中が出ていない');
  assert.doesNotMatch(html, /href="[^"]*meet/i, '空のリンクを出している');
});

test('URL が届いたら、参加のリンクになる', async () => {
  const ui = await studentReady(state([onlineSlot({ meet: 'https://meet.google.com/abc-defg-hij' })]));
  const html = ui.html();
  assert.match(html, /https:\/\/meet\.google\.com\/abc-defg-hij/, 'リンクになっていない');
  assert.doesNotMatch(html, /準備しています/, 'リンクがあるのに準備中を出している');
});

test('対面の授業には、準備中を出さない', async () => {
  const ui = await studentReady(state([onlineSlot({ deliveryMode: 'in_person' })]));
  assert.doesNotMatch(ui.html(), /準備しています/, '対面に Meet の案内を出している');
});
