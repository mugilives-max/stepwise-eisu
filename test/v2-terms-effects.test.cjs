'use strict';
// 作り直し（v2）: 受講規約の版と同意（cf/v2/terms.mjs、0016_terms.sql）と、送れなかったメール・カレンダー（cf/v2/effects-admin.mjs）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

const at = s => Date.parse(s + '+09:00');
async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  const plan = async () => { const line = (await h.ok('billing/plans/save', { auth, studentId: kid.id, subject: '数学', kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: 4, minutes: 90, fee: 4500 })).line; await h.ok('billing/plans/send', { auth, familyId: fam.id }); return h.rows('select * from planLines where id = ?', line.id)[0]; };
  return { h, auth, fam, kid, parent, plan };
}
// 送る先（Apps Script）のふり。reply が関数なら呼ぶたびに決める
function withFetch(reply, fn) {
  const original = globalThis.fetch, asked = [];
  globalThis.fetch = async (url, init) => { asked.push(JSON.parse(init.body)); const r = typeof reply === 'function' ? reply(asked.length) : reply; return { ok: !r.fail, status: r.fail ? 500 : 200, json: async () => (r.fail ? { error: 'GAS error' } : { writebacks: [] }) }; };
  return fn().finally(() => { globalThis.fetch = original; }).then(() => asked);
}

test('terms: no version means nothing is asked; setting a version makes every family agree before approving a plan', async () => {
  const { h, auth, parent, plan } = await world();
  assert.deepEqual((await h.ok('family/terms', { auth: parent })).terms, { current: { version: '', title: '', url: '', from: '', note: '' }, agreed: { version: '', at: '' }, needs: false });
  const l1 = await plan();
  assert.equal((await h.ok('family/plans/decide', { auth: parent, id: l1.id, version: l1.version, approvedCount: 4 })).line.status, 'approved', '版がなければ同意なしで承認できる');
  assert.equal((await h.call('admin/terms/set', { auth, version: '2026-11', title: '' })).error.code, 'needTitle');
  assert.equal((await h.call('admin/terms/set', { auth, version: '2026-11', title: '受講規約', url: 'http://insecure' })).error.code, 'badUrl');
  const set = await h.ok('admin/terms/set', { auth, version: '2026-11', title: '受講規約（2026年11月版）', url: 'https://example.invalid/terms.pdf', from: '2026-11-01', note: '取消料の決まりが新しくなります' });
  assert.equal(set.terms.version, '2026-11');
  const t = (await h.ok('family/money', { auth: parent })).terms;
  assert.deepEqual([t.needs, t.current.title, t.agreed.version], [true, '受講規約（2026年11月版）', '']);
  const l2 = (await h.ok('billing/plans/save', { auth, studentId: l1.studentId, subject: '英語', kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: 4, minutes: 90, fee: 4500 })).line;
  await h.ok('billing/plans/send', { auth, familyId: (await h.ok('family/me', { auth: parent })).me.id });
  const cur = () => h.rows('select * from planLines where id = ?', l2.id)[0];
  assert.equal((await h.call('family/plans/decide', { auth: parent, id: l2.id, version: cur().version, approvedCount: 4 })).error.code, 'needTerms', '同意していないと承認できない');
  assert.equal((await h.ok('family/plans/decide', { auth: parent, id: l2.id, version: cur().version, approvedCount: 0 })).line.status, 'declined', '見送りは同意がなくてもよい');
  assert.equal((await h.call('family/terms/accept', { auth: parent, version: '2026-11' })).error.code, 'needAgree');
  assert.equal((await h.call('family/terms/accept', { auth: parent, version: '2026-10', agree: true })).error.code, 'staleVersion');
  const acc = await h.ok('family/terms/accept', { auth: parent, version: '2026-11', agree: true });
  assert.deepEqual([acc.terms.needs, acc.terms.agreed.version], [false, '2026-11']);
  assert.deepEqual(h.rows('select version, via, actorKind from termsConsents').map(r => [r.version, r.via, r.actorKind]), [['2026-11', '保護者ページ', 'family']]);
  // 同意したあとの承認は、行に版が残る
  const l3 = (await h.ok('billing/plans/save', { auth, studentId: l1.studentId, subject: '国語', kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: 2, minutes: 90, fee: 4500 })).line;
  await h.ok('billing/plans/send', { auth, familyId: (await h.ok('family/me', { auth: parent })).me.id });
  const c3 = h.rows('select * from planLines where id = ?', l3.id)[0];
  const ok = await h.ok('family/plans/decide', { auth: parent, id: l3.id, version: c3.version, approvedCount: 2 });
  assert.deepEqual([ok.line.status, ok.line.termsVersion], ['approved', '2026-11']);
  // 版を変えると、また同意が要る。教室管理者が書面の同意を記録できる
  await h.ok('admin/terms/set', { auth, version: '2026-12', title: '受講規約（12月版）', url: '' });
  assert.equal((await h.ok('family/terms', { auth: parent })).terms.needs, true);
  const fid = (await h.ok('family/me', { auth: parent })).me.id;
  assert.equal((await h.call('admin/families/terms', { auth, id: fid, date: '2026-11-20' })).error.code, 'needVia');
  const rec = await h.ok('admin/families/terms', { auth, id: fid, date: '2026-11-20', via: '書面', note: '面談で署名' });
  assert.deepEqual([rec.terms.needs, rec.terms.agreed.version, rec.terms.agreed.at], [false, '2026-12', '2026-11-20']);
  const g = await h.ok('admin/terms/get', { auth });
  assert.deepEqual([g.terms.version, g.families, g.history.length, g.history[0].via], ['2026-12', { total: 1, agreed: 1 }, 2, '書面']);
  const f = (await h.ok('admin/families/get', { auth, id: fid }));
  assert.deepEqual([f.terms.version, f.family.termsVersion], ['2026-12', '2026-12']);
  // 先生が LINE の承諾を記録した行にも、そのときの版が残る
  const l4 = (await h.ok('billing/plans/save', { auth, studentId: l1.studentId, subject: '理科', kind: '通常', startDate: '2026-12-01', endDate: '2026-12-31', count: 2, minutes: 90, fee: 4500 })).line;
  await h.ok('billing/plans/consent', { auth, id: l4.id, version: h.rows('select version from planLines where id = ?', l4.id)[0].version, consentDate: '2026-10-02', via: 'LINE' });
  assert.equal(h.rows('select termsVersion from planLines where id = ?', l4.id)[0].termsVersion, '2026-12');
});

