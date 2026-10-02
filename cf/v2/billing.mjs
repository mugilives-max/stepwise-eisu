// 授業計画・キャンセル料・請求（5段目）。migrations-v2/0006_billing.sql、docs/TERMS_DRAFT_2026-10.md 第1・5・8条
// - 教室管理者: 計画を作る・お知らせする・LINE などの承諾を記録する・先月と同じ内容で下書き、授業の種類と標準料金、
//              キャンセル料の判断・減額や免除の申請への回答、月ごとの請求（確かめる・確定・取消・入金）
// - 保護者: 計画の承認（回数を減らす・見送るも）・先生が記録した承諾の確認、請求の確認・振込の連絡、キャンセル料の減額・免除の申請
// - 毎日0時10分: 3日以降、前月分の請求を家族ごとに確定する（確かめることがある家族は止める）。切り替え（settings.live）まで動かさない
// 料金は承認した計画の行で決まる。計画の承認がない授業は請求しない（承認されたら、その月か次の月の請求に入る）。
import { fail, newId, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { requireFamily } from './family.mjs';
import { isLive } from './accounts.mjs';
import { todayJst, addDays, familyNotice, staffNotice } from './schedule.mjs';
import { validMonth, monthEnd, shiftMonth, lineCap, lessonAmount, lineMatches, studentBilling, estimateFor, assignLines } from './plan-calc.mjs';

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T00:00:00Z'));
const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const md = d => d.slice(5).replace('-', '/');
const sameVersion = (row, b) => { if (Number(b.version) !== Number(row.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409); };
const DAY = 86400e3;

// ---- 見せ方 ----
export function lineView(l, extra = {}) {
  return { id: l.id, studentId: l.studentId, parentId: l.parentId, subject: l.subject, kind: l.kind, startDate: l.startDate, endDate: l.endDate, count: l.count, minutes: l.minutes, fee: l.fee,
    comment: l.comment, status: l.status, approvedCount: l.approvedCount, proposedAt: l.proposedAt, approvedAt: l.approvedAt, approvedBy: l.approvedBy ? (l.approvedBy === 'family' ? 'family' : 'staff') : '',
    approvedVia: l.approvedVia, consentDate: l.consentDate, approvalNote: l.approvalNote, familyAck: l.familyAck, familyAckAt: l.familyAckAt, familyAckNote: l.familyAckNote, remindedAt: l.remindedAt || '', version: l.version, ...extra };
}
const feeView = f => ({ id: f.id, lessonId: f.lessonId, studentId: f.studentId, type: f.type, receivedAt: f.receivedAt, standardAmount: f.standardAmount, amount: f.amount, decision: f.decision, note: f.note,
  reliefStatus: f.reliefStatus, reliefReason: f.reliefReason, reliefResponse: f.reliefResponse, invoiceId: f.invoiceId, date: f.date, start: f.start, minutes: f.minutes, subject: f.subject, version: f.version });
const invoiceView = v => ({ id: v.id, familyId: v.familyId, month: v.month, status: v.status, total: v.total, confirmedAt: v.confirmedAt, confirmedBy: v.confirmedBy === 'system:auto' ? 'auto' : v.confirmedBy === 'legacy' ? 'legacy' : 'staff',
  reportedAt: v.reportedAt, paidOn: v.paidOn, paidMethod: v.paidMethod, voidedAt: v.voidedAt, voidReason: v.voidReason, version: v.version });
const itemView = i => ({ id: i.id, studentId: i.studentId, kind: i.kind, lessonId: i.lessonId, date: i.date, start: i.start, minutes: i.minutes, subject: i.subject, lessonKind: i.lessonKind, label: i.label, amount: i.amount });

// ---- 計画の行の中身 ----
function lineFields(b, base = {}) {
  const out = { ...base };
  for (const k of ['subject', 'kind', 'startDate', 'endDate', 'count', 'minutes', 'fee', 'comment', 'parentId']) if (b[k] !== undefined) out[k] = b[k];
  out.subject = String(out.subject || '').trim(); if (!out.subject || out.subject.length > 30) fail('badSubject', '科目を入れてください');
  out.kind = String(out.kind || '通常').trim().slice(0, 20) || '通常';
  if (!validDate(out.startDate) || !validDate(out.endDate) || out.endDate < out.startDate) fail('badPeriod', '期間を確かめてください');
  if (Date.parse(out.endDate) - Date.parse(out.startDate) > 366 * DAY) fail('badPeriod', '期間は1年以内にしてください');
  for (const [k, lo, hi, label] of [['count', 1, 60, '回数は1〜60回'], ['minutes', 15, 300, '1回の時間は15〜300分'], ['fee', 0, 100000, '1回の授業料は0〜100,000円']]) {
    out[k] = Number(out[k]); if (!Number.isInteger(out[k]) || out[k] < lo || out[k] > hi) fail('bad_' + k, label + 'にしてください');
  }
  out.comment = String(out.comment || '').trim(); if (out.comment.length > 500) fail('tooLong', '説明は500文字以内にしてください');
  out.parentId = String(out.parentId || '');
  return out;
}
async function checkLine(c, studentId, n, selfId = '') {
  const others = (await c.db.prepare("select * from planLines where studentId = ? and id <> ? and status <> 'declined'").bind(studentId, selfId).all()).results;
  if (n.parentId) {
    const p = await c.db.prepare('select * from planLines where id = ?').bind(n.parentId).first();
    if (!p || p.studentId !== studentId || p.parentId) fail('badParent', '追加する元の計画が見つかりません');
    if (p.status === 'declined') fail('badParent', '見送りになった計画には追加できません');
    if (p.subject !== n.subject || p.kind !== n.kind) fail('badParent', '追加の計画は、元の計画と同じ科目・種類にしてください');
    if (n.startDate < p.startDate || n.endDate > p.endDate) fail('badParent', '追加の計画の期間は、元の計画の期間の中にしてください');
    return;
  }
  const hit = others.find(o => !o.parentId && o.subject === n.subject && o.kind === n.kind && o.startDate <= n.endDate && n.startDate <= o.endDate);
  if (hit) fail('overlap', `同じ科目・種類の計画（${md(hit.startDate)}〜${md(hit.endDate)}）と期間が重なっています。回数を足すときは「追加の計画」にしてください`, 409);
}
async function lineLocked(c, id) {
  return !!(await c.db.prepare("select 1 from invoiceItems i join invoices v on v.id = i.invoiceId where i.planLineId = ? and v.status <> 'void'").bind(id).first());
}
async function getLine(c, id) { const l = await c.db.prepare('select * from planLines where id = ?').bind(String(id || '')).first(); if (!l) fail('notFound', '計画が見つかりません', 404); return l; }
async function getStudent(c, id) { const s = await c.db.prepare('select * from students where id = ?').bind(String(id || '')).first(); if (!s) fail('notFound', '生徒が見つかりません', 404); return s; }

// この行を外したときに、ほかの承認済みの行に入りきらない授業の数（回数をこれより減らせない）
async function minCountFor(c, line) {
  const sb = await studentBilling(c.db, line.studentId);
  const rest = assignLines(sb.lines.filter(l => l.id !== line.id), sb.lessons, Object.fromEntries(Object.entries(sb.invoicedLine).filter(([, v]) => v !== line.id)));
  return sb.lessons.filter(ls => !rest.line[ls.id] && lineMatches(line, ls)).length;
}

// 行ごとの使い方: 割り当てた授業（決定・実施済み）と、まだ仮予定の授業
function usageOf(sb, pendingLessons) {
  const out = {};
  for (const l of sb.lines) out[l.id] = { assigned: sb.used[l.id] || 0, tentative: pendingLessons.filter(ls => lineMatches(l, ls)).length };
  return out;
}

// ---- 月の請求の計算（家族ごと） ----
// 対象: その月の末日までに実施済みで、まだ請求していない授業（前の月で承認待ちだった分も入る）と、判断済みのキャンセル料。
// 確定できないとき: 決定のまま実施済みにしていない授業・判断待ちのキャンセル料・減額や免除の申請の回答待ちがある。
// 自動の確定はさらに、計画の承認がない授業があると止める（手で確定すれば、その授業は次の請求に回る）。
export async function monthPreview(c, familyId, month, { ignoreInvoiceId = '' } = {}) {
  const end = monthEnd(month), from = month + '-01', today = todayJst(c.now);
  const students = (await c.db.prepare('select * from students where familyId = ? order by createdAt').bind(familyId).all()).results;
  const out = { familyId, month, students: [], total: 0, issues: [], pendingCount: 0 };
  for (const s of students) {
    const sb = await studentBilling(c.db, s.id, { ignoreInvoiceId });
    const open = ls => !ls.invoiceId || ls.invoiceId === ignoreInvoiceId;
    const row = { studentId: s.id, name: fullName(s), items: [], pending: [], total: 0 };
    for (const ls of sb.lessons.filter(ls => ls.date <= end && open(ls))) {
      if (ls.status === 'decided') { if (ls.date <= today) out.issues.push(`${row.name}さん ${md(ls.date)} ${ls.subject} が実施済みになっていません`); continue; }
      const line = sb.line[ls.id], base = { lessonId: ls.id, date: ls.date, start: ls.start, minutes: ls.minutes, subject: ls.subject, lessonKind: ls.kind, carried: ls.date < from };
      if (line) row.items.push({ kind: 'lesson', ...base, planLineId: line.id, amount: lessonAmount(line, ls), label: '' });
      else row.pending.push({ ...base, estimate: estimateFor(sb.lines, s, ls) });
    }
    const fees = (await c.db.prepare("select f.*, l.date, l.start, l.minutes, l.subject from cancellationFees f join lessons l on l.id = f.lessonId where f.studentId = ? and l.date <= ? and (f.invoiceId = '' or f.invoiceId = ?) order by l.date, l.start").bind(s.id, end, ignoreInvoiceId || '-').all()).results;
    for (const f of fees) {
      if (f.decision === 'pending') { out.issues.push(`${row.name}さん ${md(f.date)} ${f.subject} のキャンセル料が判断待ちです`); continue; }
      if (f.reliefStatus === 'pending') { out.issues.push(`${row.name}さん ${md(f.date)} ${f.subject} のキャンセル料に減額・免除の申請があります`); continue; }
      if (f.amount > 0) row.items.push({ kind: 'cancelFee', feeId: f.id, lessonId: f.lessonId, date: f.date, start: f.start, minutes: 0, subject: f.subject, lessonKind: '', planLineId: '', amount: f.amount,
        label: 'キャンセル料' + (f.decision === 'adjust' || f.reliefStatus === 'reduced' ? '（減額）' : ''), carried: f.date < from });
    }
    row.items.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    row.total = row.items.reduce((n, i) => n + i.amount, 0);
    out.total += row.total; out.pendingCount += row.pending.length;
    if (row.items.length || row.pending.length) out.students.push(row);
  }
  const items = out.students.reduce((n, s) => n + s.items.length, 0);
  out.canConfirm = !out.issues.length && items > 0;
  out.auto = out.canConfirm && !out.pendingCount;
  return out;
}

async function activeInvoice(c, familyId, month) {
  return c.db.prepare("select * from invoices where familyId = ? and month = ? and status <> 'void'").bind(familyId, month).first();
}
export async function confirmInvoice(c, familyId, month, by, expectedTotal) {
  if (await activeInvoice(c, familyId, month)) fail('already', 'この月の請求はもう確定しています', 409);
  const p = await monthPreview(c, familyId, month);
  if (!p.canConfirm) fail('notReady', p.issues.length ? '確かめることがあります: ' + p.issues.join(' / ') : '請求するものがありません', 409);
  if (expectedTotal !== undefined && expectedTotal !== null && Number(expectedTotal) !== p.total) fail('changed', '金額が変わりました。画面を更新して確かめてください', 409);
  const id = newId('iv'), now = iso(c.now), db = c.db;
  const stmts = [db.prepare("insert into invoices (id, familyId, month, status, total, confirmedAt, confirmedBy, createdAt, updatedAt) values (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)").bind(id, familyId, month, p.total, now, by, now, now)];
  let order = 0;
  for (const s of p.students) for (const i of s.items) {
    stmts.push(db.prepare('insert into invoiceItems (id, invoiceId, studentId, kind, lessonId, feeId, planLineId, date, start, minutes, subject, lessonKind, label, amount, sortOrder) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('ii'), id, s.studentId, i.kind, i.lessonId || '', i.feeId || '', i.planLineId || '', i.date, i.start, i.minutes, i.subject, i.lessonKind || '', i.label || '', i.amount, order++));
    if (i.kind === 'lesson') stmts.push(db.prepare("update lessons set invoiceId = ?, updatedAt = ?, version = version + 1 where id = ? and invoiceId = ''").bind(id, now, i.lessonId));
    else stmts.push(db.prepare("update cancellationFees set invoiceId = ?, updatedAt = ?, version = version + 1 where id = ? and invoiceId = ''").bind(id, now, i.feeId));
  }
  await db.batch(stmts);
  const [y, m] = month.split('-');
  const first = p.students[0];
  if (first) await familyNotice(c, first.studentId, `${Number(m)}月分の授業料のお知らせ`, `${y}年${Number(m)}月分の授業料が確定しました。\n合計 ${yen(p.total)}`);
  await audit(c, 'invoiceConfirm', id, { familyId, month, total: p.total, by });
  return { invoice: invoiceView(await db.prepare('select * from invoices where id = ?').bind(id).first()) };
}

// 毎日0時10分（切り替えたあと）: 3日以降は前月分を確定する。確かめることがある家族は残し、3日だけ教室管理者に知らせる
export async function autoCloseInvoices(c) {
  if (!(await isLive(c))) return { skipped: 'notLive' };
  const today = todayJst(c.now); if (Number(today.slice(8)) < 3) return { skipped: 'beforeClose' };
  const month = shiftMonth(today.slice(0, 7), -1), held = [];
  let confirmed = 0;
  c.actor = { kind: 'system', id: 'autoClose' };
  for (const f of (await c.db.prepare("select id, name from families where status <> 'stopped'").all()).results) {
    if (await activeInvoice(c, f.id, month)) continue;
    const p = await monthPreview(c, f.id, month);
    if (p.auto) { await confirmInvoice(c, f.id, month, 'system:auto'); confirmed++; }
    else if (p.students.length) held.push(`${f.name}: ${p.issues.concat(p.pendingCount ? [`計画の承認がない授業 ${p.pendingCount}件`] : []).join(' / ') || '請求するものがありません'}`);
  }
  if (held.length && today.slice(8) === '03') await staffNotice(c, `${Number(month.slice(5))}月分の請求で確かめることがあります`, held.join('\n'));
  return { month, confirmed, held: held.length };
}

async function staffFees(c, where, ...args) {
  return (await c.db.prepare(`select f.*, l.date, l.start, l.minutes, l.subject from cancellationFees f join lessons l on l.id = f.lessonId where ${where} order by l.date, l.start`).bind(...args).all()).results;
}
async function familyStudentIds(c, familyId) { return (await c.db.prepare('select id from students where familyId = ?').bind(familyId).all()).results.map(r => r.id); }

export const billingRoutes = {
  // ---- 計画（教室管理者） ----
  // 月の計画の一覧: 在籍・休会の生徒ごとに、その月にかかる計画の行と、授業の入り具合
  'billing/plans/list': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const month = validMonth(b.month) ? b.month : todayJst(c.now).slice(0, 7), from = month + '-01', to = monthEnd(month);
    const students = (await c.db.prepare("select s.*, f.name familyLabel from students s join families f on f.id = s.familyId where s.status <> 'left' order by s.familyKana, s.familyName, s.givenName").all()).results;
    const kinds = (await c.db.prepare('select * from lessonKinds order by sortOrder, name').all()).results;
    const rows = [];
    for (const s of students) {
      const sb = await studentBilling(c.db, s.id);
      const tentative = (await c.db.prepare("select * from lessons where studentId = ? and status in ('held', 'proposed') and date between ? and ?").bind(s.id, from, to).all()).results;
      const usage = usageOf(sb, tentative);
      const lines = sb.lines.filter(l => l.startDate <= to && from <= l.endDate);
      const lessonsInMonth = sb.lessons.filter(l => l.date >= from && l.date <= to);
      rows.push({ id: s.id, name: fullName(s), familyId: s.familyId, familyLabel: s.familyLabel, status: s.status, baseRate30: s.baseRate30,
        lines: await Promise.all(lines.map(async l => lineView(l, { ...usage[l.id], locked: await lineLocked(c, l.id) }))),
        // 計画のない授業: 承認済みの行に入らず、下書き・承認待ちの行にも当たらないもの
        unplanned: lessonsInMonth.concat(tentative).filter(ls => !sb.line[ls.id] && !lines.some(l => ['draft', 'proposed'].includes(l.status) && lineMatches(l, ls))).length });
    }
    return { month, students: rows, kinds: kinds.map(k => ({ name: k.name, standardMinutes: k.standardMinutes, standardFee: k.standardFee, active: !!k.active, sortOrder: k.sortOrder, version: k.version })) };
  },
  // 作る・直す。直すと承認は消えて下書きに戻る（もう一度お知らせする）。請求に入った授業がある行は直せない
  'billing/plans/save': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const old = b.id ? await getLine(c, b.id) : null;
    if (old) { sameVersion(old, b); if (await lineLocked(c, old.id)) fail('locked', '請求に入った授業がある計画は直せません。回数を足すときは「追加の計画」を作ってください', 409); }
    const s = await getStudent(c, old ? old.studentId : b.studentId);
    const n = lineFields(b, old || {});
    await checkLine(c, s.id, n, old ? old.id : '');
    const now = iso(c.now);
    if (old) {
      await c.db.prepare(`update planLines set parentId = ?, subject = ?, kind = ?, startDate = ?, endDate = ?, count = ?, minutes = ?, fee = ?, comment = ?, status = 'draft', approvedCount = null, proposedAt = '', approvedAt = '', approvedBy = '', approvedVia = '', consentDate = '', approvalNote = '', familyAck = '', familyAckAt = '', familyAckNote = '', updatedAt = ?, version = version + 1 where id = ? and version = ?`)
        .bind(n.parentId, n.subject, n.kind, n.startDate, n.endDate, n.count, n.minutes, n.fee, n.comment, now, old.id, old.version).run();
    } else {
      b.id = newId('pl');
      await c.db.prepare('insert into planLines (id, studentId, parentId, subject, kind, startDate, endDate, count, minutes, fee, comment, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(b.id, s.id, n.parentId, n.subject, n.kind, n.startDate, n.endDate, n.count, n.minutes, n.fee, n.comment, now, now).run();
    }
    await audit(c, old ? 'planUpdate' : 'planCreate', b.id, { count: n.count, fee: n.fee, minutes: n.minutes, wasStatus: old ? old.status : '' });
    return { line: lineView(await getLine(c, b.id)) };
  },
  'billing/plans/delete': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLine(c, b.id); sameVersion(l, b);
    if (await lineLocked(c, l.id)) fail('locked', '請求に入った授業がある計画は消せません', 409);
    if ((await c.db.prepare('select 1 from planLines where parentId = ?').bind(l.id).first())) fail('hasAddon', '追加の計画を先に消してください', 409);
    await c.db.prepare('delete from planLines where id = ?').bind(l.id).run();
    await audit(c, 'planDelete', l.id, { status: l.status, subject: l.subject, startDate: l.startDate });
    return {};
  },
  // 下書きをまとめてお知らせする（家族に1通）。studentId か familyId
  'billing/plans/send': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const ids = b.familyId ? await familyStudentIds(c, String(b.familyId)) : [(await getStudent(c, b.studentId)).id];
    if (!ids.length) fail('notFound', '生徒が見つかりません', 404);
    const drafts = (await c.db.prepare(`select * from planLines where status = 'draft' and studentId in (${ids.map(() => '?').join(', ')}) order by startDate`).bind(...ids).all()).results;
    if (!drafts.length) fail('nothing', 'お知らせする下書きがありません');
    const now = iso(c.now);
    await c.db.batch(drafts.map(l => c.db.prepare("update planLines set status = 'proposed', proposedAt = ?, updatedAt = ?, version = version + 1 where id = ? and status = 'draft'").bind(now, now, l.id)));
    const names = Object.fromEntries((await c.db.prepare(`select * from students where id in (${ids.map(() => '?').join(', ')})`).bind(...ids).all()).results.map(s => [s.id, fullName(s)]));
    await familyNotice(c, drafts[0].studentId, '授業計画のお知らせ', '授業計画をお送りしました。内容を確かめて、承認をお願いします。\n' + drafts.map(l => `・${names[l.studentId]}さん ${l.subject}${l.kind !== '通常' ? '（' + l.kind + '）' : ''} ${md(l.startDate)}〜${md(l.endDate)} ${l.count}回`).join('\n'));
    await audit(c, 'planSend', '', { lines: drafts.length });
    return { sent: drafts.length };
  },
  // 承認のお願い: 承認待ちの計画を、家族にもう一度メールで知らせる（同じ家族に1日1回まで）
  'billing/plans/remind': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const ids = await familyStudentIds(c, String(b.familyId || ''));
    if (!ids.length) fail('notFound', '家族が見つかりません', 404);
    const q = `(${ids.map(() => '?').join(', ')})`;
    const lines = (await c.db.prepare(`select * from planLines where status = 'proposed' and studentId in ${q} order by startDate, subject`).bind(...ids).all()).results;
    if (!lines.length) fail('nothing', '承認待ちの計画はありません');
    const today = todayJst(c.now), last = lines.map(l => l.remindedAt).filter(Boolean).sort().at(-1) || '';
    if (last && todayJst(Date.parse(last)) === today) fail('tooSoon', '今日はもう承認のお願いを送りました。明日以降にもう一度送れます', 409);
    const names = Object.fromEntries((await c.db.prepare(`select * from students where id in ${q}`).bind(...ids).all()).results.map(s => [s.id, fullName(s)]));
    // その計画を待っている授業（決定・実施済みで、承認済みの計画に入っていないもの）の数も添える
    let waiting = 0;
    for (const sid of [...new Set(lines.map(l => l.studentId))]) {
      const sb = await studentBilling(c.db, sid);
      waiting += sb.lessons.filter(ls => !sb.line[ls.id] && !ls.invoiceId && lines.some(l => lineMatches(l, ls))).length;
    }
    await familyNotice(c, lines[0].studentId, '授業計画の承認のお願い', 'まだ承認をいただいていない授業計画があります。内容をご確認のうえ、保護者ページから承認をお願いします。\n'
      + lines.map(l => `・${names[l.studentId]}さん ${l.subject}${l.kind !== '通常' ? '（' + l.kind + '）' : ''} ${md(l.startDate)}〜${md(l.endDate)} ${l.count}回・1回 ${yen(l.fee)}`).join('\n')
      + (waiting ? `\nこの計画に当たる授業が、すでに${waiting}回決まっています（実施済みを含みます）。` : ''));
    const now = iso(c.now);
    await c.db.batch(lines.map(l => c.db.prepare('update planLines set remindedAt = ? where id = ?').bind(now, l.id)));
    await audit(c, 'planRemind', String(b.familyId), { lines: lines.length, waiting });
    return { reminded: lines.length, waiting };
  },
  // LINE・電話・対面での承諾を記録する（保護者ページにも出て、保護者が確かめられる）
  'billing/plans/consent': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const l = await getLine(c, b.id); sameVersion(l, b);
    if (l.status === 'approved') fail('already', 'もう承認されています', 409);
    const consentDate = String(b.consentDate || ''), via = String(b.via || '').trim(), note = String(b.note || '').trim();
    if (!validDate(consentDate) || consentDate > todayJst(c.now)) fail('badDate', '承諾をもらった日（今日まで）を入れてください');
    if (!via || via.length > 40) fail('needVia', '承諾の方法（LINE・電話など）を入れてください');
    if (note.length > 300) fail('tooLong', 'メモは300文字以内にしてください');
    const count = b.approvedCount === undefined || b.approvedCount === '' ? l.count : Number(b.approvedCount);
    if (!Number.isInteger(count) || count < 1 || count > l.count) fail('badCount', `承認の回数は1〜${l.count}回にしてください`);
    const sb = await studentBilling(c.db, l.studentId);
    const before = sb.lessons.some(ls => lineMatches(l, ls) && ls.date < consentDate);
    if ((l.endDate < consentDate || before) && !note) fail('needNote', '授業のあとで承諾をもらったときは、メモに事情を書いてください');
    const now = iso(c.now);
    await c.db.prepare("update planLines set status = 'approved', approvedCount = ?, approvedAt = ?, approvedBy = ?, approvedVia = ?, consentDate = ?, approvalNote = ?, familyAck = '', familyAckAt = '', familyAckNote = '', proposedAt = case when proposedAt = '' then ? else proposedAt end, updatedAt = ?, version = version + 1 where id = ?")
      .bind(count, now, 'staff:' + me.id, via, consentDate, note, now, now, l.id).run();
    await audit(c, 'planConsent', l.id, { via, consentDate, count });
    return { line: lineView(await getLine(c, l.id)) };
  },
  // 先月と同じ内容で、その月の下書きを作る（月いっぱいの元の計画だけ。同じ科目・種類の計画がもうあれば作らない）
  'billing/plans/copyMonth': async (c, b) => {
    await requireStaff(c, b, 'manager');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    const prev = shiftMonth(b.month, -1), from = b.month + '-01', to = monthEnd(b.month), now = iso(c.now);
    const studentIds = b.studentId ? [(await getStudent(c, b.studentId)).id] : (await c.db.prepare("select id from students where status = 'enrolled'").all()).results.map(r => r.id);
    let created = 0;
    for (const sid of studentIds) {
      const src = (await c.db.prepare("select * from planLines where studentId = ? and parentId = '' and startDate = ? and endDate = ? and status in ('approved', 'proposed') order by id").bind(sid, prev + '-01', monthEnd(prev)).all()).results;
      const have = (await c.db.prepare("select * from planLines where studentId = ? and parentId = '' and status <> 'declined' and startDate <= ? and endDate >= ?").bind(sid, to, from).all()).results;
      for (const l of src) {
        if (have.some(h => h.subject === l.subject && h.kind === l.kind)) continue;
        await c.db.prepare('insert into planLines (id, studentId, subject, kind, startDate, endDate, count, minutes, fee, comment, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(newId('pl'), sid, l.subject, l.kind, from, to, l.status === 'approved' ? lineCap(l) || l.count : l.count, l.minutes, l.fee, l.comment, now, now).run();
        created++;
      }
    }
    await audit(c, 'planCopyMonth', '', { month: b.month, created });
    return { created };
  },
  // 授業の種類と標準の時間・料金（計画の初期値）
  'billing/kinds/save': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const name = String(b.name || '').trim(); if (!name || name.length > 20) fail('badName', '種類の名前を20文字以内で入れてください');
    const minutes = Number(b.standardMinutes || 0), fee = Number(b.standardFee || 0), order = Number(b.sortOrder || 0);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 300 || !Number.isInteger(fee) || fee < 0 || fee > 100000 || !Number.isInteger(order)) fail('badValue', '標準の時間（0〜300分）と料金（0〜100,000円）を確かめてください');
    const now = iso(c.now);
    await c.db.prepare('insert into lessonKinds (name, standardMinutes, standardFee, active, sortOrder, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?) on conflict(name) do update set standardMinutes = excluded.standardMinutes, standardFee = excluded.standardFee, active = excluded.active, sortOrder = excluded.sortOrder, updatedAt = excluded.updatedAt, version = version + 1')
      .bind(name, minutes, fee, b.active === false ? 0 : 1, order, now, now).run();
    await audit(c, 'lessonKindSave', name, { minutes, fee });
    return {};
  },

  // ---- キャンセル料（教室管理者） ----
  'billing/fees/list': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const rows = await staffFees(c, "f.invoiceId = '' or f.decision = 'pending' or f.reliefStatus = 'pending'");
    const names = Object.fromEntries((await c.db.prepare('select * from students').all()).results.map(s => [s.id, fullName(s)]));
    return { fees: rows.map(f => ({ ...feeView(f), studentName: names[f.studentId] || '' })) };
  },
  // 判断: charge（規定額）/ adjust（減額。0〜規定額）/ waive（免除）。減額・免除は理由が要る（保護者に見える）
  'billing/fees/decide': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const f = await c.db.prepare('select * from cancellationFees where id = ?').bind(String(b.id || '')).first();
    if (!f) fail('notFound', 'キャンセル料が見つかりません', 404); sameVersion(f, b);
    if (f.invoiceId) fail('invoiced', '請求に入ったキャンセル料は変えられません。先に請求を取り消してください', 409);
    if (f.reliefStatus === 'pending') fail('reliefPending', '減額・免除の申請に回答してください', 409);
    const decision = String(b.decision || ''), note = String(b.note || '').trim();
    if (!['charge', 'adjust', 'waive'].includes(decision)) fail('badDecision', '規定どおり・減額・免除のどれかを選んでください');
    let amount = f.standardAmount;
    if (decision === 'waive') amount = 0;
    if (decision === 'adjust') { amount = Number(b.amount); if (!Number.isInteger(amount) || amount < 0 || amount >= f.standardAmount) fail('badAmount', `減額した金額は0〜${f.standardAmount - 1}円にしてください`); }
    if (decision !== 'charge' && !note) fail('needNote', '減額・免除の理由を書いてください（保護者に見えます）');
    if (note.length > 300) fail('tooLong', '理由は300文字以内にしてください');
    await c.db.prepare('update cancellationFees set decision = ?, amount = ?, note = ?, decidedAt = ?, decidedBy = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?')
      .bind(decision, amount, note, iso(c.now), 'staff:' + me.id, iso(c.now), f.id, f.version).run();
    const l = await c.db.prepare('select * from lessons where id = ?').bind(f.lessonId).first();
    await familyNotice(c, f.studentId, 'キャンセル料のお知らせ', `${md(l.date)} ${l.start}〜（${l.subject}）のキャンセル料は ${yen(amount)} です。${note ? '\n' + note : ''}`);
    await audit(c, 'cancelFeeDecide', f.id, { decision, amount });
    return {};
  },
  // 減額・免除の申請への回答: unchanged（そのまま）/ reduced（減額）/ waived（免除）
  'billing/fees/relief': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const f = await c.db.prepare('select * from cancellationFees where id = ?').bind(String(b.id || '')).first();
    if (!f) fail('notFound', 'キャンセル料が見つかりません', 404); sameVersion(f, b);
    if (f.reliefStatus !== 'pending') fail('notPending', '回答待ちの申請はありません', 409);
    const result = String(b.result || ''), response = String(b.response || '').trim();
    if (!['unchanged', 'reduced', 'waived'].includes(result)) fail('badResult', 'そのまま・減額・免除のどれかを選んでください');
    if (!response || response.length > 300) fail('needResponse', '回答を300文字以内で書いてください（保護者に見えます）');
    let amount = f.amount;
    if (result === 'waived') amount = 0;
    if (result === 'reduced') { amount = Number(b.amount); if (!Number.isInteger(amount) || amount < 0 || amount >= f.amount) fail('badAmount', `減額した金額は0〜${f.amount - 1}円にしてください`); }
    await c.db.prepare('update cancellationFees set reliefStatus = ?, amount = ?, reliefResponse = ?, reliefDecidedAt = ?, decidedBy = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?')
      .bind(result, amount, response, iso(c.now), 'staff:' + me.id, iso(c.now), f.id, f.version).run();
    await familyNotice(c, f.studentId, 'キャンセル料の申請への回答', `キャンセル料の減額・免除の申請にお答えしました。キャンセル料は ${yen(amount)} です。\n${response}`);
    await audit(c, 'cancelFeeRelief', f.id, { result, amount });
    return {};
  },

  // ---- 請求（教室管理者） ----
  // 月の一覧: 家族ごとの見込み（確定前）か、確定した請求
  'billing/month': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const month = validMonth(b.month) ? b.month : shiftMonth(todayJst(c.now).slice(0, 7), -1);
    const families = (await c.db.prepare('select * from families order by name').all()).results, rows = [];
    for (const f of families) {
      const inv = await activeInvoice(c, f.id, month);
      if (inv) { rows.push({ familyId: f.id, name: f.name, invoice: invoiceView(inv) }); continue; }
      const p = await monthPreview(c, f.id, month);
      const asks = (await c.db.prepare("select count(*) n, max(remindedAt) last from planLines where status = 'proposed' and studentId in (select id from students where familyId = ?)").bind(f.id).first());
      if (p.students.length || p.issues.length) rows.push({ familyId: f.id, name: f.name, preview: { total: p.total, issues: p.issues, pendingCount: p.pendingCount, canConfirm: p.canConfirm, auto: p.auto }, proposedPlans: asks.n, remindedAt: asks.last || '' });
    }
    const voided = (await c.db.prepare("select v.*, f.name from invoices v join families f on f.id = v.familyId where v.month = ? and v.status = 'void' order by v.voidedAt").bind(month).all()).results;
    return { month, closeOn: shiftMonth(month, 1) + '-03', families: rows, voided: voided.map(v => ({ ...invoiceView(v), name: v.name })) };
  },
  // 家族の1か月: 確定した請求の内訳か、確定前の見込み
  'billing/family': async (c, b) => {
    await requireStaff(c, b, 'manager');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    const f = await c.db.prepare('select * from families where id = ?').bind(String(b.familyId || '')).first(); if (!f) fail('notFound', '家族が見つかりません', 404);
    const inv = await activeInvoice(c, f.id, b.month);
    const names = Object.fromEntries((await c.db.prepare('select * from students where familyId = ?').bind(f.id).all()).results.map(s => [s.id, fullName(s)]));
    if (inv) {
      const items = (await c.db.prepare('select * from invoiceItems where invoiceId = ? order by sortOrder').bind(inv.id).all()).results;
      return { family: { id: f.id, name: f.name }, invoice: invoiceView(inv), items: items.map(i => ({ ...itemView(i), studentName: names[i.studentId] || '' })) };
    }
    return { family: { id: f.id, name: f.name }, preview: await monthPreview(c, f.id, b.month) };
  },
  'billing/confirm': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    if (b.month >= todayJst(c.now).slice(0, 7)) fail('tooEarly', '月が終わってから確定してください');
    return confirmInvoice(c, String(b.familyId || ''), b.month, 'staff:' + me.id, b.expectedTotal);
  },
  // 取消: 入金済みは取り消せない。授業とキャンセル料は請求前に戻る（直してから、もう一度確定する）
  'billing/void': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const v = await c.db.prepare('select * from invoices where id = ?').bind(String(b.id || '')).first(); if (!v) fail('notFound', '請求が見つかりません', 404); sameVersion(v, b);
    if (v.status === 'paid') fail('paid', '入金済みの請求は取り消せません。先に入金の記録を戻してください', 409);
    if (v.status === 'void') return {};
    const reason = String(b.reason || '').trim(); if (!reason || reason.length > 300) fail('needReason', '取り消す理由を書いてください');
    const now = iso(c.now);
    await c.db.batch([
      c.db.prepare("update invoices set status = 'void', voidedAt = ?, voidReason = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?").bind(now, reason, now, v.id, v.version),
      c.db.prepare("update lessons set invoiceId = '', updatedAt = ?, version = version + 1 where invoiceId = ?").bind(now, v.id),
      c.db.prepare("update cancellationFees set invoiceId = '', updatedAt = ?, version = version + 1 where invoiceId = ?").bind(now, v.id),
    ]);
    await audit(c, 'invoiceVoid', v.id, { reason });
    return {};
  },
  // 入金の記録（paid）と、その取り消し（undo。理由が要る）
  'billing/paid': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const v = await c.db.prepare('select * from invoices where id = ?').bind(String(b.id || '')).first(); if (!v) fail('notFound', '請求が見つかりません', 404); sameVersion(v, b);
    const now = iso(c.now);
    if (b.undo) {
      if (v.status !== 'paid') fail('notPaid', '入金済みではありません', 409);
      const reason = String(b.reason || '').trim(); if (!reason) fail('needReason', '戻す理由を書いてください');
      await c.db.prepare("update invoices set status = ?, paidOn = '', paidMethod = '', updatedAt = ?, version = version + 1 where id = ?").bind(v.reportedAt ? 'reported' : 'confirmed', now, v.id).run();
      await audit(c, 'invoiceUnpaid', v.id, { reason });
      return {};
    }
    if (!['confirmed', 'reported'].includes(v.status)) fail('badStatus', 'この請求には入金を記録できません', 409);
    const paidOn = String(b.paidOn || todayJst(c.now)), method = String(b.method || '振込').trim().slice(0, 20) || '振込';
    if (!validDate(paidOn) || paidOn > todayJst(c.now)) fail('badDate', '入金日を確かめてください');
    await c.db.prepare("update invoices set status = 'paid', paidOn = ?, paidMethod = ?, updatedAt = ?, version = version + 1 where id = ?").bind(paidOn, method, now, v.id).run();
    await audit(c, 'invoicePaid', v.id, { paidOn, method });
    return {};
  },

  // ---- 保護者 ----
  // 計画・キャンセル料・請求（家族の子どもぶん）。下書きの計画は見せない
  'family/money': async (c, b) => {
    const me = await requireFamily(c, b);
    const students = (await c.db.prepare('select * from students where familyId = ? order by createdAt').bind(me.id).all()).results, ids = students.map(s => s.id);
    const names = Object.fromEntries(students.map(s => [s.id, fullName(s)]));
    if (!ids.length) return { plans: [], fees: [], invoices: [] };
    const q = `(${ids.map(() => '?').join(', ')})`, since = addDays(todayJst(c.now), -92);
    const lines = (await c.db.prepare(`select * from planLines where studentId in ${q} and status <> 'draft' and endDate >= ? order by startDate, subject`).bind(...ids, since).all()).results;
    const plans = [];
    for (const l of lines) plans.push(lineView(l, { studentName: names[l.studentId], minCount: l.status === 'proposed' ? await minCountFor(c, l) : 0 }));
    const fees = (await staffFees(c, `f.studentId in ${q} and f.decision <> 'pending' and (f.invoiceId = '' or l.date >= ?)`, ...ids, since)).map(f => ({ ...feeView(f), studentName: names[f.studentId] }));
    const invs = (await c.db.prepare("select * from invoices where familyId = ? and status <> 'void' order by month desc limit 24").bind(me.id).all()).results;
    const invoices = [];
    for (const v of invs) invoices.push({ ...invoiceView(v), items: (await c.db.prepare('select * from invoiceItems where invoiceId = ? order by sortOrder').bind(v.id).all()).results.map(i => ({ ...itemView(i), studentName: names[i.studentId] || '' })) });
    return { plans, fees, invoices };
  },
  // 承認（回数を減らして承認・0回で見送り）
  'family/plans/decide': async (c, b) => {
    const me = await requireFamily(c, b);
    const l = await getLine(c, b.id);
    if (!(await familyStudentIds(c, me.id)).includes(l.studentId) || l.status === 'draft') fail('notFound', '計画が見つかりません', 404);
    sameVersion(l, b);
    if (l.status !== 'proposed') fail('closed', 'この計画はもう承認・見送りが済んでいます', 409);
    const count = Number(b.approvedCount), min = await minCountFor(c, l);
    if (!Number.isInteger(count) || count < 0 || count > l.count) fail('badCount', `回数は0〜${l.count}回で選んでください`);
    if (count < min) fail('badCount', `すでに決まっている授業が${min}回あるため、${min}回より少なくはできません。先生にご相談ください`);
    const now = iso(c.now);
    await c.db.prepare("update planLines set status = ?, approvedCount = ?, approvedAt = ?, approvedBy = 'family', approvedVia = '保護者ページ', consentDate = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?")
      .bind(count > 0 ? 'approved' : 'declined', count, now, todayJst(c.now), now, l.id, l.version).run();
    const s = await getStudent(c, l.studentId);
    await staffNotice(c, `【計画の${count > 0 ? '承認' : '見送り'}】${fullName(s)}さん`, `${fullName(s)}さん ${l.subject}（${md(l.startDate)}〜${md(l.endDate)}）\n${count > 0 ? `${count}回で承認されました（お知らせは${l.count}回）` : '見送りになりました'}`);
    await audit(c, 'planDecide', l.id, { count });
    return { line: lineView(await getLine(c, l.id)) };
  },
  // 先生が記録した承諾の確認: confirmed（内容を確認しました）/ inquiry（問い合わせ。一言が要る）
  'family/plans/ack': async (c, b) => {
    const me = await requireFamily(c, b);
    const l = await getLine(c, b.id);
    if (!(await familyStudentIds(c, me.id)).includes(l.studentId)) fail('notFound', '計画が見つかりません', 404);
    sameVersion(l, b);
    if (l.status !== 'approved' || !l.approvedBy.startsWith('staff:')) fail('badStatus', 'この計画には確認はいりません', 409);
    const ack = String(b.ack || ''), note = String(b.note || '').trim();
    if (!['confirmed', 'inquiry'].includes(ack)) fail('badAck', '確認か問い合わせを選んでください');
    if (ack === 'inquiry' && (!note || note.length > 500)) fail('needNote', '問い合わせの内容を500文字以内で書いてください');
    await c.db.prepare('update planLines set familyAck = ?, familyAckAt = ?, familyAckNote = ?, updatedAt = ?, version = version + 1 where id = ?').bind(ack, iso(c.now), note, iso(c.now), l.id).run();
    if (ack === 'inquiry') { const s = await getStudent(c, l.studentId); await staffNotice(c, `【計画の問い合わせ】${fullName(s)}さん`, `${fullName(s)}さん ${l.subject}（${md(l.startDate)}〜${md(l.endDate)}）について問い合わせがありました。\n${note}`); }
    await audit(c, 'planAck', l.id, { ack });
    return { line: lineView(await getLine(c, l.id)) };
  },
  // 振込の連絡
  'family/invoices/report': async (c, b) => {
    const me = await requireFamily(c, b);
    const v = await c.db.prepare('select * from invoices where id = ?').bind(String(b.id || '')).first();
    if (!v || v.familyId !== me.id || v.status === 'void') fail('notFound', '請求が見つかりません', 404);
    sameVersion(v, b);
    if (v.status !== 'confirmed') fail('badStatus', v.status === 'paid' ? '入金を確認済みです' : 'もう連絡をいただいています', 409);
    await c.db.prepare("update invoices set status = 'reported', reportedAt = ?, updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), iso(c.now), v.id).run();
    const f = await c.db.prepare('select name from families where id = ?').bind(me.id).first();
    await staffNotice(c, `【振込の連絡】${f.name}`, `${f.name}から ${Number(v.month.slice(5))}月分（${yen(v.total)}）の振込の連絡がありました。入金を確かめてください。`);
    await audit(c, 'invoiceReported', v.id);
    return {};
  },
  // キャンセル料の減額・免除の申請（1回だけ。請求が確定する前まで）
  'family/fees/relief': async (c, b) => {
    const me = await requireFamily(c, b);
    const f = await c.db.prepare('select * from cancellationFees where id = ?').bind(String(b.id || '')).first();
    if (!f || !(await familyStudentIds(c, me.id)).includes(f.studentId) || f.decision === 'pending') fail('notFound', 'キャンセル料が見つかりません', 404);
    sameVersion(f, b);
    if (f.invoiceId) fail('invoiced', '請求が確定したあとは、LINE などでご相談ください', 409);
    if (f.amount <= 0) fail('nothing', 'このキャンセル料はかかりません', 409);
    if (f.reliefStatus) fail('already', '申請はもう受け付けています', 409);
    const reason = String(b.reason || '').trim(); if (!reason || reason.length > 1000) fail('needReason', '事情を1000文字以内で書いてください');
    await c.db.prepare("update cancellationFees set reliefStatus = 'pending', reliefReason = ?, reliefRequestedAt = ?, updatedAt = ?, version = version + 1 where id = ?").bind(reason, iso(c.now), iso(c.now), f.id).run();
    const s = await getStudent(c, f.studentId);
    await staffNotice(c, `【キャンセル料の申請】${fullName(s)}さん`, `${fullName(s)}さんの保護者から、キャンセル料の減額・免除の申請がありました。\n${reason}`);
    await audit(c, 'cancelFeeReliefRequest', f.id);
    return {};
  },
};

