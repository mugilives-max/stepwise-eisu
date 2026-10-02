// 計画・料金の計算（5段目）。予定（schedule.mjs）と請求（billing.mjs）の両方から使うので、ほかの領域を import しない。
// - 授業を承認済みの計画の行に割り当てる（assignLines）
// - 1回の授業料（lessonAmount）。計画の1回の時間と授業の長さが違うときは、時間で割り戻す
// - キャンセル料の行を作る・消す（createCancelFee / dropCancelFee）
import { newId, iso } from './util.mjs';

export const LATE_FEE = 1000; // 前日23時を過ぎて、開始前の連絡（規約案 第5条）
export const validMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
export const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export const lineCap = l => (l.approvedCount === null || l.approvedCount === undefined ? Number(l.count) : Number(l.approvedCount));
export const lessonAmount = (line, lesson) => Number(line.minutes) === Number(lesson.minutes) ? Number(line.fee) : Math.round(Number(line.fee) * Number(lesson.minutes) / Number(line.minutes));
export const baseAmount = (student, minutes) => Math.round(Number(student.baseRate30 || 0) * Number(minutes) / 30);
const kindOf = k => String(k || '') || '通常';
export const lineMatches = (line, lesson) => line.studentId === lesson.studentId && line.subject === lesson.subject && kindOf(line.kind) === kindOf(lesson.kind) && line.startDate <= lesson.date && lesson.date <= line.endDate;
const byTime = (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

// 割り当て: 請求済みの授業は請求したときの行のまま。ほかは日付順に、元の行 → 追加の行（開始日順）の順で、空きのある最初の行へ。
// lessons は決定・実施済みの授業。invoicedLine は { lessonId: planLineId }（取消していない請求の内訳から）
export function assignLines(lines, lessons, invoicedLine = {}) {
  const approved = lines.filter(l => l.status === 'approved' && lineCap(l) > 0)
    .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  const used = {}, line = {}, sorted = lessons.slice().sort(byTime);
  for (const ls of sorted) if (ls.id in invoicedLine) {
    const l = approved.find(x => x.id === invoicedLine[ls.id]) || null;
    line[ls.id] = l; if (l) used[l.id] = (used[l.id] || 0) + 1;
  }
  for (const ls of sorted) {
    if (ls.id in line) continue;
    const l = approved.find(x => lineMatches(x, ls) && (used[x.id] || 0) < lineCap(x)) || null;
    line[ls.id] = l; if (l) used[l.id] = (used[l.id] || 0) + 1;
  }
  return { line, used };
}

// 生徒ごとの計画・授業・請求済みの行をまとめて読む
export async function studentBilling(db, studentId, { ignoreInvoiceId = '' } = {}) {
  const lines = (await db.prepare('select * from planLines where studentId = ? order by startDate, id').bind(studentId).all()).results;
  const lessons = (await db.prepare("select * from lessons where studentId = ? and status in ('decided', 'done') order by date, start").bind(studentId).all()).results;
  const items = (await db.prepare("select i.lessonId, i.planLineId, i.invoiceId from invoiceItems i join invoices v on v.id = i.invoiceId where i.studentId = ? and i.kind = 'lesson' and v.status <> 'void'").bind(studentId).all()).results;
  const invoicedLine = {};
  for (const it of items) if (it.invoiceId !== ignoreInvoiceId && it.lessonId) invoicedLine[it.lessonId] = it.planLineId;
  return { lines, lessons, invoicedLine, ...assignLines(lines, lessons, invoicedLine) };
}

// 計画がまだ承認されていない授業の見込みの料金: 承認待ちの行 → 生徒の基本単価
export function estimateFor(lines, student, lesson) {
  const l = lines.find(x => x.status === 'proposed' && lineMatches(x, lesson)) || lines.find(x => x.status === 'approved' && lineMatches(x, lesson));
  return l ? lessonAmount(l, lesson) : baseAmount(student, lesson.minutes);
}

// キャンセル料の規定額。開始前の連絡は 1,000円、開始後・連絡なしはその授業の授業料
export async function standardCancelFee(db, lesson, type) {
  if (type === 'late') return LATE_FEE;
  const lines = (await db.prepare("select * from planLines where studentId = ? and status in ('approved', 'proposed')").bind(lesson.studentId).all()).results;
  const s = await db.prepare('select baseRate30 from students where id = ?').bind(lesson.studentId).first();
  return estimateFor(lines.sort((a, b) => (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1)), s || {}, lesson);
}
// キャンセルにしたときに、判断待ちのキャンセル料を作る（前のものがあれば置き換える。請求済みは触らない）
export async function createCancelFee(c, lesson, type, receivedAt) {
  const amount = await standardCancelFee(c.db, lesson, type), now = iso(c.now);
  await c.db.batch([
    c.db.prepare("delete from cancellationFees where lessonId = ? and invoiceId = ''").bind(lesson.id),
    c.db.prepare("insert into cancellationFees (id, lessonId, studentId, type, receivedAt, standardAmount, amount, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(lessonId) do nothing")
      .bind(newId('cf'), lesson.id, lesson.studentId, type, receivedAt || '', amount, amount, now, now),
  ]);
}
export async function dropCancelFee(c, lessonId) {
  await c.db.prepare("delete from cancellationFees where lessonId = ? and invoiceId = ''").bind(lessonId).run();
}
