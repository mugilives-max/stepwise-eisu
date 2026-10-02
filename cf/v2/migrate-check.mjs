// 移行の照らし合わせ（8段目）。今の台帳（env.DB）の元の件数・金額と、新しい台帳（env.DB2）に写したものを項目ごとに並べる。
// 写す道具（migrate-*.mjs）の計画を通さず、元の表を直接数えるので、写し方の取りこぼしも見つかる。
// 差があるときは、決めて写さないもの（理由つき）か、確かめが要るものかを示す。
// あわせて、切り替えの予行（cutover/preview）: 切り替えた瞬間に何が起きるか（カレンダー・メール・ログイン）を、実際には何もせずに数える。
import { fail } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { isLive } from './accounts.mjs';
import { todayJst } from './schedule.mjs';
import { typedFee } from './migrate-billing.mjs';

const truthy = v => v === 1 || v === true || v === '1' || v === 'true' || v === 'TRUE';
const parse = (v, d) => { try { const o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : d; } catch { return d; } };

export async function checkRows(old, db2) {
  const all = async (d, sql) => (await d.prepare(sql).all()).results;
  const one = async (d, sql) => (await d.prepare(sql).first()) || {};
  const rows = [], add = (area, item, o, n, note = '', expected = false) => rows.push({ area, item, old: o, new: n, same: o === n, note, expected: o !== n && expected });

  // 家族・生徒
  const students = await all(old, 'select id, code from students');
  const links = (await all(old, 'select studentId, active from familyLinks')).filter(l => truthy(l.active));
  const linked = new Set(links.map(l => String(l.studentId)));
  const accounts = await all(old, 'select id, status, email from familyAccounts');
  const fam2 = await one(db2, "select count(*) n, sum(status = 'active') active from families where legacyId <> ''");
  const solo = students.filter(s => !linked.has(String(s.id))).length;
  add('家族と生徒', '家族', accounts.length + solo, fam2.n, solo ? `家族に入っていない生徒 ${solo}人は、1人ずつの家族を作って写す` : '', true);
  add('家族と生徒', '保護者ページに登録済みの家族', accounts.filter(a => a.status === 'active').length, fam2.active || 0, '登録済みの家族は、今のパスワードのままログインできる');
  add('家族と生徒', '生徒', students.length, (await one(db2, "select count(*) n from students where legacyId <> ''")).n);
  const codes2 = new Set((await all(db2, "select linkCode from students where legacyId <> ''")).map(r => r.linkCode));
  add('家族と生徒', '生徒の専用リンク（同じ鍵のまま）', students.filter(s => s.code).length, students.filter(s => s.code && codes2.has(String(s.code))).length, '生徒は今の専用リンクの鍵のまま、新しいページを開ける');
  const instructors = await all(old, 'select email from instructors').catch(() => []);
  const staffEmails = new Set((await all(db2, "select email from staff where contractType = 'contractor'")).map(r => r.email));
  add('家族と生徒', '講師（同じメールのスタッフ）', instructors.length, instructors.filter(i => staffEmails.has(String(i.email).toLowerCase())).length, '講師は新しい仕組みで招待し直す（パスワードは本人が決める）');

  // 予定
  const slots = await all(old, "select * from slots where status in ('offered', 'booked')");
  const lessons2 = await all(db2, "select status, legacyId from lessons where legacyId <> '' and legacyId not like 'cx:%' and legacyId not like 'orphan:%'");
  const want = { held: 0, proposed: 0, decided: 0, done: 0 };
  for (const s of slots) want[s.status === 'offered' ? (String(s.confirmBy || '') === 'hold' ? 'held' : 'proposed') : truthy(s.done) ? 'done' : 'decided']++;
  const got = { held: 0, proposed: 0, decided: 0, done: 0 }; for (const l of lessons2) if (l.status in got) got[l.status]++;
  add('予定', '授業（すべて）', slots.length, lessons2.length);
  for (const [k, label] of [['held', '未送信'], ['proposed', '仮予定'], ['decided', '決定'], ['done', '実施済み']]) add('予定', `授業: ${label}`, want[k], got[k]);
  const reqOld = slots.filter(s => s.req && s.status === 'booked' && !truthy(s.done)).length + slots.filter(s => s.changeReqAt && ['move', 'late'].includes(s.changeReqKind)).length;
  add('予定', '対応待ちの連絡（お休み・キャンセル・日時の変更）', reqOld, (await one(db2, "select count(*) n from lessonRequests where id like 'rq_%' and lessonId in (select id from lessons where legacyId <> '')")).n);
  const ev = (await one(old, 'select count(*) n from events where studentId <> \'\'')).n + (await one(old, 'select count(*) n from blocked where studentId <> \'\'')).n;
  add('予定', '共有予定（テスト・行事・授業ができない日）', ev, (await one(db2, "select count(*) n from sharedEvents where legacyId <> ''")).n);
  add('予定', '先生の休み', (await one(old, 'select count(*) n from teacherOff')).n, (await one(db2, "select count(*) n from staffUnavailability where legacyId <> ''")).n);

  // 授業記録
  const recs = await all(old, 'select id, slotId from lessonRecords');
  const slotIds = new Set((await all(old, 'select id from slots')).map(s => String(s.id)));
  const orphan = recs.filter(r => !slotIds.has(String(r.slotId))).length;
  add('授業記録', '授業記録', recs.length, (await one(db2, "select count(*) n from lessonRecords where legacyId <> ''")).n, orphan ? `授業の枠が消えている記録 ${orphan}件は写さない（本人の判断）` : '', true);
  add('授業記録', '宿題・持ち物', (await one(old, "select count(*) n from tasks where studentId in (select id from students)")).n, (await one(db2, "select count(*) n from homework where legacyId <> ''")).n);
  add('授業記録', '引き継ぎメモ（授業準備のメモ）', (await one(old, "select count(*) n from lessonPreparations where trim(body) <> '' and id not like 'record-draft:%'")).n, (await one(db2, "select count(*) n from handoverNotes where legacyId <> ''")).n);

  // 計画・キャンセル料・請求
  const lines = await all(old, 'select * from planLines');
  add('計画と請求', '授業計画', lines.length, (await one(db2, "select count(*) n from planLines where legacyId <> ''")).n);
  add('計画と請求', '授業計画: 承認', lines.filter(l => l.status === 'approved').length, (await one(db2, "select count(*) n from planLines where legacyId <> '' and status = 'approved'")).n);
  const fixed = lines.filter(l => typedFee(Number(l.rate30 || 0), Number(l.lessonMin) || 60) !== Math.round(Number(l.rate30 || 0) * (Number(l.lessonMin) || 60) / 30)).length;
  add('計画と請求', '1回の授業料を入力した金額に戻した計画', 0, fixed, '今の画面では1円ずれて見えていたもの（例: 2,799円 → 2,800円）', true);
  const fees = (await all(old, "select * from cancellationFees where status = 'confirmed'")).map(f => ({ ...f, d: parse(f.decisionJson, {}) }));
  const feeRows = fees.filter(f => ['late', 'noshow'].includes((f.d.quote || {}).type));
  const fees2 = await one(db2, "select count(*) n, coalesce(sum(amount), 0) amount from cancellationFees where legacyId <> ''");
  add('計画と請求', 'キャンセル料（件数）', feeRows.length, fees2.n, '「お休み」の控えはキャンセル料を作らず、お休みの授業として写す');
  add('計画と請求', 'キャンセル料（金額）', feeRows.reduce((n, f) => n + Number(f.d.amount || 0), 0), fees2.amount);
  const pays = await all(old, 'select * from "入金管理"');
  const live = pays.filter(p => p['状態'] !== '取消'), inv2 = await all(db2, "select * from invoices where legacyId <> ''");
  add('計画と請求', '請求（金額の合計）', live.reduce((n, p) => n + Number(p['請求額'] || 0), 0), inv2.reduce((n, v) => n + v.total, 0));
  add('計画と請求', '入金済み（金額の合計）', live.filter(p => p['状態'] === '入金済').reduce((n, p) => n + Number(p['請求額'] || 0), 0), inv2.filter(v => v.status === 'paid').reduce((n, v) => n + v.total, 0),
    '家族の中に入金済みでない子がいる月は、家族の請求として「お支払い待ち」のまま', true);
  const voided = pays.length - live.length;
  if (voided) add('計画と請求', '取り消した請求', voided, 0, '取り消した請求は写さない', true);

  // 写さないもの（決めたこと）
  const skip = [];
  for (const [table, label, why] of [['"成績推移"', '成績推移', '成績は作り直す（了承済み）'], ['"模試"', '模試', '成績は作り直す'], ['"面談記録"', '面談記録', '面談は新しい仕組みで記録する'], ['examReports', '成績票の読み込み', '成績は作り直す'],
    ['wishes', '授業希望', 'やめた機能（予定の共有にまとめた）'], ['contactMessages', '連絡欄', 'やめた機能（LINE で足りる）'], ['teacherBookings', '先生が登録した授業の控え', '処理の控え。授業そのものは写している'], ['familyOutbox', '保護者あての送信の控え', '今の台帳に残す（読むだけ）']]) {
    const n = (await one(old, `select count(*) n from ${table}`).catch(() => ({ n: 0 }))).n || 0;
    if (n) skip.push({ table: label, count: n, why });
  }
  return { rows, skip };
}

