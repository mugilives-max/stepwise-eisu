// 今の台帳（env.DB）から、授業計画・キャンセル料・請求を新しい形（env.DB2）へ写す。授業記録まで写したあとで使う。
// - 授業計画（planLines）: 1回の授業料は、今の仕組みが持つ30分あたりの単価から計算する（1円ずれることがある）
// - キャンセル料（cancellationFees）: 今の仕組みでは授業の行が消えているので、控えから授業（キャンセル・お休み）を作る
// - 請求（"入金管理"）: 生徒ごと・月ごとの行を、家族ごと・月ごとにまとめる。振込の連絡（approvalEvents）も写す。取り消した請求は写さない
// 前に写した行（legacyId あり）を消してから写し直す。「比べる」で、新しい計算と今の請求の金額を月ごとに比べる。
import { fail, iso, audit } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';
import { monthPreview } from './billing.mjs';
import { validMonth } from './plan-calc.mjs';

const parse = (v, d) => { try { const o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : d; } catch { return d; } };
const date10 = v => { const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v || '')); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
const time5 = v => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00'; };
const STATUS = ['draft', 'proposed', 'approved', 'declined'];

export async function billingPlan(old, db2) {
  const all = async (d, sql) => (await d.prepare(sql).all()).results;
  const [lines, fees, pays, events] = await Promise.all([
    all(old, 'select * from planLines'), all(old, 'select * from cancellationFees'), all(old, 'select * from "入金管理"'),
    all(old, "select * from approvalEvents where event = 'transferReported'"),
  ]);
  const students = Object.fromEntries((await all(db2, "select id, legacyId, familyId from students where legacyId <> ''")).map(s => [s.legacyId, s]));
  const famByLegacy = Object.fromEntries((await all(db2, "select id, legacyId from families where legacyId <> ''")).map(f => [f.legacyId, f.id]));
  const lessonIds = new Set((await all(db2, 'select id from lessons')).map(l => l.id));
  const staff = await all(db2, "select id, roles, contractType from staff where status = 'active'");
  const owner = staff.find(s => s.contractType === 'owner') || staff.find(s => rolesOf(s).includes('manager'));
  const problems = [], planLines = [], cxLessons = [], feeRows = [], invoices = [], items = [], invoicedLessons = [];

  for (const p of lines) {
    const s = students[String(p.studentId)];
    if (!s) { problems.push(`授業計画（${p.subject} ${p.startDate}〜）の生徒が新しい台帳にいないため写しません`); continue; }
    const minutes = Number(p.lessonMin) || 60, raw = Number(p.rate30 || 0) * minutes / 30, fee = Math.round(raw);
    if (raw !== fee) problems.push(`授業計画（${p.subject} ${p.startDate}〜）の1回の授業料は ${fee}円 として写します（30分あたり ${p.rate30}円 から計算）。違っていたら直してください`);
    const status = STATUS.includes(p.status) ? p.status : 'draft', decided = status === 'approved' || status === 'declined';
    const via = String(p.approvedVia || '');
    planLines.push({ id: 'pl_' + p.id, legacyId: String(p.id), studentId: s.id, parentId: p.parentId ? 'pl_' + p.parentId : '', subject: String(p.subject || '').slice(0, 30), kind: String(p.kind || '') || '通常',
      startDate: date10(p.startDate), endDate: date10(p.endDate), count: Number(p.count) || 0, minutes, fee, comment: String(p.comment || '').slice(0, 500), status,
      approvedCount: p.approvedCount === null || p.approvedCount === undefined || p.approvedCount === '' ? null : Number(p.approvedCount),
      proposedAt: String(p.proposedAt || ''), approvedAt: decided ? String(p.approvedAt || '') : '', approvedBy: decided ? (via === '保護者ページ' ? 'family' : 'staff:' + (owner ? owner.id : 'legacy')) : '',
      approvedVia: decided ? via : '', consentDate: decided ? date10(p.consentDate) : '', approvalNote: decided ? String(p.memo || '').slice(0, 300) : '',
      familyAck: ['confirmed', 'inquiry'].includes(p.parentAck) ? p.parentAck : '', familyAckAt: String(p.parentAckAt || ''), familyAckNote: String(p.parentAckMemo || '').slice(0, 500), createdAt: String(p.createdAt || '') });
  }

  // キャンセル料の控え → 授業（late・noshow はキャンセル、free・teacher はお休み）とキャンセル料
  const feeIdOf = {};
  for (const f of fees) {
    const d = parse(f.decisionJson, {}), q = d.quote || {}, slot = q.slot || {}, s = students[String(f.studentId)];
    if (f.status !== 'confirmed') { problems.push(`まだ処理していないキャンセルの連絡（${slot.date || ''}）は、写しません。今の仕組みで処理してから写し直してください`); continue; }
    if (!s || !date10(slot.date)) { problems.push(`キャンセル料（${slot.date || f.id}）の生徒・日付が分からないため写しません`); continue; }
    if (lessonIds.has('ls_' + slot.id)) { problems.push(`キャンセル料（${slot.date}）の授業がまだ予定に残っているため、授業は作りません`); }
    const fee = ['late', 'noshow'].includes(q.type);
    const lessonId = lessonIds.has('ls_' + slot.id) ? 'ls_' + slot.id : 'ls_cx_' + f.id;
    if (lessonId.startsWith('ls_cx_')) cxLessons.push({ id: lessonId, legacyId: 'cx:' + f.id, studentId: s.id, staffId: owner ? owner.id : '', date: date10(slot.date), start: time5(slot.start), minutes: Number(slot.min) > 0 ? Number(slot.min) : 60,
      subject: String(slot.subject || '授業').slice(0, 30) || '授業', deliveryMode: slot.deliveryMode === 'online' ? 'online' : 'in_person', status: fee ? 'cancelled' : 'rested' });
    if (!fee) continue;
    const r = d.relief || {}, choice = { charge: 'charge', adjust: 'adjust', waive: 'waive' }[d.choice] || 'charge';
    feeIdOf[f.id] = 'cf_' + f.id;
    feeRows.push({ id: 'cf_' + f.id, legacyId: String(f.id), lessonId, studentId: s.id, type: q.type, receivedAt: String(q.receivedAt || ''), standardAmount: Number(q.amount) || 0, amount: Number(d.amount) || 0,
      decision: choice, note: String(d.note || '').slice(0, 300), decidedAt: String(f.createdAt || ''), reliefStatus: ['pending', 'unchanged', 'reduced', 'waived'].includes(r.status) ? r.status : '',
      reliefReason: String(r.reason || ''), reliefRequestedAt: String(r.requestedAt || ''), reliefResponse: String(r.response || ''), reliefDecidedAt: String(r.decidedAt || ''), invoiceId: '', createdAt: String(f.createdAt || '') });
  }

  // 請求: 生徒ごと・月ごと → 家族ごと・月ごと
  const groups = {};
  let voided = 0;
  for (const p of pays) {
    if (p['状態'] === '取消') { voided++; continue; }
    const s = students[String(p['生徒ID'])], ym = String(p['年月'] || '').slice(0, 7);
    if (!s || !validMonth(ym)) { problems.push(`請求（${p['年月']} ${p['氏名'] || ''}）の生徒・月が分からないため写しません`); continue; }
    (groups[s.familyId + '|' + ym] = groups[s.familyId + '|' + ym] || { familyId: s.familyId, month: ym, rows: [] }).rows.push({ ...p, _student: s });
  }
  const reported = Object.fromEntries(events.map(e => [String(e.studentId).replace(/^family:/, '') + '|' + String(e.ym).slice(0, 7), String(e.recordedAt || '')]));
  const legacyFam = Object.fromEntries(Object.entries(famByLegacy).map(([k, v]) => [v, k]));
  for (const g of Object.values(groups)) {
    const id = 'iv_' + g.familyId + '_' + g.month.replace('-', '');
    const paid = g.rows.every(r => r['状態'] === '入金済');
    const reportedAt = reported[legacyFam[g.familyId] + '|' + g.month] || '';
    const status = paid ? 'paid' : reportedAt ? 'reported' : 'confirmed';
    const total = g.rows.reduce((n, r) => n + Number(r['請求額'] || 0), 0);
    const paidOn = paid ? g.rows.map(r => date10(r['入金日'])).sort().at(-1) || '' : '';
    invoices.push({ id, legacyId: g.rows.map(r => r['請求ID']).join(','), familyId: g.familyId, month: g.month, status, total, confirmedAt: g.rows.map(r => date10(r['請求日'])).filter(Boolean).sort()[0] || g.month + '-03',
      reportedAt, paidOn, paidMethod: paid ? String(g.rows[0]['入金方法'] || '振込') : '' });
    let order = 0;
    for (const r of g.rows) {
      const list = parse(r['実績JSON'], []), sid = r._student.id;
      if (!Array.isArray(list) || !list.length) {
        items.push({ id: 'ii_' + r['請求ID'] + '_all', invoiceId: id, studentId: sid, kind: 'legacy', label: '今の仕組みの請求（内訳なし）', amount: Number(r['請求額'] || 0), sortOrder: order++ });
        invoicedLessons.push({ whole: true, studentId: sid, month: g.month, invoiceId: id });
        continue;
      }
      let sum = 0;
      for (const [i, e] of list.entries()) {
        sum += Number(e.amount || 0);
        if (e.type === 'cancellation') {
          const oldFee = String(e.id || '').replace(/^cancel-fee:/, ''), feeId = feeIdOf[oldFee] || '', row = feeRows.find(x => x.id === feeId);
          if (row) row.invoiceId = id; else problems.push(`請求（${g.month}）のキャンセル料 ${e.date || ''} の元の記録が見つかりません。金額だけ写します`);
          items.push({ id: 'ii_' + r['請求ID'] + '_' + i, invoiceId: id, studentId: sid, kind: 'cancelFee', feeId, lessonId: row ? row.lessonId : '', date: date10(e.date), start: time5(e.start), subject: String(e.subject || ''), label: 'キャンセル料', amount: Number(e.amount || 0), sortOrder: order++ });
        } else {
          const lessonId = lessonIds.has('ls_' + e.id) ? 'ls_' + e.id : '';
          if (!lessonId) problems.push(`請求（${g.month}）の授業 ${e.date || ''} ${e.start || ''} が新しい台帳にありません。金額だけ写します`);
          else invoicedLessons.push({ lessonId, invoiceId: id });
          items.push({ id: 'ii_' + r['請求ID'] + '_' + i, invoiceId: id, studentId: sid, kind: 'lesson', lessonId, planLineId: e.lineId ? 'pl_' + e.lineId : '', date: date10(e.date), start: time5(e.start), minutes: Number(e.min) || 0,
            subject: String(e.subject || ''), lessonKind: String(e.kind || '') || '通常', label: e.carried ? '前の月の分' : '', amount: Number(e.amount || 0), sortOrder: order++ });
        }
      }
      if (sum !== Number(r['請求額'] || 0)) problems.push(`請求（${g.month} ${r['氏名'] || ''}）の内訳の合計 ${sum}円 と請求額 ${r['請求額']}円 が合いません`);
    }
  }
  if (voided) problems.push(`取り消した請求 ${voided}件は写しません`);
  return { planLines, cxLessons, feeRows, invoices, items, invoicedLessons, problems };
}

