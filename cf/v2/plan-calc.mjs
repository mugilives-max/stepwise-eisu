// 計画・料金の計算（5段目）。予定（schedule.mjs）と請求（billing.mjs）の両方から使うので、ほかの領域を import しない。
// - 授業を承認済みの計画の行に割り当てる（assignLines）
// - 1回の授業料（lessonAmount）。授業の長さが計画の1回の時間と違うときは、計画の1回の授業料 ×（授業の時間 ÷ 計画の1回の時間）。1円未満は切り捨て
// - キャンセル料の行を作る・消す（createCancelFee / dropCancelFee）
// - 新しい決まりの取消料（規約案 第4〜7条）: キャンセル・開始を遅らせる・遅刻を、連絡を受けた時刻の率で自動に計算する（setRateFee）。
//   授業の日が settings の cancelRuleFrom 以降の授業だけ。式は assets/v2/cancel-rate.js（画面と同じもの）
import { newId, iso, fail } from './util.mjs';
import { cancelRate, cancelAmount, RATE_FULL } from '../../assets/v2/cancel-rate.js';

export const LATE_FEE = 1000; // 前日23時を過ぎて、開始前の連絡（規約案 第5条）
export const validMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
export const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export const lineCap = l => (l.approvedCount === null || l.approvedCount === undefined ? Number(l.count) : Number(l.approvedCount));
// 遅刻で行わなかった分（lostMinutes）は授業料に入れない
export const lessonAmount = (line, lesson) => { const m = Number(lesson.minutes) - Number(lesson.lostMinutes || 0); return Number(line.minutes) === m ? Number(line.fee) : Math.floor(Number(line.fee) * m / Number(line.minutes)); };
export const baseAmount = (student, minutes) => Math.floor(Number(student.baseRate30 || 0) * Number(minutes) / 30);
const kindOf = k => String(k || '') || '通常';
export const lineMatches = (line, lesson) => line.studentId === lesson.studentId && line.subject === lesson.subject && kindOf(line.kind) === kindOf(lesson.kind) && line.startDate <= lesson.date && lesson.date <= line.endDate;
const byTime = (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

// 割り当て: 請求済みの授業は請求したときの行のまま。ほかは日付順に、空きのある行へ。
// 行の選び方: 1回の時間が授業と同じ行 → 元の行 → 追加の行（開始日順）。同じ科目に60分と90分の計画があっても、長さの合う方に入る
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
    const open = approved.filter(x => lineMatches(x, ls) && (used[x.id] || 0) < lineCap(x));
    const l = open.find(x => Number(x.minutes) === Number(ls.minutes)) || open[0] || null;
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

// その授業の1回の授業料（予定の長さで。承認済みの計画 → 承認待ちの計画 → 生徒の基本単価）
export async function lessonFee(db, lesson) {
  const lines = (await db.prepare("select * from planLines where studentId = ? and status in ('approved', 'proposed')").bind(lesson.studentId).all()).results;
  const s = await db.prepare('select baseRate30 from students where id = ?').bind(lesson.studentId).first();
  return estimateFor(lines.sort((a, b) => (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1)), s || {}, { ...lesson, lostMinutes: 0 });
}
// 今までの決まりのキャンセル料の規定額。開始前の連絡は 1,000円、開始後・連絡なしはその授業の授業料
export async function standardCancelFee(db, lesson, type) {
  if (type === 'late') return LATE_FEE;
  return lessonFee(db, lesson);
}

// ---- 新しい決まりの取消料 ----
export async function cancelRuleFrom(db) { const r = await db.prepare("select value from settings where key = 'cancelRuleFrom'").first(); return r ? String(r.value || '') : ''; }
export async function usesRate(db, lesson) { const from = await cancelRuleFrom(db); return /^\d{4}-\d{2}-\d{2}$/.test(from) && lesson.date >= from; }
export const PART_LABEL = { cancel: 'キャンセル', delay: '開始を遅らせた分', tardy: '遅刻' };
export const parseParts = f => { try { const v = JSON.parse(f.parts || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
// 取消の内訳を1つ作る。lesson は予定どおりの授業（開始を遅らせたときは、遅らせる前の開始時刻と長さ）
export function makePart(lesson, baseFee, reason, minutes, receivedAt) {
  const rate = cancelRate(lesson.date, lesson.start, receivedAt ? Date.parse(receivedAt) : null);
  return { reason, minutes, of: Number(lesson.minutes), start: lesson.start, receivedAt: receivedAt || '', rate, amount: cancelAmount(baseFee, Number(lesson.minutes), minutes, rate) };
}
// 取消料の行を書く（同じ reason の内訳は置き換える。minutes が 0 なら消す）。自動で decision = 'charge'。
// 請求に入ったもの・減額や免除を答えたものは変えられない
export async function setRateFee(c, lesson, reason, minutes, receivedAt) {
  const cur = await c.db.prepare('select * from cancellationFees where lessonId = ?').bind(lesson.id).first();
  if (cur && cur.invoiceId) fail('invoiced', '請求に入った取消料は変えられません。先に請求を取り消してください', 409);
  if (cur && ['reduced', 'waived'].includes(cur.reliefStatus)) fail('reliefDone', '減額・免除に回答した取消料は変えられません', 409);
  const baseFee = cur && cur.rule === 'rate' ? cur.baseFee : await lessonFee(c.db, lesson);
  const parts = (cur && cur.rule === 'rate' ? parseParts(cur) : []).filter(p => p.reason !== reason);
  if (minutes > 0) parts.push(makePart(lesson, baseFee, reason, minutes, receivedAt));
  const now = iso(c.now);
  if (!parts.length) { if (cur) await c.db.prepare('delete from cancellationFees where id = ?').bind(cur.id).run(); return null; }
  const amount = parts.reduce((n, p) => n + p.amount, 0), type = parts.some(p => p.rate < RATE_FULL) ? 'late' : 'noshow';
  const first = parts.map(p => p.receivedAt).filter(Boolean).sort()[0] || '';
  if (cur) await c.db.prepare("update cancellationFees set type = ?, receivedAt = ?, standardAmount = ?, amount = ?, decision = 'charge', note = '', decidedAt = ?, decidedBy = 'system:auto', rule = 'rate', baseFee = ?, plannedMinutes = ?, parts = ?, updatedAt = ?, version = version + 1 where id = ?")
    .bind(type, first, amount, amount, now, baseFee, cur.rule === 'rate' ? cur.plannedMinutes : Number(lesson.minutes), JSON.stringify(parts), now, cur.id).run();
  else await c.db.prepare("insert into cancellationFees (id, lessonId, studentId, type, receivedAt, standardAmount, amount, decision, decidedAt, decidedBy, rule, baseFee, plannedMinutes, parts, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, 'charge', ?, 'system:auto', 'rate', ?, ?, ?, ?, ?)")
    .bind(newId('cf'), lesson.id, lesson.studentId, type, first, amount, amount, now, baseFee, Number(lesson.minutes), JSON.stringify(parts), now, now).run();
  return { amount, parts };
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