// 切り替えの予行: 切り替えた瞬間に起きることを数える（何もしない）
export async function cutoverPreview(c) {
  const all = async sql => (await c.db.prepare(sql).all()).results, today = todayJst(c.now);
  const fams = await all("select f.*, (select count(*) from students s where s.familyId = f.id and s.status <> 'left') kids from families f where f.status <> 'stopped'");
  const withKids = fams.filter(f => f.kids > 0);
  const lessons = await all(`select calendarEventId, deliveryMode, meetUrl from lessons where status = 'decided' and date >= '${today}'`);
  const meetings = await all(`select calendarEventId from meetings where status = 'scheduled' and date >= '${today}'`);
  const open = {
    requests: (await c.db.prepare("select count(*) n from lessonRequests where status = 'open'").first()).n,
    fees: (await c.db.prepare("select count(*) n from cancellationFees where decision = 'pending' or reliefStatus = 'pending'").first()).n,
    plans: (await c.db.prepare("select count(*) n from planLines where status = 'proposed'").first()).n,
    proposed: (await c.db.prepare("select count(*) n from lessons where status = 'proposed'").first()).n,
    held: (await c.db.prepare("select count(*) n from effects where status = 'dismissed' and error like '%切り替え前%'").first()).n,
  };
  const lastCopy = await c.db.prepare("select at from auditLog where action in ('migrateIdentity') order by at desc limit 1").first().catch(() => null);
  return {
    live: await isLive(c), today, lastCopy: lastCopy ? lastCopy.at : '',
    families: { total: withKids.length, canLogin: withKids.filter(f => f.status === 'active' && f.email).length, needInvite: withKids.filter(f => f.status !== 'active' && f.email).length, noEmail: withKids.filter(f => !f.email).length,
      testOnly: withKids.filter(f => f.testOnly).length },
    students: (await c.db.prepare("select count(*) n from students where status <> 'left'").first()).n,
    calendar: { keep: lessons.filter(l => l.calendarEventId && !l.calendarEventId.startsWith('swv2')).length + meetings.filter(m => m.calendarEventId && !m.calendarEventId.startsWith('swv2')).length,
      create: lessons.filter(l => !l.calendarEventId || l.calendarEventId.startsWith('swv2')).length + meetings.filter(m => !m.calendarEventId || m.calendarEventId.startsWith('swv2')).length,
      onlineWithoutMeet: lessons.filter(l => l.deliveryMode === 'online' && !l.meetUrl).length },
    open,
  };
}

export const migrateCheckRoutes = {
  'admin/migrate/check': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const r = await checkRows(c.env.DB, c.db);
    return { ...r, problems: r.rows.filter(x => !x.same && !x.expected).length };
  },
  'admin/cutover/preview': async (c, b) => { await requireStaff(c, b, 'sysadmin'); return cutoverPreview(c); },
};
