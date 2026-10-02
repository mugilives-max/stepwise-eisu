'use strict';
// 作り直し（v2）5段目: 授業計画・キャンセル料・請求、今の台帳からの写し。cf/v2/billing.mjs・plan-calc.mjs・migrate-billing.mjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createV2 } = require('./helpers/v2-harness.cjs');

const at = s => Date.parse(s + '+09:00');
async function world() {
  const h = await createV2(); const auth = await h.owner();
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', email: 'parent@example.invalid' })).family;
  const kid = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '一郎', baseRate30: 1500 })).student;
  const sis = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花子', baseRate30: 1500 })).student;
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom((await h.ok('admin/families/invite', { auth, id: fam.id }), h.mails().at(-1))), password: 'family password 1' })).auth;
  // 9月の授業を作って決定する（9/1 の時点で）
  const lesson = async (studentId, date, start = '17:00', subject = '数学', minutes = 60) => {
    const keep = h.clock; h.clock = at('2026-09-01T09:00:00');
    await h.ok('schedule/lessons/create', { auth, studentId, date, start, minutes, subject, deliveryMode: 'in_person', force: true });
    const l = h.rows('select * from lessons where studentId = ? and date = ? and start = ?', studentId, date, start)[0];
    await h.ok('schedule/lessons/decide', { auth, id: l.id, version: l.version });
    h.clock = keep;
    return h.rows('select * from lessons where id = ?', l.id)[0];
  };
  const done = async l => { const cur = h.rows('select * from lessons where id = ?', l.id)[0]; await h.ok('schedule/lessons/done', { auth, id: cur.id, version: cur.version }); };
  const plan = async (studentId, extra = {}) => (await h.ok('billing/plans/save', { auth, studentId, subject: '数学', kind: '通常', startDate: '2026-09-01', endDate: '2026-09-30', count: 4, minutes: 60, fee: 3200, ...extra })).line;
  const line = id => h.rows('select * from planLines where id = ?', id)[0];
  return { h, auth, fam, kid, sis, parent, lesson, done, plan, line };
}

test('plans: overlap is refused, add-ons stay inside the parent, sending notifies the family once, and families approve with fewer lessons', async () => {
  const { h, auth, kid, sis, parent, plan, line, lesson } = await world();
  const a = await plan(kid.id), b = await plan(sis.id, { subject: '英語' });
  assert.equal((await h.call('billing/plans/save', { auth, studentId: kid.id, subject: '数学', kind: '通常', startDate: '2026-09-15', endDate: '2026-10-15', count: 2, minutes: 60, fee: 3200 })).error.code, 'overlap');
  assert.equal((await h.call('billing/plans/save', { auth, studentId: kid.id, parentId: a.id, subject: '数学', kind: '通常', startDate: '2026-09-20', endDate: '2026-10-05', count: 2, minutes: 60, fee: 3200 })).error.code, 'badParent', '追加の計画は元の期間の中');
  const add = (await h.ok('billing/plans/save', { auth, studentId: kid.id, parentId: a.id, subject: '数学', kind: '通常', startDate: '2026-09-20', endDate: '2026-09-30', count: 2, minutes: 60, fee: 3200, comment: 'テスト前の追加' })).line;
  assert.equal((await h.ok('family/money', { auth: parent })).plans.length, 0, '下書きは見せない');
  const before = h.mails().length;
  assert.equal((await h.ok('billing/plans/send', { auth, familyId: kid.familyId })).sent, 3);
  assert.equal(h.mails().length, before + 1, '家族に1通');
  assert.equal(h.mails().at(-1).status, 'dismissed', '切り替え前は送らない');
  await lesson(kid.id, '2026-09-08'); await lesson(kid.id, '2026-09-15');
  const money = await h.ok('family/money', { auth: parent });
  assert.equal(money.plans.find(p => p.id === a.id).minCount, 2, 'すでに決まっている授業より少なくはできない');
  assert.equal((await h.call('family/plans/decide', { auth: parent, id: a.id, version: line(a.id).version, approvedCount: 1 })).error.code, 'badCount');
  const ok = await h.ok('family/plans/decide', { auth: parent, id: a.id, version: line(a.id).version, approvedCount: 3 });
  assert.deepEqual([ok.line.status, ok.line.approvedCount, ok.line.approvedVia, ok.line.approvedBy], ['approved', 3, '保護者ページ', 'family']);
  await h.ok('family/plans/decide', { auth: parent, id: b.id, version: line(b.id).version, approvedCount: 0 });
  assert.equal(line(b.id).status, 'declined', '0回は見送り');
  // LINE での承諾を先生が記録し、保護者が確かめる
  assert.equal((await h.call('billing/plans/consent', { auth, id: add.id, version: line(add.id).version, consentDate: '2026-10-02' })).error.code, 'needVia');
  assert.equal((await h.call('billing/plans/consent', { auth, id: add.id, version: line(add.id).version, consentDate: '2026-10-01', via: 'LINE' })).error.code, 'needNote', '期間のあとの承諾は事情を書く');
  await h.ok('billing/plans/consent', { auth, id: add.id, version: line(add.id).version, consentDate: '2026-10-01', via: 'LINE', note: '9/19 に LINE で相談済み' });
  assert.equal((await h.call('family/plans/ack', { auth: parent, id: add.id, version: line(add.id).version, ack: 'inquiry' })).error.code, 'needNote');
  await h.ok('family/plans/ack', { auth: parent, id: add.id, version: line(add.id).version, ack: 'inquiry', note: '回数を確かめたいです' });
  assert.match(h.mails().at(-1).subject, /計画の問い合わせ/);
  // 直すと承認は消えて下書きに戻る
  const edited = await h.ok('billing/plans/save', { auth, id: a.id, version: line(a.id).version, fee: 3300 });
  assert.deepEqual([edited.line.status, edited.line.approvedCount], ['draft', null]);
});

