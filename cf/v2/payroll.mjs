// 講師の給与（7段目）。講師は雇用（アルバイト。2026-10-07 本人決定）。migrations-v2/0011_payroll.sql・0015_employment.sql、docs/REQUIREMENTS.md 5-1
// - 数える: 実施済みの担当授業（代講は実際に担当した講師）、担当した面談（日が過ぎて取りやめでないもの）。交通費は払わない
//   （授業の準備・記録の入力の時間をどう数えるかは未決。決まるまでは、要るときに「調整」で足す）
// - 時間で払う: 2人同時の授業は、講師が働いた時間（重なりは1回）だけ数える。生徒が1人でも2人でも給与は同じ（2026-10-03 本人）
// - 時給: 講師ごと（staffRates。変えた月から）。面談は別の時給。行ごとに「分 × 時給 ÷ 60」の1円未満を切り捨て
// - 月末締め・翌月25日払い。教室管理者が確かめて確定する。確定した明細は変えず、直すときは取り消して確定し直す（理由を残す）
// - 源泉徴収: 給与所得の源泉徴収税額表（月額表、cf/v2/tax-table.mjs）。講師ごとに甲欄・乙欄（staff.taxColumn）と扶養の人数（staff.dependents）。
//   社会保険料（雇用保険料）はまだ差し引かないので、総支給額をそのまま表に当てる。表の年は支払日（翌月25日）の年
// - 代表（contractType = owner）は数えない。講師（contractType = employee）は自分の明細だけを見る
import { fail, newId, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { todayJst } from './schedule.mjs';
import { validMonth, monthEnd, shiftMonth } from './plan-calc.mjs';
import { monthlyWithholding } from './tax-table.mjs';

const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ') || s.name || '';
const sameVersion = (row, b) => { if (Number(b.version) !== Number(row.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409); };
const md = d => d.slice(5).replace('-', '/');
export const payOnFor = month => shiftMonth(month, 1) + '-25';
export const TAX_COLUMN_LABEL = { kou: '甲欄', otsu: '乙欄' };
const itemAmount = (minutes, rate) => Math.floor(minutes * rate / 60);
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

// その月に使う時給（startsOn がその月以前で、いちばん新しいもの）
function rateFor(rates, month) {
  return rates.filter(r => r.startsOn.slice(0, 7) <= month).sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0] || null;
}
async function employees(c) {
  return (await c.db.prepare("select * from staff where contractType = 'employee' and status <> 'invited' order by familyName, givenName").all()).results;
}

// ---- 月の計算（講師ごと） ----
// 対象: その月の末日までに実施済み（面談は日が過ぎた）で、まだ明細に入っていないもの。前の月の分も入る（確定のあとで実施済みになったもの）
export async function payPreview(c, staffId, month, { ignorePayrollId = '' } = {}) {
  const end = monthEnd(month), today = todayJst(c.now);
  const s = await c.db.prepare('select * from staff where id = ?').bind(staffId).first(); if (!s) fail('notFound', '講師が見つかりません', 404);
  const rates = (await c.db.prepare('select * from staffRates where staffId = ?').bind(staffId).all()).results;
  const open = "(payrollId = '' or payrollId = ?)";
  const lessons = (await c.db.prepare(`select l.*, st.familyName, st.givenName from lessons l join students st on st.id = l.studentId where l.staffId = ? and l.date <= ? and l.status in ('done', 'decided') and ${open.replace(/payrollId/g, 'l.payrollId')} order by l.date, l.start`).bind(staffId, end, ignorePayrollId || '-').all()).results;
  const meetings = (await c.db.prepare(`select * from meetings where staffId = ? and date <= ? and date < ? and status <> 'cancelled' and ${open} order by date, start`).bind(staffId, end, today, ignorePayrollId || '-').all()).results;
  const adjusts = (await c.db.prepare(`select * from payrollAdjustments where staffId = ? and month = ? and ${open} order by createdAt`).bind(staffId, month, ignorePayrollId || '-').all()).results;
  const issues = [], items = [];
  const covered = {}; // 日ごとに、もう数えた授業の終わり（2人同時の授業は、重なる時間を二重に数えない）
  for (const l of lessons) {
    if (l.status === 'decided') { if (l.date <= today) issues.push(`${md(l.date)} ${l.subject}（${fullName(l)}さん）が実施済みになっていません`); continue; }
    const r = rateFor(rates, l.date.slice(0, 7));
    if (!r || !r.lessonHourly) { issues.push(`${l.date.slice(0, 7)} の授業の時給が決まっていません`); continue; }
    // 開始の早い順に並んでいるので、前の授業と重なるのは「今の開始」から「それまでの終わり」まで
    const s0 = toMin(l.start), e0 = s0 + l.minutes, paid = Math.max(0, e0 - Math.max(s0, covered[l.date] || 0));
    covered[l.date] = Math.max(covered[l.date] || 0, e0);
    const note = paid === l.minutes ? '' : paid ? `（同時の授業と重なる${l.minutes - paid}分を除く）` : '（同時の授業の時間に含む）';
    items.push({ kind: 'lesson', lessonId: l.id, date: l.date, start: l.start, minutes: paid, label: `${l.subject}（${fullName(l)}さん）${note}`, rate: r.lessonHourly, amount: itemAmount(paid, r.lessonHourly), carried: l.date < month + '-01' });
  }
  for (const m of meetings) {
    const r = rateFor(rates, m.date.slice(0, 7));
    if (!r || !r.meetingHourly) { issues.push(`${m.date.slice(0, 7)} の面談の時給が決まっていません`); continue; }
    items.push({ kind: 'meeting', meetingId: m.id, date: m.date, start: m.start, minutes: m.minutes, label: '面談' + (m.title ? '（' + m.title + '）' : ''), rate: r.meetingHourly, amount: itemAmount(m.minutes, r.meetingHourly), carried: m.date < month + '-01' });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  for (const a of adjusts) items.push({ kind: 'adjust', adjustId: a.id, date: '', start: '', minutes: 0, label: a.label, rate: 0, amount: a.amount });
  const sum = (k, f) => items.filter(i => i.kind === k).reduce((n, i) => n + i[f], 0);
  const t = { lessonMinutes: sum('lesson', 'minutes'), meetingMinutes: sum('meeting', 'minutes'), lessonAmount: sum('lesson', 'amount'), meetingAmount: sum('meeting', 'amount'), adjustAmount: sum('adjust', 'amount') };
  t.gross = t.lessonAmount + t.meetingAmount + t.adjustAmount;
  const payOn = payOnFor(month), tax = { taxColumn: s.taxColumn, dependents: s.taxColumn === 'kou' ? s.dependents : 0 };
  const w = monthlyWithholding(t.gross, { year: Number(payOn.slice(0, 4)), column: tax.taxColumn, dependents: tax.dependents });
  if (w.error) issues.push(w.error);
  t.withholding = w.tax || 0;
  t.net = t.gross - t.withholding;
  if (t.gross < 0) issues.push('総支給額がマイナスです。調整を確かめてください');
  return { staffId, name: fullName(s), month, payOn, ...tax, items, issues, ...t, canConfirm: !issues.length && items.length > 0 };
}

const payrollView = p => ({ id: p.id, staffId: p.staffId, month: p.month, status: p.status, lessonMinutes: p.lessonMinutes, meetingMinutes: p.meetingMinutes, lessonAmount: p.lessonAmount, meetingAmount: p.meetingAmount,
  adjustAmount: p.adjustAmount, gross: p.gross, withholding: p.withholding, taxColumn: p.taxColumn, dependents: p.dependents, net: p.net, payOn: p.payOn, paidOn: p.paidOn, confirmedAt: p.confirmedAt, voidReason: p.voidReason, version: p.version });
const itemView = i => ({ kind: i.kind, date: i.date, start: i.start, minutes: i.minutes, label: i.label, rate: i.rate, amount: i.amount });
async function activePayroll(c, staffId, month) { return c.db.prepare("select * from payrollMonths where staffId = ? and month = ? and status <> 'void'").bind(staffId, month).first(); }
async function withItems(c, p) { return { ...payrollView(p), items: (await c.db.prepare('select * from payrollItems where payrollId = ? order by sortOrder').bind(p.id).all()).results.map(itemView) }; }
async function getPayroll(c, id) { const p = await c.db.prepare('select * from payrollMonths where id = ?').bind(String(id || '')).first(); if (!p) fail('notFound', '明細が見つかりません', 404); return p; }

export const payrollRoutes = {
  // ---- 教室管理者 ----
  // 時給と源泉徴収の欄（講師ごと）
  'payroll/rates/list': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const out = [];
    for (const s of await employees(c)) {
      const rates = (await c.db.prepare('select * from staffRates where staffId = ? order by startsOn desc').bind(s.id).all()).results;
      out.push({ id: s.id, name: fullName(s), status: s.status, taxColumn: s.taxColumn, dependents: s.dependents, version: s.version, rates: rates.map(r => ({ id: r.id, startsOn: r.startsOn.slice(0, 7), lessonHourly: r.lessonHourly, meetingHourly: r.meetingHourly })) });
    }
    return { staff: out };
  },
  // 時給を決める（その月から）。同じ月なら置き換える。確定した明細は変わらない
  'payroll/rates/save': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await c.db.prepare("select * from staff where id = ? and contractType = 'employee'").bind(String(b.staffId || '')).first(); if (!s) fail('notFound', '講師が見つかりません', 404);
    if (!validMonth(b.startsOn)) fail('badMonth', 'いつの月からかを選んでください');
    const lesson = Number(b.lessonHourly), meeting = Number(b.meetingHourly);
    for (const [v, label] of [[lesson, '授業'], [meeting, '面談']]) if (!Number.isInteger(v) || v < 0 || v > 20000) fail('badRate', `${label}の時給は0〜20,000円にしてください`);
    const confirmedLater = await c.db.prepare("select month from payrollMonths where staffId = ? and month >= ? and status <> 'void' order by month limit 1").bind(s.id, b.startsOn).first();
    if (confirmedLater) fail('confirmed', `${confirmedLater.month} の明細はもう確定しています。時給を変えるのは、まだ確定していない月からにしてください`, 409);
    const now = iso(c.now);
    await c.db.prepare('insert into staffRates (id, staffId, startsOn, lessonHourly, meetingHourly, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?) on conflict(staffId, startsOn) do update set lessonHourly = excluded.lessonHourly, meetingHourly = excluded.meetingHourly, updatedAt = excluded.updatedAt, version = version + 1')
      .bind(newId('sr'), s.id, b.startsOn + '-01', lesson, meeting, now, now).run();
    await audit(c, 'staffRateSave', s.id, { startsOn: b.startsOn, lesson, meeting });
    return {};
  },
  // 源泉徴収の欄: 扶養控除等申告書を出していれば甲欄（扶養の人数も）、出していなければ乙欄。まだ確定していない明細から使う
  'payroll/withholding': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await c.db.prepare("select * from staff where id = ? and contractType = 'employee'").bind(String(b.staffId || '')).first(); if (!s) fail('notFound', '講師が見つかりません', 404); sameVersion(s, b);
    const column = b.taxColumn, dependents = column === 'kou' ? Number(b.dependents || 0) : 0;
    if (!TAX_COLUMN_LABEL[column]) fail('badColumn', '甲欄か乙欄を選んでください');
    if (!Number.isInteger(dependents) || dependents < 0 || dependents > 7) fail('badDependents', '扶養の人数は0〜7人にしてください（8人以上は税額表で確かめる）');
    await c.db.prepare('update staff set taxColumn = ?, dependents = ?, updatedAt = ?, version = version + 1 where id = ?').bind(column, dependents, iso(c.now), s.id).run();
    await audit(c, 'staffTaxColumn', s.id, { column, dependents });
    return {};
  },
  // 月の一覧: 講師ごとの見込み（確定前）か、確定した明細
  'payroll/month': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const month = validMonth(b.month) ? b.month : shiftMonth(todayJst(c.now).slice(0, 7), -1), rows = [];
    for (const s of await employees(c)) {
      const p = await activePayroll(c, s.id, month);
      if (p) { rows.push({ staffId: s.id, name: fullName(s), payroll: payrollView(p) }); continue; }
      const v = await payPreview(c, s.id, month);
      if (v.items.length || v.issues.length) rows.push({ staffId: s.id, name: fullName(s), preview: { gross: v.gross, net: v.net, lessonMinutes: v.lessonMinutes, meetingMinutes: v.meetingMinutes, issues: v.issues, canConfirm: v.canConfirm } });
    }
    const unassigned = (await c.db.prepare("select count(*) n from lessons where staffId = '' and status = 'done' and date between ? and ?").bind(month + '-01', monthEnd(month)).first()).n;
    return { month, payOn: payOnFor(month), staff: rows, unassigned };
  },
  'payroll/staff': async (c, b) => {
    await requireStaff(c, b, 'manager');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    const p = await activePayroll(c, String(b.staffId || ''), b.month);
    if (p) return { payroll: await withItems(c, p) };
    const v = await payPreview(c, String(b.staffId || ''), b.month);
    const adjusts = (await c.db.prepare("select * from payrollAdjustments where staffId = ? and month = ? and payrollId = '' order by createdAt").bind(v.staffId, b.month).all()).results.map(a => ({ id: a.id, label: a.label, amount: a.amount }));
    return { preview: v, adjusts };
  },
  // 調整（確定の前）。理由と金額（マイナスもよい）
  'payroll/adjust/add': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const s = await c.db.prepare("select id from staff where id = ? and contractType = 'employee'").bind(String(b.staffId || '')).first(); if (!s) fail('notFound', '講師が見つかりません', 404);
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    if (await activePayroll(c, s.id, b.month)) fail('confirmed', 'この月の明細はもう確定しています', 409);
    const label = String(b.label || '').trim(), amount = Number(b.amount);
    if (!label || label.length > 60) fail('needLabel', '理由を60文字以内で入れてください（例: 研修 2時間）');
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 500000) fail('badAmount', '金額を確かめてください（マイナスもよい）');
    await c.db.prepare('insert into payrollAdjustments (id, staffId, month, label, amount, createdBy, createdAt) values (?, ?, ?, ?, ?, ?, ?)').bind(newId('pa'), s.id, b.month, label, amount, 'staff:' + me.id, iso(c.now)).run();
    await audit(c, 'payrollAdjust', s.id, { month: b.month, amount });
    return {};
  },
  'payroll/adjust/delete': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const a = await c.db.prepare('select * from payrollAdjustments where id = ?').bind(String(b.id || '')).first();
    if (!a) fail('notFound', '調整が見つかりません', 404);
    if (a.payrollId) fail('confirmed', '確定した明細の調整は消せません', 409);
    await c.db.prepare('delete from payrollAdjustments where id = ?').bind(a.id).run();
    return {};
  },
  // 確定: 月が終わってから。授業・面談・調整に明細を付ける。講師にお知らせ
  'payroll/confirm': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    if (b.month >= todayJst(c.now).slice(0, 7)) fail('tooEarly', '月が終わってから確定してください（月末締め）');
    const staffId = String(b.staffId || '');
    if (await activePayroll(c, staffId, b.month)) fail('already', 'この月の明細はもう確定しています', 409);
    const v = await payPreview(c, staffId, b.month);
    if (!v.canConfirm) fail('notReady', v.issues.length ? '確かめることがあります: ' + v.issues.join(' / ') : 'この月の勤務はありません', 409);
    if (b.expectedNet !== undefined && Number(b.expectedNet) !== v.net) fail('changed', '金額が変わりました。画面を更新して確かめてください', 409);
    const id = newId('pm'), now = iso(c.now), db = c.db;
    const stmts = [db.prepare("insert into payrollMonths (id, staffId, month, status, lessonMinutes, meetingMinutes, lessonAmount, meetingAmount, adjustAmount, gross, withholding, taxColumn, dependents, net, payOn, confirmedAt, confirmedBy, createdAt, updatedAt) values (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, staffId, b.month, v.lessonMinutes, v.meetingMinutes, v.lessonAmount, v.meetingAmount, v.adjustAmount, v.gross, v.withholding, v.taxColumn, v.dependents, v.net, v.payOn, now, 'staff:' + me.id, now, now)];
    v.items.forEach((i, n) => {
      stmts.push(db.prepare('insert into payrollItems (id, payrollId, kind, lessonId, meetingId, date, start, minutes, label, rate, amount, sortOrder) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(newId('pi'), id, i.kind, i.lessonId || '', i.meetingId || '', i.date, i.start, i.minutes, i.label, i.rate, i.amount, n));
      if (i.kind === 'lesson') stmts.push(db.prepare("update lessons set payrollId = ? where id = ? and payrollId = ''").bind(id, i.lessonId));
      if (i.kind === 'meeting') stmts.push(db.prepare("update meetings set payrollId = ? where id = ? and payrollId = ''").bind(id, i.meetingId));
      if (i.kind === 'adjust') stmts.push(db.prepare("update payrollAdjustments set payrollId = ? where id = ? and payrollId = ''").bind(id, i.adjustId));
    });
    await db.batch(stmts);
    const s = await db.prepare('select email from staff where id = ?').bind(staffId).first();
    c.effects.push({ kind: 'mail', to: s.email, name: 'ステップワイズ', subject: `[ステップワイズ] ${Number(b.month.slice(5))}月分の給与明細`, body: `${Number(b.month.slice(5))}月分の給与が確定しました。\n差引支給額 ${v.net.toLocaleString('ja-JP')}円（${v.payOn} にお支払いします）\n明細は「給与」の画面で見られます。\n\nhttps://www.stepwise-education.jp/staff/#payroll`, audience: 'staff' });
    await audit(c, 'payrollConfirm', id, { staffId, month: b.month, gross: v.gross, net: v.net });
    return { payroll: await withItems(c, await getPayroll(c, id)) };
  },
  // 取消（訂正）: 理由を残す。授業・面談・調整は明細の前に戻り、直してから確定し直す。支払い済みは取り消せない
  'payroll/void': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const p = await getPayroll(c, b.id); sameVersion(p, b);
    if (p.status === 'paid') fail('paid', '支払い済みの明細は取り消せません。先に支払いの記録を戻してください', 409);
    if (p.status === 'void') return {};
    const reason = String(b.reason || '').trim(); if (!reason || reason.length > 300) fail('needReason', '取り消す理由を書いてください（例: 時給の入力の誤り）');
    const now = iso(c.now);
    await c.db.batch([
      c.db.prepare("update payrollMonths set status = 'void', voidedAt = ?, voidReason = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?").bind(now, reason, now, p.id, p.version),
      c.db.prepare("update lessons set payrollId = '' where payrollId = ?").bind(p.id),
      c.db.prepare("update meetings set payrollId = '' where payrollId = ?").bind(p.id),
      c.db.prepare("update payrollAdjustments set payrollId = '' where payrollId = ?").bind(p.id),
    ]);
    await audit(c, 'payrollVoid', p.id, { reason });
    return {};
  },
  // 支払いの記録（paid）と、その取り消し（undo）
  'payroll/paid': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const p = await getPayroll(c, b.id); sameVersion(p, b);
    const now = iso(c.now);
    if (b.undo) {
      if (p.status !== 'paid') fail('notPaid', '支払い済みではありません', 409);
      await c.db.prepare("update payrollMonths set status = 'confirmed', paidOn = '', updatedAt = ?, version = version + 1 where id = ?").bind(now, p.id).run();
      await audit(c, 'payrollUnpaid', p.id, { reason: String(b.reason || '') });
      return {};
    }
    if (p.status !== 'confirmed') fail('badStatus', 'この明細には支払いを記録できません', 409);
    const paidOn = String(b.paidOn || todayJst(c.now));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > todayJst(c.now)) fail('badDate', '支払った日を確かめてください');
    await c.db.prepare("update payrollMonths set status = 'paid', paidOn = ?, updatedAt = ?, version = version + 1 where id = ?").bind(paidOn, now, p.id).run();
    await audit(c, 'payrollPaid', p.id, { paidOn });
    return {};
  },

  // ---- 講師: 自分の明細だけ ----
  'payroll/mine': async (c, b) => {
    const me = await requireStaff(c, b, 'teacher', 'manager');
    if (me.contractType === 'owner') return { owner: true, statements: [], current: null };
    const list = (await c.db.prepare("select * from payrollMonths where staffId = ? and status <> 'void' order by month desc limit 24").bind(me.id).all()).results;
    const statements = []; for (const p of list) statements.push(await withItems(c, p));
    // 今月の見込み（確定前の目安）
    const month = todayJst(c.now).slice(0, 7), cur = await payPreview(c, me.id, month);
    return { statements, current: { month, gross: cur.gross, lessonMinutes: cur.lessonMinutes, meetingMinutes: cur.meetingMinutes, items: cur.items.length } };
  },
};
