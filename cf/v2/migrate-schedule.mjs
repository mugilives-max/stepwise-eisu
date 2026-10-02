// 今の台帳（env.DB）から、予定を新しい形（env.DB2）へ写す。家族・生徒を写したあとで使う（migrate-identity.mjs）。
// 写すもの: 授業（slots）、取消の申請・日時の変更のお願い（→ lessonRequests）、共有予定と授業不可（→ sharedEvents）、
//          先生の休み（→ staffUnavailability、代表の休み）、授業の種類（lessonKinds）。授業希望（wishes）は写さない（やめる機能）。
// 前に写した行（legacyId あり）を消してから写し直す。何度でもやり直せる。キャンセル済みの授業とキャンセル料は5段目で写す。
import { fail, iso, audit } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';

const truthy = v => v === 1 || v === true || v === '1' || v === 'true' || v === 'TRUE';
const normDate = v => { const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v || '').trim()); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
const normTime = v => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const parseJson = v => { try { const o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : null; } catch { return null; } };

export async function schedulePlan(old, db2) {
  const all = async (d, sql) => (await d.prepare(sql).all()).results;
  const [slots, events, blocked, offs, kinds, instructors] = await Promise.all([
    all(old, 'select * from slots'), all(old, 'select * from events'), all(old, 'select * from blocked'),
    all(old, 'select * from teacherOff'), all(old, 'select * from lessonKinds'), all(old, 'select * from instructors').catch(() => []),
  ]);
  const students = Object.fromEntries((await all(db2, "select id, legacyId, deliveryMode from students where legacyId <> ''")).map(s => [s.legacyId, s]));
  const staff = await all(db2, "select id, email, roles, contractType, status from staff where status = 'active'");
  const owner = staff.find(s => s.contractType === 'owner') || staff.find(s => rolesOf(s).includes('manager')) || null;
  const staffByEmail = Object.fromEntries(staff.map(s => [s.email, s.id]));
  const instructorEmail = Object.fromEntries(instructors.map(i => [String(i.id), String(i.email || '').toLowerCase()]));
  const problems = [], lessons = [], requests = [], shared = [], unavail = [];
  if (!owner) problems.push('代表（教室管理者）のアカウントが見つからないため、担当の講師を空にします');

  for (const s of slots) {
    const st = students[String(s.studentId)];
    if (!st) { problems.push(`授業 ${s.date} ${s.start} の生徒が新しい台帳にいません（先に家族・生徒を写してください）`); continue; }
    if (!['offered', 'booked'].includes(s.status)) continue;
    const date = normDate(s.date), start = normTime(s.start), minutes = Number(s.min);
    if (!date || !start || !(minutes >= 15 && minutes <= 300)) { problems.push(`授業 ${s.date} ${s.start} の日時・長さが読めないため写しません`); continue; }
    const cb = String(s.confirmBy || '');
    const status = s.status === 'offered' ? (cb === 'hold' ? 'held' : 'proposed') : truthy(s.done) ? 'done' : 'decided';
    const staffId = s.instructorId ? (staffByEmail[instructorEmail[String(s.instructorId)]] || '') : (owner ? owner.id : '');
    if (s.instructorId && !staffId) problems.push(`授業 ${date} ${start} の担当講師が新しい台帳にいないため、担当を空にしました`);
    const id = 'ls_' + s.id;
    lessons.push({ id, legacyId: String(s.id), studentId: st.id, staffId, date, start, minutes, subject: String(s.subject || '授業').slice(0, 30), kind: String(s.kind || '通常') || '通常',
      deliveryMode: ['in_person', 'online'].includes(s.deliveryMode) ? s.deliveryMode : (st.deliveryMode || 'in_person'), status,
      confirmBy: status === 'proposed' && /^\d{4}-\d{2}-\d{2}$/.test(normDate(cb)) ? normDate(cb) : '', decided: status === 'decided' || status === 'done',
      calendarEventId: String(s.eventId || ''), meetUrl: String(s.meetUrl || '') });
    const req = parseJson(s.req);
    if (req && status === 'decided') requests.push({ id: 'rq_' + s.id + '_c', lessonId: id, studentId: st.id, kind: req.requestType === 'exception' ? 'cancel' : 'rest', note: String(req.reason || ''), receivedAt: String(req.receivedAt || req.at || '') });
    if (s.changeReqAt && ['move', 'late'].includes(s.changeReqKind)) requests.push({ id: 'rq_' + s.id + '_m', lessonId: id, studentId: st.id, kind: s.changeReqKind, note: String(s.changeReqNote || ''), receivedAt: String(s.changeReqAt), fromKind: s.changeReqBy === 'parent' ? 'family' : 'student' });
  }
  for (const e of events) {
    const st = students[String(e.studentId)], date = normDate(e.date); if (!st || !date) continue;
    shared.push({ id: 'ev_' + e.id, legacyId: 'e:' + e.id, studentId: st.id, kind: e.kind === 'test' ? 'test' : 'event', date, dateTo: normDate(e.dateTo) || date, start: '', end: '', title: String(e.title || '').slice(0, 60) });
  }
  for (const b of blocked) {
    const st = students[String(b.studentId)], date = normDate(b.date); if (!st || !date) continue;
    shared.push({ id: 'ev_b' + b.id, legacyId: 'b:' + b.id, studentId: st.id, kind: 'unavailable', date, dateTo: date, start: normTime(b.start), end: normTime(b.end), title: String(b.note || '').slice(0, 60) });
  }
  for (const o of offs) {
    const date = normDate(o.date); if (!date) continue;
    unavail.push({ id: 'un_' + o.id, legacyId: String(o.id), staffId: owner ? owner.id : '', date, start: normTime(o.start), end: normTime(o.end), note: String(o.note || '').slice(0, 100) });
  }
  const kindRows = kinds.map(k => ({ name: String(k.name || '') || '通常', standardMinutes: Number(k.standardMin) || 0, standardFee: Number(k.standardFee) || 0, active: k.active === null || k.active === undefined ? 1 : truthy(k.active) ? 1 : 0, sortOrder: Number(k.sortOrder) || 0 }));
  if (!kindRows.some(k => k.name === '通常')) kindRows.unshift({ name: '通常', standardMinutes: 0, standardFee: 0, active: 1, sortOrder: 0 });
  return { lessons, requests, shared, unavail, kinds: kindRows, problems };
}