test('the month bill: approved lessons at the plan fee, unapproved ones wait, open issues block, and confirming freezes the lessons', async () => {
  const { h, auth, kid, sis, parent, plan, line, lesson, done } = await world();
  const a = await plan(kid.id, { count: 2 });
  await h.ok('billing/plans/consent', { auth, id: a.id, version: line(a.id).version, consentDate: '2026-09-01', via: '電話' });
  const l1 = await lesson(kid.id, '2026-09-08'), l2 = await lesson(kid.id, '2026-09-15', '17:00', '数学', 90), l3 = await lesson(kid.id, '2026-09-22'), s1 = await lesson(sis.id, '2026-09-10', '18:00', '英語');
  h.clock = at('2026-10-02T12:00:00');
  for (const l of [l1, l2, l3]) await done(l);
  let p = (await h.ok('billing/family', { auth, familyId: kid.familyId, month: '2026-09' })).preview;
  assert.equal(p.canConfirm, false); assert.match(p.issues.join(), /花子さん 09\/10 英語 が実施済みになっていません/);
  await done(s1);
  p = (await h.ok('billing/family', { auth, familyId: kid.familyId, month: '2026-09' })).preview;
  const kidRow = p.students.find(s => s.studentId === kid.id);
  assert.deepEqual(kidRow.items.map(i => i.amount), [3200, 4800], '計画の1回の授業料。長さが違えば時間で割り戻す');
  assert.equal(kidRow.pending.length, 1, '計画の回数を超えた授業は承認待ち');
  assert.equal(p.students.find(s => s.studentId === sis.id).pending[0].estimate, 3000, '計画のない授業の見込みは基本単価');
  assert.deepEqual([p.total, p.canConfirm, p.auto], [8000, true, false], '承認のない授業があると自動では確定しない');
  assert.equal((await h.call('billing/confirm', { auth, familyId: kid.familyId, month: '2026-09', expectedTotal: 7999 })).error.code, 'changed');
  const inv = (await h.ok('billing/confirm', { auth, familyId: kid.familyId, month: '2026-09', expectedTotal: 8000 })).invoice;
  assert.equal(inv.total, 8000);
  assert.equal((await h.call('billing/confirm', { auth, familyId: kid.familyId, month: '2026-09' })).error.code, 'already');
  assert.deepEqual(h.rows('select invoiceId from lessons where id in (?, ?)', l1.id, l2.id).map(r => r.invoiceId), [inv.id, inv.id]);
  assert.equal((await h.call('billing/plans/save', { auth, id: a.id, version: line(a.id).version, fee: 1 })).error.code, 'locked', '請求に入った計画は直せない');
  // 保護者: 請求を見る・振込の連絡。教室管理者: 入金を記録
  const fam = await h.ok('family/money', { auth: parent });
  assert.deepEqual([fam.invoices[0].total, fam.invoices[0].items.length], [8000, 2]);
  await h.ok('family/invoices/report', { auth: parent, id: inv.id, version: inv.version });
  assert.match(h.mails().at(-1).subject, /振込の連絡/);
  const cur = h.rows('select * from invoices where id = ?', inv.id)[0];
  assert.equal((await h.call('billing/void', { auth, id: inv.id, version: cur.version })).error.code, 'needReason');
  await h.ok('billing/paid', { auth, id: inv.id, version: cur.version, paidOn: '2026-10-02' });
  assert.equal((await h.call('billing/void', { auth, id: inv.id, version: cur.version + 1, reason: 'x' })).error.code, 'paid');
  await h.ok('billing/paid', { auth, id: inv.id, version: cur.version + 1, undo: true, reason: '別の家族の入金だった' });
  assert.equal(h.rows('select status from invoices where id = ?', inv.id)[0].status, 'reported');
  await h.ok('billing/void', { auth, id: inv.id, version: cur.version + 2, reason: '金額の誤り' });
  assert.equal(h.rows('select count(*) n from lessons where invoiceId <> ?', '')[0].n, 0, '取り消すと授業は請求前に戻る');
  // 承認が足りたら、次の確定で全部入る
  await h.ok('billing/plans/save', { auth, studentId: sis.id, subject: '英語', kind: '通常', startDate: '2026-09-01', endDate: '2026-09-30', count: 1, minutes: 60, fee: 2800 });
  const ln = h.rows("select * from planLines where studentId = ? and subject = '英語'", sis.id)[0];
  await h.ok('billing/plans/consent', { auth, id: ln.id, version: ln.version, consentDate: '2026-09-01', via: 'LINE', note: '9/1 に口頭で承諾' });
  const again = await h.ok('billing/confirm', { auth, familyId: kid.familyId, month: '2026-09' });
  assert.equal(again.invoice.total, 3200 + 4800 + 2800);
});

