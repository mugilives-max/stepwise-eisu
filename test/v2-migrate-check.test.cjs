'use strict';
// 作り直し（v2）8段目: 移行の照らし合わせと、切り替えの予行。cf/v2/migrate-check.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

async function legacyWorld() {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500), ('s2', '架空 花子', 1, 'code-two-xxxxxxxx', 1500), ('s3', '見本 次郎', 1, 'code-three-xxxxxx', 1500)");
  q("insert into familyAccounts (id, label, status) values ('A', 'x', 'pending')"); q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1), ('l2', 'A', 's2', 'true')");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode, eventId) values ('a', '2026-09-08', '17:00', 90, 'booked', 's1', 'true', '数学', 'in_person', 'gcal-a'), ('b', '2026-10-20', '17:00', 60, 'booked', 's2', '', '英語', 'online', 'gcal-b'), ('c', '2026-10-27', '17:00', 60, 'offered', 's3', '', '英語', 'in_person', '')");
  q("insert into planLines (id, studentId, subject, kind, count, startDate, endDate, lessonMin, rate30, status, approvedCount, approvedVia, consentDate) values ('p1', 's1', '数学', '', 4, '2026-09-01', '2026-09-30', 90, 933, 'approved', 4, '保護者ページ', '2026-08-25')");
  q("insert into lessonRecords (id, studentId, slotId, lessonDate, subject, content, status, reportJson, revision) values ('r1', 's1', 'a', '2026-09-08', '数学', 'よくできた', 'active', '{}', 1), ('r2', 's1', 'gone', '2026-08-29', '', '消えた枠', 'active', '{}', 1)");
  q("insert into events (id, studentId, date, kind, title) values ('e1', 's1', '2026-10-14', 'test', '中間テスト')");
  q(`insert into "入金管理" ("年月", "生徒ID", "請求額", "請求日", "状態", "請求ID", "実績JSON") values ('2026-09', 's1', 2799, '2026-10-03', '入金済', 'inv1', ?)`, JSON.stringify([{ id: 'a', date: '2026-09-08', start: '17:00', min: 90, subject: '数学', kind: '', amount: 2799, lineId: 'p1' }]));
  q('insert into "成績推移" ("生徒ID") values (\'s1\')');
  return { h, auth, q };
}

test('the check counts the current ledger directly and explains every expected difference', async () => {
  const { h, auth } = await legacyWorld();
  await h.ok('admin/migrate/all/apply', { auth, confirm: true });
  const r = await h.ok('admin/migrate/check', { auth });
  const get = item => r.rows.find(x => x.item === item);
  assert.equal(r.problems, 0, JSON.stringify(r.rows.filter(x => !x.same && !x.expected)));
  assert.deepEqual([get('家族').old, get('家族').new, get('家族').expected], [2, 2, false], '家族に入っていない生徒は1人の家族になる');
  assert.deepEqual([get('授業（すべて）').old, get('授業（すべて）').new], [3, 3]);
  assert.deepEqual([get('授業: 実施済み').new, get('授業: 決定').new, get('授業: 仮予定').new], [1, 1, 1]);
  assert.deepEqual([get('授業記録').old, get('授業記録').new, get('授業記録').expected], [2, 1, true], '枠の消えた記録は写さない（理由つき）');
  assert.deepEqual([get('生徒の専用リンク（同じ鍵のまま）').old, get('生徒の専用リンク（同じ鍵のまま）').new], [3, 3]);
  assert.equal(get('1回の授業料を入力した金額に戻した計画').new, 1, '2,799円 → 2,800円');
  assert.deepEqual([get('請求（金額の合計）').old, get('請求（金額の合計）').new], [2799, 2799]);
  assert.ok(r.skip.some(s => s.table === '成績推移'), '写さないものも一覧に出す');
  // 写したあとで今の仕組みに授業が増えたら、差として出る
  h.db._sqlite.prepare("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('d', '2026-10-28', '17:00', 60, 'booked', 's1', '', '数学', 'in_person')").run();
  const r2 = await h.ok('admin/migrate/check', { auth });
  assert.equal(r2.problems > 0, true, '写し直しが要る');
});

test('the cutover rehearsal counts what would happen at the switch without doing anything', async () => {
  const { h, auth } = await legacyWorld();
  await h.ok('admin/migrate/all/apply', { auth, confirm: true });
  const before = h.rows('select count(*) n from effects')[0].n;
  const p = await h.ok('admin/cutover/preview', { auth });
  assert.equal(p.live, false);
  assert.deepEqual([p.families.total, p.families.canLogin, p.families.noEmail], [2, 0, 2]);
  assert.deepEqual([p.calendar.keep, p.calendar.create, p.calendar.onlineWithoutMeet], [1, 0, 1], '今の仕組みのカレンダーの予定はそのまま引き継ぐ');
  assert.equal(p.open.proposed, 1);
  assert.ok(p.lastCopy);
  assert.equal(h.rows('select count(*) n from effects')[0].n, before, '予行では何も送らない');
  const teacherAuth = await h.staffWith(auth, ['teacher', 'manager'], 'm@example.invalid');
  assert.equal((await h.call('admin/cutover/preview', { auth: teacherAuth })).error.code, 'forbidden', 'システム管理者だけ');
});
