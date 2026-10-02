// 今の台帳（env.DB）から、授業記録・宿題・授業準備のメモを新しい形（env.DB2）へ写す。予定を写したあとで使う（migrate-schedule.mjs）。
// - 授業記録（lessonRecords）: 公開した最新の版（lessonPublicSnapshots）と先生だけのメモ（lessonPrivateNotes）を合わせる
// - 宿題（tasks）→ homework、授業準備（lessonPreparations）→ 引き継ぎメモ
// 前に写した行（legacyId あり）を消してから写し直す。
import { fail, iso, audit } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';

const parse = (v, d) => { try { const o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : d; } catch { return d; } };
const date10 = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[0] : ''; };

export async function recordsPlan(old, db2) {
  const all = async (d, sql) => (await d.prepare(sql).all()).results;
  const [recs, snaps, privs, tasks, preps] = await Promise.all([
    all(old, 'select * from lessonRecords'), all(old, 'select * from lessonPublicSnapshots'), all(old, 'select * from lessonPrivateNotes'),
    all(old, 'select * from tasks'), all(old, 'select * from lessonPreparations'),
  ]);
  const lessons = Object.fromEntries((await all(db2, "select id, legacyId, studentId from lessons where legacyId <> ''")).map(l => [l.legacyId, l]));
  const students = Object.fromEntries((await all(db2, "select id, legacyId from students where legacyId <> ''")).map(s => [s.legacyId, s.id]));
  const staff = await all(db2, "select id, roles, contractType from staff where status = 'active'");
  const owner = staff.find(s => s.contractType === 'owner') || staff.find(s => rolesOf(s).includes('manager'));
  const latest = {}; for (const s of snaps) if (!latest[s.recordId] || Number(s.revision) > Number(latest[s.recordId].revision)) latest[s.recordId] = s;
  const privOf = Object.fromEntries(privs.map(p => [p.recordId, p.teacherNote]));
  const problems = [], records = [], homework = [], notes = [];
  const recordIds = new Set();
  for (const r of recs) {
    const l = lessons[String(r.slotId)];
    if (!l) { problems.push(`授業記録（${r.lessonDate} ${r.subject}）の授業が新しい台帳にないため写しません`); continue; }
    if (recordIds.has(l.id)) { problems.push(`同じ授業に記録が2つあります（${r.lessonDate} ${r.subject}）。新しい方だけ写します`); continue; }
    recordIds.add(l.id);
    const rep = parse(r.reportJson, {}), snap = latest[r.id], srep = snap ? parse(snap.reportJson, {}) : {};
    const status = r.status === 'void' ? 'void' : snap ? 'published' : 'draft';
    const staffNotes = {};
    for (const [k, v] of [['plannedUnit', rep.plannedUnit], ['understanding', rep.understanding], ['pace', rep.pace], ['homeworkReview', rep.homeworkReview], ['homeworkAccuracy', rep.homeworkAccuracy], ['nextFocus', r.nextFocus], ['memo', privOf[r.id]]]) if (v !== undefined && v !== null && String(v) !== '') staffNotes[k] = String(v);
    records.push({ id: 'lr_' + r.id, legacyId: String(r.id), lessonId: l.id, studentId: l.studentId, authorId: owner ? owner.id : '', status,
      range: String(rep.actualUnit || r.progress || '').slice(0, 500), comment: String(r.content || '').slice(0, 2000), parentMessage: String(rep.parentMessage || '').slice(0, 1000),
      staffNotes: JSON.stringify(staffNotes), voidReason: String(r.voidReason || ''),
      publishedJson: snap ? JSON.stringify({ range: String(srep.actualUnit || snap.progress || ''), comment: String(snap.content || ''), parentMessage: String(srep.parentMessage || '') }) : '', publishedAt: snap ? String(snap.publishedAt || '') : '', createdAt: String(r.createdAt || '') });
  }
  const recByLegacy = Object.fromEntries(records.map(r => [r.legacyId, r.id]));
  for (const t of tasks) {
    const sid = students[String(t.studentId)];
    if (!sid) continue;
    const dueMode = ['date', 'nextLesson', 'none'].includes(t.dueMode) ? t.dueMode : (date10(t.due) ? 'date' : 'none');
    const status = t.withdrawnAt ? 'withdrawn' : t.reviewedAt ? 'confirmed' : t.doneAt ? 'reported' : 'open';
    homework.push({ id: 'hw_' + t.id, legacyId: String(t.id), recordId: recByLegacy[String(t.sourceRecordId)] || '', studentId: sid, kind: t.type === '持ち物' ? 'item' : 'homework',
      title: String(t.title || '').slice(0, 200) || '（内容なし）', material: String(t.material || '').slice(0, 100), dueMode, dueDate: dueMode === 'date' ? date10(t.due) : '', dueSubject: dueMode === 'nextLesson' ? String(t.dueSubject || '') : '',
      status, reportedAt: String(t.doneAt || ''), reviewedAt: String(t.reviewedAt || ''), reviewNote: String(t.reviewNote || '').slice(0, 300), createdAt: String(t.createdAt || '') });
  }
  for (const p of preps) {
    const sid = students[String(p.studentId)]; if (!sid || !String(p.body || '').trim()) continue;
    notes.push({ id: 'ho_' + p.id, legacyId: String(p.id), studentId: sid, authorId: owner ? owner.id : '', body: `（授業準備 ${p.lessonDate} ${p.subject}）\n` + String(p.body).slice(0, 900), createdAt: String(p.updatedAt || '') });
  }
  return { records, homework, notes, problems };
}