export const migrateBillingRoutes = {
  'admin/migrate/billing/preview': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const p = await billingPlan(c.env.DB, c.db);
    const months = [...new Set(p.invoices.map(v => v.month))].sort();
    return { planLines: { total: p.planLines.length, approved: p.planLines.filter(l => l.status === 'approved').length, proposed: p.planLines.filter(l => l.status === 'proposed').length },
      cancelled: p.cxLessons.filter(l => l.status === 'cancelled').length, rested: p.cxLessons.filter(l => l.status === 'rested').length, fees: p.feeRows.length,
      invoices: { total: p.invoices.length, paid: p.invoices.filter(v => v.status === 'paid').length, months }, problems: p.problems };
  },
  'admin/migrate/billing/apply': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (b.confirm !== true) fail('needConfirm', '確認してから写してください');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    if (!(await c.db.prepare("select 1 from lessons where legacyId <> ''").first())) fail('noLessons', '先に予定を写してください', 409);
    const p = await billingPlan(c.env.DB, c.db), now = iso(c.now), db = c.db;
    const stmts = [
      db.prepare("update lessons set invoiceId = '' where invoiceId in (select id from invoices where legacyId <> '')"),
      db.prepare("delete from invoiceItems where invoiceId in (select id from invoices where legacyId <> '')"),
      db.prepare("delete from invoices where legacyId <> ''"),
      db.prepare("delete from cancellationFees where legacyId <> ''"),
      db.prepare("delete from lessonRequests where lessonId in (select id from lessons where legacyId like 'cx:%')"),
      db.prepare("delete from lessons where legacyId like 'cx:%'"),
      db.prepare("delete from planLines where legacyId <> ''"),
    ];
    for (const l of p.planLines) stmts.push(db.prepare('insert into planLines (id, legacyId, studentId, parentId, subject, kind, startDate, endDate, count, minutes, fee, comment, status, approvedCount, proposedAt, approvedAt, approvedBy, approvedVia, consentDate, approvalNote, familyAck, familyAckAt, familyAckNote, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(l.id, l.legacyId, l.studentId, l.parentId, l.subject, l.kind, l.startDate, l.endDate, l.count, l.minutes, l.fee, l.comment, l.status, l.approvedCount, l.proposedAt, l.approvedAt, l.approvedBy, l.approvedVia, l.consentDate, l.approvalNote, l.familyAck, l.familyAckAt, l.familyAckNote, l.createdAt || now, now));
    for (const l of p.cxLessons) stmts.push(db.prepare("insert into lessons (id, legacyId, studentId, staffId, date, start, minutes, subject, kind, deliveryMode, status, decidedAt, decidedBy, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, '通常', ?, ?, ?, 'legacy', ?, ?)")
      .bind(l.id, l.legacyId, l.studentId, l.staffId, l.date, l.start, l.minutes, l.subject, l.deliveryMode, l.status, now, now, now));
    for (const v of p.invoices) stmts.push(db.prepare("insert into invoices (id, legacyId, familyId, month, status, total, confirmedAt, confirmedBy, reportedAt, paidOn, paidMethod, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?, ?, ?, ?)")
      .bind(v.id, v.legacyId, v.familyId, v.month, v.status, v.total, v.confirmedAt, v.reportedAt, v.paidOn, v.paidMethod, now, now));
    for (const f of p.feeRows) stmts.push(db.prepare('insert into cancellationFees (id, legacyId, lessonId, studentId, type, receivedAt, standardAmount, amount, decision, note, decidedAt, decidedBy, reliefStatus, reliefReason, reliefRequestedAt, reliefResponse, reliefDecidedAt, invoiceId, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(f.id, f.legacyId, f.lessonId, f.studentId, f.type, f.receivedAt, f.standardAmount, f.amount, f.decision, f.note, f.decidedAt, 'legacy', f.reliefStatus, f.reliefReason, f.reliefRequestedAt, f.reliefResponse, f.reliefDecidedAt, f.invoiceId, f.createdAt || now, now));
    for (const i of p.items) stmts.push(db.prepare('insert into invoiceItems (id, invoiceId, studentId, kind, lessonId, feeId, planLineId, date, start, minutes, subject, lessonKind, label, amount, sortOrder) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(i.id, i.invoiceId, i.studentId, i.kind, i.lessonId || '', i.feeId || '', i.planLineId || '', i.date || '', i.start || '', i.minutes || 0, i.subject || '', i.lessonKind || '', i.label || '', i.amount, i.sortOrder));
    for (const x of p.invoicedLessons) {
      if (x.whole) stmts.push(db.prepare("update lessons set invoiceId = ? where studentId = ? and status = 'done' and date between ? and ? and invoiceId = ''").bind(x.invoiceId, x.studentId, x.month + '-01', x.month + '-31'));
      else stmts.push(db.prepare('update lessons set invoiceId = ? where id = ?').bind(x.invoiceId, x.lessonId));
    }
    await db.batch(stmts);
    await audit(c, 'migrateBilling', '', { planLines: p.planLines.length, fees: p.feeRows.length, invoices: p.invoices.length });
    return { planLines: p.planLines.length, cancelled: p.cxLessons.length, fees: p.feeRows.length, invoices: p.invoices.length, problems: p.problems };
  },
  // 比べる: 写した請求（今の仕組みの金額）と、新しい計算をその月について並べる
  'admin/migrate/billing/compare': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!validMonth(b.month)) fail('badMonth', '月を選んでください');
    const fams = (await c.db.prepare("select * from families where legacyId <> '' order by name").all()).results, rows = [];
    for (const f of fams) {
      const inv = await c.db.prepare("select * from invoices where familyId = ? and month = ? and status <> 'void'").bind(f.id, b.month).first();
      const p = await monthPreview(c, f.id, b.month, { ignoreInvoiceId: inv ? inv.id : '' });
      if (!inv && !p.students.length) continue;
      rows.push({ familyId: f.id, name: f.name, old: inv ? inv.total : 0, oldFrom: inv ? (inv.confirmedBy === 'legacy' ? 'legacy' : 'v2') : '', new: p.total, same: (inv ? inv.total : 0) === p.total, issues: p.issues, pendingCount: p.pendingCount,
        students: p.students.map(s => ({ name: s.name, total: s.total, items: s.items.length, pending: s.pending.length })) });
    }
    return { month: b.month, families: rows };
  },
};