test('effects: failed mail shows up for the manager, can be re-sent, and the nightly run retries up to 3 times', async () => {
  const { h, auth, fam } = await world();
  h.env.GAS_URL = 'https://gas.example.invalid/exec'; h.env.SYNC_KEY = 'x'.repeat(32);
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', ?)").run(new Date(h.clock).toISOString());
  // 送る先が落ちている: 招待のメールが failed になる
  await withFetch({ fail: true }, async () => { await h.ok('admin/families/invite', { auth, id: fam.id }); });
  let list = await h.ok('admin/effects/list', { auth });
  assert.equal(list.failed.length, 1);
  assert.deepEqual([list.failed[0].kind, list.failed[0].label, list.failed[0].status, list.failed[0].attempts, list.failed[0].to], ['mail', 'メール', 'failed', 1, 'parent@example.invalid']);
  assert.match(list.failed[0].error, /GAS error/);
  const id = list.failed[0].id;
  // 送り直す（今度は届く）
  const asked = await withFetch({ fail: false }, async () => { const r = await h.ok('admin/effects/retry', { auth, ids: [id] }); assert.deepEqual([r.sent, r.failed], [1, 0]); });
  assert.equal(asked.length, 1); assert.equal(asked[0].items[0].kind, 'mail');
  list = await h.ok('admin/effects/list', { auth });
  assert.deepEqual([list.failed.length, list.recent.length, list.recent[0].status], [0, 1, 'sent']);
  assert.equal((await h.call('admin/effects/retry', { auth, ids: [id] })).error.code, 'nothing', '送ったものはもう送り直せない');
  // 失敗したままのものは、定期実行が 3 回まで送り直す
  await withFetch({ fail: true }, async () => { await h.ok('family/reset/request', { email: 'parent@example.invalid' }); });
  const failedId = h.rows("select id from effects where status = 'failed'")[0].id;
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  await withFetch({ fail: true }, async () => { await runV2Scheduled(h.env, h.clock + 60e3); await runV2Scheduled(h.env, h.clock + 120e3); });
  assert.equal(h.rows('select attempts from effects where id = ?', failedId)[0].attempts, 3);
  const asked2 = await withFetch({ fail: false }, async () => { await runV2Scheduled(h.env, h.clock + 180e3); });
  assert.equal(asked2.length, 0, '3 回失敗したものは自動では送り直さない');
  // 取り下げる
  assert.equal((await h.ok('admin/effects/dismiss', { auth, ids: [failedId] })).dismissed, 1);
  assert.equal(h.rows('select status from effects where id = ?', failedId)[0].status, 'dismissed');
  assert.equal((await h.call('admin/effects/list', { auth: 'bad' })).error.code, 'needLogin');
});