test('cancellation fees: late notice is 1,000 yen, a no-show costs the lesson, decisions need reasons, and families can ask for relief', async () => {
  const { h, auth, kid, parent, plan, line, lesson } = await world();
  const a = await plan(kid.id, { fee: 3500 });
  await h.ok('billing/plans/consent', { auth, id: a.id, version: line(a.id).version, consentDate: '2026-09-01', via: '電話' });
  const l1 = await lesson(kid.id, '2026-09-08'), l2 = await lesson(kid.id, '2026-09-09');
  h.clock = at('2026-09-07T23:30:00');
  await h.ok('family/lessons/request', { auth: parent, lessonId: l1.id, kind: 'cancel', note: '熱が出ました' });
  let fee = h.rows('select * from cancellationFees where lessonId = ?', l1.id)[0];
  assert.deepEqual([fee.type, fee.standardAmount, fee.decision], ['late', 1000, 'pending']);
  const rq = h.rows("select id from lessonRequests where lessonId = ? and kind = 'cancel'", l1.id)[0];
  await h.ok('family/lessons/withdraw', { auth: parent, requestId: rq.id });
  assert.equal(h.rows('select count(*) n from cancellationFees')[0].n, 0, '取り下げたらキャンセル料も消える');
  await h.ok('family/lessons/request', { auth: parent, lessonId: l1.id, kind: 'cancel', note: '熱が出ました' });
  h.clock = at('2026-09-09T18:30:00');
  const cur2 = h.rows('select * from lessons where id = ?', l2.id)[0];
  await h.ok('schedule/lessons/cancel', { auth, id: l2.id, version: cur2.version });
  const noshow = h.rows('select * from cancellationFees where lessonId = ?', l2.id)[0];
  assert.deepEqual([noshow.type, noshow.standardAmount], ['noshow', 3500], '開始後は授業料');
  fee = h.rows('select * from cancellationFees where lessonId = ?', l1.id)[0];
  assert.equal((await h.call('billing/fees/decide', { auth, id: fee.id, version: fee.version, decision: 'waive' })).error.code, 'needNote');
  await h.ok('billing/fees/decide', { auth, id: fee.id, version: fee.version, decision: 'charge' });
  await h.ok('billing/fees/decide', { auth, id: noshow.id, version: noshow.version, decision: 'adjust', amount: 1500, note: '初回のため減額' });
  assert.match(h.mails().at(-1).body, /1,500円/);
  const money = await h.ok('family/money', { auth: parent });
  assert.equal(money.fees.length, 2);
  fee = h.rows('select * from cancellationFees where lessonId = ?', l1.id)[0];
  await h.ok('family/fees/relief', { auth: parent, id: fee.id, version: fee.version, reason: '病院の受診のためでした' });
  h.clock = at('2026-10-02T12:00:00');
  let p = (await h.ok('billing/family', { auth, familyId: kid.familyId, month: '2026-09' })).preview;
  assert.match(p.issues.join(), /減額・免除の申請があります/);
  fee = h.rows('select * from cancellationFees where lessonId = ?', l1.id)[0];
  await h.ok('billing/fees/relief', { auth, id: fee.id, version: fee.version, result: 'waived', response: 'お大事になさってください' });
  p = (await h.ok('billing/family', { auth, familyId: kid.familyId, month: '2026-09' })).preview;
  assert.deepEqual([p.total, p.canConfirm, p.students[0].items.map(i => i.label)], [1500, true, ['キャンセル料（減額）']]);
  const cur = h.rows('select * from lessons where id = ?', l2.id)[0];
  await h.ok('billing/confirm', { auth, familyId: kid.familyId, month: '2026-09' });
  assert.equal((await h.call('schedule/lessons/delete', { auth, id: l2.id, version: cur.version })).error.code, 'invoiced');
});

