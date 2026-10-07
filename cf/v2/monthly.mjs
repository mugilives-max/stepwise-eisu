// スタッフの「月の仕事」（docs/UX_STRUCTURE.md 3）。月の流れの順に、どこまで済んだかをまとめる。教室管理者だけ。
// 1〜2日: 前月分の請求 / 〜20日: 翌月の計画と予定表 / 月が終わったら〜25日: 前月分の給与
// 中身はそれぞれの領域の操作をそのまま呼んで、数え直すだけ（決まりは各領域に任せる）。
import { requireStaff } from './staff.mjs';
import { todayJst } from './schedule.mjs';
import { billingRoutes } from './billing.mjs';
import { payrollRoutes } from './payroll.mjs';
import { shiftMonth, monthEnd } from './plan-calc.mjs';

const count = (rows, f) => rows.filter(f).length;

export const monthlyRoutes = {
  'monthly/overview': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const today = todayJst(c.now), month = today.slice(0, 7), prev = shiftMonth(month, -1), next = shiftMonth(month, 1), day = Number(today.slice(8));
    const [bill, fees, plans, pay] = await Promise.all([
      billingRoutes['billing/month'](c, { ...b, month: prev }),
      billingRoutes['billing/fees/list'](c, b),
      billingRoutes['billing/plans/list'](c, { ...b, month: next }),
      payrollRoutes['payroll/month'](c, { ...b, month: prev }),
    ]);
    // 1. 前月分の請求
    const inv = bill.families.filter(f => f.invoice), pre = bill.families.filter(f => f.preview);
    const billing = {
      month: prev, closeOn: bill.closeOn, families: bill.families.length,
      confirmed: inv.length, paid: count(inv, f => f.invoice.status === 'paid'), reported: count(inv, f => f.invoice.status === 'reported'), waiting: count(inv, f => f.invoice.status === 'confirmed'),
      ready: count(pre, f => f.preview.canConfirm), check: pre.filter(f => f.preview.issues.length).map(f => ({ name: f.name, issues: f.preview.issues })),
      unapproved: pre.filter(f => f.preview.pendingCount).map(f => ({ name: f.name, n: f.preview.pendingCount })),
      fees: count(fees.fees, f => f.decision === 'pending' || f.reliefStatus === 'pending'),
    };
    // 2. 翌月の計画（在籍の生徒ごと）
    const enrolled = plans.students.filter(s => s.status === 'enrolled'), main = s => s.lines.filter(l => !l.parentId);
    const planning = {
      month: next, students: enrolled.length,
      none: enrolled.filter(s => !main(s).length).map(s => ({ id: s.id, name: s.name })),
      draft: count(enrolled.flatMap(s => s.lines), l => l.status === 'draft'),
      proposed: enrolled.filter(s => s.lines.some(l => l.status === 'proposed')).map(s => ({ id: s.id, name: s.name, remindedAt: s.lines.filter(l => l.status === 'proposed').map(l => l.remindedAt).filter(Boolean).sort().at(-1) || '' })),
      approved: enrolled.filter(s => main(s).length && main(s).every(l => ['approved', 'declined'].includes(l.status))).length,
    };
    // 3. 翌月の予定表（授業の状態ごと）
    const lessons = (await c.db.prepare("select studentId, status, count(*) n from lessons where date between ? and ? and status in ('held', 'proposed', 'decided') group by studentId, status").bind(next + '-01', monthEnd(next)).all()).results;
    const by = s => lessons.filter(l => l.studentId === s.id);
    const schedule = {
      month: next,
      none: enrolled.filter(s => !by(s).length).map(s => ({ id: s.id, name: s.name })),
      held: enrolled.filter(s => by(s).some(l => l.status === 'held')).map(s => ({ id: s.id, name: s.name, n: by(s).filter(l => l.status === 'held').reduce((n, l) => n + l.n, 0) })),
      proposed: lessons.filter(l => l.status === 'proposed').reduce((n, l) => n + l.n, 0),
      decided: lessons.filter(l => l.status === 'decided').reduce((n, l) => n + l.n, 0),
    };
    // 4. 前月分の給与
    const payroll = {
      month: prev, payOn: pay.payOn, staff: pay.staff.length,
      confirmed: count(pay.staff, s => s.payroll && s.payroll.status === 'confirmed'), paid: count(pay.staff, s => s.payroll && s.payroll.status === 'paid'),
      ready: count(pay.staff, s => s.preview && s.preview.canConfirm), check: pay.staff.filter(s => s.preview && s.preview.issues.length).map(s => ({ name: s.name, issues: s.preview.issues })),
      unassigned: pay.unassigned,
    };
    // 今の時期（目安）: 1〜2日は請求、〜20日は計画と予定表、21日〜は予定表の締め切り（25日）と給与
    const now = day <= 2 ? 'billing' : day <= 20 ? 'planning' : 'closing';
    return { today, now, billing, planning, schedule, payroll };
  },
};