const count = (rows, f) => rows.filter(f).length;
export const migrateScheduleRoutes = {
  'admin/migrate/schedule/preview': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const p = await schedulePlan(c.env.DB, c.db);
    return {
      lessons: { total: p.lessons.length, held: count(p.lessons, l => l.status === 'held'), proposed: count(p.lessons, l => l.status === 'proposed'), decided: count(p.lessons, l => l.status === 'decided'), done: count(p.lessons, l => l.status === 'done') },
      requests: p.requests.length, sharedEvents: p.shared.length, unavailability: p.unavail.length, kinds: p.kinds.map(k => k.name), problems: p.problems,
      copied: (await c.db.prepare("select count(*) n from lessons where legacyId <> ''").first()).n,
    };
  },
  'admin/migrate/schedule/apply': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (b.confirm !== true) fail('needConfirm', '確認してから写してください');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    if (!(await c.db.prepare("select 1 from students where legacyId <> ''").first())) fail('noStudents', '先に家族・生徒を写してください', 409);
    if ((await c.db.prepare("select count(*) n from lessonRecords where lessonId in (select id from lessons where legacyId <> '')").first()).n)
      fail('useAll', '授業記録を写したあとは、予定だけを写し直せません。「全部を順に写し直す」を使ってください', 409);
    const p = await schedulePlan(c.env.DB, c.db), now = iso(c.now), db = c.db;
    const stmts = [
      db.prepare("delete from lessonRequests where lessonId in (select id from lessons where legacyId <> '')"),
      db.prepare("delete from lessons where legacyId <> ''"),
      db.prepare("delete from sharedEvents where legacyId <> ''"),
      db.prepare("delete from staffUnavailability where legacyId <> ''"),
    ];
    for (const k of p.kinds) stmts.push(db.prepare('insert into lessonKinds (name, standardMinutes, standardFee, active, sortOrder, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?) on conflict(name) do update set standardMinutes = excluded.standardMinutes, standardFee = excluded.standardFee, active = excluded.active, sortOrder = excluded.sortOrder, updatedAt = excluded.updatedAt')
      .bind(k.name, k.standardMinutes, k.standardFee, k.active, k.sortOrder, now, now));
    for (const l of p.lessons) stmts.push(db.prepare('insert into lessons (id, legacyId, studentId, staffId, date, start, minutes, subject, kind, deliveryMode, status, confirmBy, decidedAt, decidedBy, calendarEventId, meetUrl, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(l.id, l.legacyId, l.studentId, l.staffId, l.date, l.start, l.minutes, l.subject, l.kind, l.deliveryMode, l.status, l.confirmBy, l.decided ? now : '', l.decided ? 'legacy' : '', l.calendarEventId, l.meetUrl, now, now));
    for (const r of p.requests) stmts.push(db.prepare("insert into lessonRequests (id, lessonId, studentId, kind, note, fromKind, receivedAt, status, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .bind(r.id, r.lessonId, r.studentId, r.kind, r.note, r.fromKind || 'student', r.receivedAt || now, now, now));
    for (const e of p.shared) stmts.push(db.prepare("insert into sharedEvents (id, legacyId, studentId, kind, date, dateTo, start, end, title, createdByKind, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?)")
      .bind(e.id, e.legacyId, e.studentId, e.kind, e.date, e.dateTo, e.start, e.end, e.title, now, now));
    for (const o of p.unavail) stmts.push(db.prepare('insert into staffUnavailability (id, legacyId, staffId, date, start, end, note, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(o.id, o.legacyId, o.staffId, o.date, o.start, o.end, o.note, now, now));
    await db.batch(stmts);
    await audit(c, 'migrateSchedule', '', { lessons: p.lessons.length, requests: p.requests.length, shared: p.shared.length, unavailability: p.unavail.length });
    return { lessons: p.lessons.length, requests: p.requests.length, sharedEvents: p.shared.length, unavailability: p.unavail.length, problems: p.problems };
  },
};