test('auto close runs only after the switch-over, from the 3rd, and holds families with something to check', async () => {
  const { h, auth, kid, sis, plan, line, lesson, done } = await world();
  const fam2 = (await h.ok('admin/families/create', { auth, name: '見本家', email: 'other@example.invalid' })).family;
  const other = (await h.ok('admin/students/create', { auth, familyId: fam2.id, familyName: '見本', givenName: '太郎', baseRate30: 1500 })).student;
  for (const s of [kid, other]) { const a = await plan(s.id); await h.ok('billing/plans/consent', { auth, id: a.id, version: line(a.id).version, consentDate: '2026-09-01', via: '電話' }); }
  const l1 = await lesson(kid.id, '2026-09-08'), l2 = await lesson(other.id, '2026-09-08', '19:00'), l3 = await lesson(sis.id, '2026-09-09');
  h.clock = at('2026-10-02T12:00:00'); for (const l of [l1, l2, l3]) await done(l);
  const { runV2Scheduled } = await import('../cf/v2/index.mjs');
  assert.equal((await runV2Scheduled(h.env, at('2026-10-03T00:10:00'))).invoices.skipped, 'notLive');
  h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', '')").run();
  assert.equal((await runV2Scheduled(h.env, at('2026-10-02T00:10:00'))).invoices.skipped, 'beforeClose');
  const r = (await runV2Scheduled(h.env, at('2026-10-03T00:10:00'))).invoices;
  assert.deepEqual([r.month, r.confirmed, r.held], ['2026-09', 1, 1], '花子さんの授業に計画がない家族は止める');
  assert.equal(h.rows('select familyId from invoices')[0].familyId, fam2.id);
  assert.ok(h.mails().some(m => /9月分の請求で確かめることがあります/.test(m.subject)));
});

