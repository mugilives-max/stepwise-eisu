'use strict';
// 作り直し（v2）: 台帳の控え（cf/v2/backup.mjs）。毎日の定期実行で全表を R2 の backup/<日付>.json に置き、90 日より古いものを消す。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

const at = s => Date.parse(s + '+09:00');
const stored = (h, key) => JSON.parse(Buffer.from(h.env.FILES._m.get(key).b).toString('utf8'));

test('backup: the manager takes a snapshot of every table into R2, lists it, and old ones are pruned', async () => {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 });
  // 古い控え（消える）と、残る控え
  await h.env.FILES.put('backup/2026-01-01.json', '{}', { customMetadata: { rows: '1' } });
  await h.env.FILES.put('backup/2026-09-01.json', '{}', { customMetadata: { rows: '2' } });

  const r = await h.ok('admin/backup/run', { auth });
  assert.equal(r.key, 'backup/' + new Date(h.clock + 9 * 3600e3).toISOString().slice(0, 10) + '.json');
  assert.ok(r.tables >= 30, '全表（' + r.tables + '）');
  assert.ok(r.rows > 0 && r.bytes > 100);
  assert.equal(r.removed, 1, '90 日より古いものだけ消す');

  const json = stored(h, r.key);
  assert.equal(json.tables.students.length, 1);
  assert.equal(json.tables.students[0].givenName, '一郎');
  assert.equal(json.counts.families, 1);
  assert.ok(json.tables.staff[0].passwordHash === undefined || typeof json.tables.staff[0].passwordHash === 'string', '表はそのまま（控えは R2 の中でだけ読める）');

  const list = await h.ok('admin/backup/list', { auth });
  assert.equal(list.latest.rows, r.rows, '行数は一覧でも見える');
  assert.equal(list.latest.size, r.bytes, '大きさはバイト数');
  assert.deepEqual(list.recent.map(x => x.key), [r.key, 'backup/2026-09-01.json']);
  assert.equal(list.latest.key, r.key);
  assert.equal(list.stale, false);
  assert.equal(list.count, 2);
  assert.equal(h.rows("select action from auditLog where action = 'backupRun'").length, 1);
});

test('backup: the nightly job takes the snapshot before anything else and does not stop the rest when it fails', async () => {
  const h = await createV2(); await h.owner();
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  const r1 = await runV2Scheduled(h.env, at('2026-10-11T00:10:00'));
  assert.equal(r1.backup.key, 'backup/2026-10-11.json');
  assert.ok(h.env.FILES._m.has('backup/2026-10-11.json'));
  // 同じ日に 2 回走っても 1 つ（上書き）
  await runV2Scheduled(h.env, at('2026-10-11T00:20:00'));
  assert.equal([...h.env.FILES._m.keys()].filter(k => k.startsWith('backup/')).length, 1);
  // R2 が壊れていても、ほかの処理は走る
  const broken = h.env.FILES.put; h.env.FILES.put = async () => { throw new Error('R2 down'); };
  const r2 = await runV2Scheduled(h.env, at('2026-10-12T00:10:00'));
  h.env.FILES.put = broken;
  assert.equal(r2.backup.error, 'R2 down');
  assert.ok(r2.invoices, 'ほかの処理の結果はある');
});

test('backup: teachers cannot take or see it, the service key can only look, and a stale state is flagged', async () => {
  const h = await createV2(); const auth = await h.owner();
  const teacher = await h.staffWith(auth, ['teacher'], 'teacher@example.invalid');
  assert.equal((await h.call('admin/backup/run', { auth: teacher })).error.code, 'forbidden');
  assert.equal((await h.call('admin/backup/list', { auth: teacher })).error.code, 'forbidden');
  const KEY = 'k'.repeat(40); h.env.V2_SERVICE_KEY = KEY;
  const seen = await h.ok('admin/backup/list', { serviceKey: KEY });
  assert.equal(seen.latest, null);
  assert.equal(seen.stale, true, '控えが無ければ「古い」');
  assert.equal((await h.call('admin/backup/run', { serviceKey: KEY })).error.code, 'service', '外からは取れない');
  delete h.env.V2_SERVICE_KEY;
  // 3 日前の控えしか無ければ古い
  await h.env.FILES.put('backup/' + new Date(h.clock - 3 * 86400e3 + 9 * 3600e3).toISOString().slice(0, 10) + '.json', '{}', {});
  assert.equal((await h.ok('admin/backup/list', { auth })).stale, true);
  await h.ok('admin/backup/run', { auth });
  assert.equal((await h.ok('admin/backup/list', { auth })).stale, false);
});
