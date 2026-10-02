// スタッフの「生徒」（docs/UX_STRUCTURE.md 3）。1人の生徒のことを1か所で見るための読み取りをまとめる。
// - students/list: 家族ごとの生徒の一覧（次の授業・連絡・記録待ちの印つき）。講師は担当の生徒だけ（家族の連絡先は出さない）
// - students/hub: 1人の生徒の概要・予定・記録と宿題・成績・計画と請求・基本情報。講師は担当の生徒だけで、計画と請求・基本情報は出さない
import { fail } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';
import { todayJst, addDays } from './schedule.mjs';
import { gradesRoutes } from './grades.mjs';
import { studentBilling, lineCap } from './plan-calc.mjs';

const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
async function teacherStudents(c, staffId) {
  const today = todayJst(c.now);
  return new Set((await c.db.prepare('select distinct studentId from lessons where staffId = ? and date between ? and ?').bind(staffId, addDays(today, -120), addDays(today, 90)).all()).results.map(r => r.studentId));
}

export const studentHubRoutes = {
  'students/list': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = rolesOf(me).includes('manager'), today = todayJst(c.now);
    let students = (await c.db.prepare("select s.*, f.name familyLabel from students s join families f on f.id = s.familyId order by s.status = 'left', f.testOnly, f.name, s.familyKana, s.givenKana").all()).results;
    if (!manager) { const mine = await teacherStudents(c, me.id); students = students.filter(s => mine.has(s.id)); }
    const next = Object.fromEntries((await c.db.prepare("select studentId, min(date || ' ' || start) n from lessons where status in ('proposed', 'decided') and date >= ? group by studentId").bind(today).all()).results.map(r => [r.studentId, r.n]));
    const requests = Object.fromEntries((await c.db.prepare("select studentId, count(*) n from lessonRequests where status = 'open' group by studentId").all()).results.map(r => [r.studentId, r.n]));
    const pending = Object.fromEntries((await c.db.prepare(`select l.studentId, count(*) n from lessons l left join lessonRecords r on r.lessonId = l.id
      where l.status in ('decided', 'done') and l.date <= ? and l.date >= ? and (r.id is null or r.status = 'draft') ${manager ? '' : 'and l.staffId = ?'} group by l.studentId`).bind(...[today, addDays(today, -60)].concat(manager ? [] : [me.id])).all()).results.map(r => [r.studentId, r.n]));
    const families = [];
    for (const s of students) {
      let f = families.find(x => x.id === s.familyId);
      if (!f) families.push(f = { id: manager ? s.familyId : '', name: manager ? s.familyLabel : '', students: [] });
      f.students.push({ id: s.id, name: fullName(s), kana: [s.familyKana, s.givenKana].filter(Boolean).join(' '), grade: s.grade, status: s.status, testOnly: !!s.testOnly, next: next[s.id] || '', requests: manager ? requests[s.id] || 0 : 0, pendingRecords: pending[s.id] || 0 });
    }
    // 講師には家族をまとめず、生徒だけを並べる
    return { manager, families: manager ? families : [{ id: '', name: '', students: families.flatMap(f => f.students) }] };
  },

  'students/hub': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = rolesOf(me).includes('manager'), today = todayJst(c.now);
    const s = await c.db.prepare('select s.*, f.name familyLabel, f.guardianName, f.email familyEmail, f.phone familyPhone, f.status familyStatus from students s join families f on f.id = s.familyId where s.id = ?').bind(String(b.studentId || '')).first();
    if (!s) fail('notFound', '生徒が見つかりません', 404);
    if (!manager && !(await teacherStudents(c, me.id)).has(s.id)) fail('forbidden', '担当の生徒だけ見られます', 403);
    const staff = Object.fromEntries((await c.db.prepare('select id, name from staff').all()).results.map(x => [x.id, x.name]));
    const all = (await c.db.prepare('select * from lessons where studentId = ? order by date, start').bind(s.id).all()).results;
    const lessonView = l => ({ id: l.id, date: l.date, start: l.start, minutes: l.minutes, subject: l.subject, kind: l.kind, status: l.status, deliveryMode: l.deliveryMode, staffName: staff[l.staffId] || '', confirmBy: l.confirmBy });
    const upcoming = all.filter(l => l.date >= today && ['held', 'proposed', 'decided'].includes(l.status)).slice(0, 20).map(lessonView);
    const past = all.filter(l => l.date < today || ['done', 'rested', 'cancelled'].includes(l.status)).slice(-30).reverse().map(lessonView);
    const recs = (await c.db.prepare("select r.*, l.date, l.start, l.subject from lessonRecords r join lessons l on l.id = r.lessonId where r.studentId = ? and r.status <> 'void' order by l.date desc, l.start desc limit 30").bind(s.id).all()).results
      .map(r => ({ lessonId: r.lessonId, date: r.date, start: r.start, subject: r.subject, status: r.status, range: r.range, comment: r.comment, staffNotes: parse(r.staffNotes, {}), authorName: staff[r.authorId] || '' }));
    const pendingRecords = all.filter(l => ['decided', 'done'].includes(l.status) && l.date <= today && l.date >= addDays(today, -60) && (manager || l.staffId === me.id) && !recs.some(r => r.lessonId === l.id && r.status === 'published')).map(lessonView);
    const homework = (await c.db.prepare("select * from homework where studentId = ? and status in ('open', 'reported') order by createdAt desc").bind(s.id).all()).results
      .map(h => ({ id: h.id, kind: h.kind, title: h.title, material: h.material, dueMode: h.dueMode, dueDate: h.dueDate, dueSubject: h.dueSubject, status: h.status, version: h.version }));
    const handover = (await c.db.prepare("select * from handoverNotes where studentId = ? and status = 'open' order by createdAt desc limit 10").bind(s.id).all()).results
      .map(n => ({ id: n.id, body: n.body, authorName: staff[n.authorId] || '', createdAt: n.createdAt }));
    const requests = manager ? (await c.db.prepare("select r.*, l.date, l.start, l.subject from lessonRequests r join lessons l on l.id = r.lessonId where r.studentId = ? and r.status = 'open' order by r.receivedAt").bind(s.id).all()).results
      .map(r => ({ id: r.id, kind: r.kind, note: r.note, date: r.date, start: r.start, subject: r.subject, lessonId: r.lessonId })) : [];
    const grades = await gradesRoutes['grades/student'](c, { ...b, studentId: s.id });
    const events = (await c.db.prepare("select * from sharedEvents where studentId = ? and dateTo >= ? order by date limit 10").bind(s.id, today).all()).results.map(e => ({ kind: e.kind, date: e.date, dateTo: e.dateTo, title: e.title }));
    const out = {
      today, manager,
      student: { id: s.id, name: fullName(s), kana: [s.familyKana, s.givenKana].filter(Boolean).join(' '), grade: s.grade, school: s.school, status: s.status, deliveryMode: s.deliveryMode, testOnly: !!s.testOnly },
      upcoming, past, records: recs, pendingRecords, homework, handover, requests, events,
      grades: { exams: grades.exams, nextTest: grades.nextTest, pendingTests: grades.pendingTests, subjects: grades.subjects },
    };
    if (manager) {
      // 計画: 今月と来月にかかる行と、入り具合
      const month = today.slice(0, 7), sb = await studentBilling(c.db, s.id);
      const nextMonthEnd = addDays(addDays(month + '-01', 62).slice(0, 7) + '-01', -1);
      out.plans = sb.lines.filter(l => l.endDate >= month + '-01' && l.startDate <= nextMonthEnd).map(l => ({ id: l.id, subject: l.subject, kind: l.kind, startDate: l.startDate, endDate: l.endDate, count: l.count, cap: lineCap(l), minutes: l.minutes, fee: l.fee, status: l.status, used: sb.used[l.id] || 0, parentId: l.parentId }));
      out.invoices = (await c.db.prepare("select * from invoices where familyId = ? and status <> 'void' order by month desc limit 6").bind(s.familyId).all()).results.map(v => ({ id: v.id, month: v.month, total: v.total, status: v.status }));
      out.basic = { familyId: s.familyId, familyName: s.familyLabel, guardianName: s.guardianName, email: s.familyEmail, phone: s.familyPhone, familyStatus: s.familyStatus, school: s.school, baseRate30: s.baseRate30, note: s.note, enrolledOn: s.enrolledOn, subjects: s.subjects };
    }
    return out;
  },
};