test('the copy from the current ledger: plans, cancelled lessons with fees, and family invoices that compare equal', async () => {
  const h = await createV2(); const auth = await h.owner();
  const q = (sql, ...a) => h.db._sqlite.prepare(sql).run(...a);
  q("insert into students (id, name, active, code, rate30) values ('s1', '架空 一郎', 1, 'code-one-xxxxxxxx', 1500), ('s2', '架空 花子', 1, 'code-two-xxxxxxxx', 1500)");
  q("insert into familyAccounts (id, label, status) values ('A', 'x', 'pending')"); q("insert into familyLinks (id, familyId, studentId, active) values ('l1', 'A', 's1', 1), ('l2', 'A', 's2', 1)");
  q("insert into slots (id, date, start, min, status, studentId, done, subject, deliveryMode) values ('a', '2026-09-08', '17:00', 90, 'booked', 's1', 'true', '数学', 'in_person'), ('b', '2026-09-10', '17:00', 60, 'booked', 's2', 'true', '英語', 'in_person')");
  q("insert into planLines (id, studentId, subject, kind, count, startDate, endDate, lessonMin, rate30, status, approvedCount, approvedVia, consentDate) values ('p1', 's1', '数学', '', 4, '2026-09-01', '2026-09-30', 90, 833, 'approved', 4, '保護者ページ', '2026-08-25'), ('p2', 's2', '英語', '', 4, '2026-09-01', '2026-09-30', 60, 1500, 'approved', 4, 'LINE', '2026-08-26')");
  const quote = { type: 'late', amount: 1000, slot: { id: 'gone', date: '2026-09-15', start: '17:00', min: 60, subject: '英語', deliveryMode: 'in_person' }, receivedAt: '2026-09-14T15:00:00Z' };
  q("insert into cancellationFees (id, studentId, slotId, status, decisionJson, createdAt) values ('c1', 's2', 'gone', 'confirmed', ?, '2026-09-14T15:01:00Z')", JSON.stringify({ choice: 'charge', amount: 1000, quote }));
  const item = (id, date, min, subject, amount) => ({ id, date, start: '17:00', min, subject, kind: '', amount, lineId: id === 'a' ? 'p1' : 'p2' });
  q(`insert into "入金管理" ("年月", "生徒ID", "請求額", "請求日", "状態", "請求ID", "実績JSON") values ('2026-09', 's1', 2499, '2026-10-03', '未入金', 'inv1', ?), ('2026-09', 's2', 4000, '2026-10-03', '未入金', 'inv2', ?)`,
    JSON.stringify([item('a', '2026-09-08', 90, '数学', 2499)]), JSON.stringify([item('b', '2026-09-10', 60, '英語', 3000), { id: 'cancel-fee:c1', type: 'cancellation', date: '2026-09-15', start: '17:00', subject: '英語', min: 0, amount: 1000 }]));
  q("insert into approvalEvents (id, studentId, ym, event, recordedAt) values ('e1', 'family:A', '2026-09', 'transferReported', '2026-10-04T01:00:00Z')");
  await h.ok('admin/migrate/identity/apply', { auth, confirm: true });
  await h.ok('admin/migrate/schedule/apply', { auth, confirm: true });
  await h.ok('admin/migrate/records/apply', { auth, confirm: true });
  const pre = await h.ok('admin/migrate/billing/preview', { auth });
  assert.deepEqual([pre.planLines.total, pre.cancelled, pre.fees, pre.invoices.total], [2, 1, 1, 1]);
  await h.ok('admin/migrate/billing/apply', { auth, confirm: true });
  assert.deepEqual(h.rows('select fee from planLines order by id').map(r => r.fee), [2499, 3000], '1回の授業料は30分あたりの単価から');
  const inv = h.rows('select * from invoices')[0];
  assert.deepEqual([inv.total, inv.status, inv.reportedAt], [6499, 'reported', '2026-10-04T01:00:00Z'], '家族でまとめ、振込の連絡も写す');
  assert.deepEqual(h.rows("select status from lessons where legacyId like 'cx:%'").map(r => r.status), ['cancelled']);
  assert.equal(h.rows('select invoiceId from cancellationFees')[0].invoiceId, inv.id);
  assert.equal(h.rows("select count(*) n from lessons where invoiceId <> ''")[0].n, 2);
  const cmp = await h.ok('admin/migrate/billing/compare', { auth, month: '2026-09' });
  assert.deepEqual([cmp.families[0].old, cmp.families[0].new, cmp.families[0].same], [6499, 6499, true]);
  assert.equal((await h.call('admin/migrate/schedule/apply', { auth, confirm: true })).error.code, 'useAll');
  const all = await h.ok('admin/migrate/all/apply', { auth, confirm: true });
  assert.equal(all.billing.invoices, 1);
  assert.equal(h.rows('select count(*) n from invoices')[0].n, 1, '写し直しても増えない');
});