export const migrateRecordsRoutes = {
  'admin/migrate/records/preview': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const p = await recordsPlan(c.env.DB, c.db);
    return { records: { total: p.records.length, published: p.records.filter(r => r.status === 'published').length, void: p.records.filter(r => r.status === 'void').length },
      homework: { total: p.homework.length, open: p.homework.filter(h => h.status === 'open').length, reported: p.homework.filter(h => h.status === 'reported').length, confirmed: p.homework.filter(h => h.status === 'confirmed').length },
      handover: p.notes.length, problems: p.problems };
  },
  'admin/migrate/records/apply': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (b.confirm !== true) fail('needConfirm', '確認してから写してください');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    if (!(await c.db.prepare("select 1 from lessons where legacyId <> ''").first())) fail('noLessons', '先に予定を写してください', 409);
    const p = await recordsPlan(c.env.DB, c.db), now = iso(c.now), db = c.db;
    const stmts = [
      db.prepare("delete from homework where legacyId <> ''"), db.prepare("delete from lessonRecords where legacyId <> ''"),
      db.prepare("delete from handoverReads where noteId in (select id from handoverNotes where legacyId <> '')"), db.prepare("delete from handoverNotes where legacyId <> ''"),
    ];
    for (const r of p.records) stmts.push(db.prepare('insert into lessonRecords (id, legacyId, lessonId, studentId, authorId, status, range, comment, parentMessage, staffNotes, publishedJson, publishedAt, voidReason, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, r.legacyId, r.lessonId, r.studentId, r.authorId, r.status, r.range, r.comment, r.parentMessage, r.staffNotes, r.publishedJson, r.publishedAt, r.voidReason, r.createdAt || now, now));
    for (const h of p.homework) stmts.push(db.prepare('insert into homework (id, legacyId, recordId, studentId, kind, title, material, dueMode, dueDate, dueSubject, status, reportedAt, reviewedAt, reviewNote, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(h.id, h.legacyId, h.recordId, h.studentId, h.kind, h.title, h.material, h.dueMode, h.dueDate, h.dueSubject, h.status, h.reportedAt, h.reviewedAt, h.reviewNote, h.createdAt || now, now));
    for (const n of p.notes) stmts.push(db.prepare('insert into handoverNotes (id, legacyId, studentId, authorId, body, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?)').bind(n.id, n.legacyId, n.studentId, n.authorId, n.body, n.createdAt || now, now));
    await db.batch(stmts);
    await audit(c, 'migrateRecords', '', { records: p.records.length, homework: p.homework.length, handover: p.notes.length });
    return { records: p.records.length, homework: p.homework.length, handover: p.notes.length, problems: p.problems };
  },
};
