// 授業記録・宿題・引き継ぎメモ（4段目）。migrations-v2/0004_records.sql
// - 講師は自分の担当の授業の記録を書く（教室管理者はすべて）。下書きのあいだは生徒・保護者に見せない。
// - 「保存して公開」で公開した版を残し、宿題も見えるようにする。決定の授業はそのとき実施済みにする。
// - 宿題: 生徒・保護者が「できた」→ スタッフが確認（またはやり直し）。
// - 引き継ぎメモ: 次にその生徒を担当する講師・代講への伝言。読んだ人を残す。
import { fail, newId, iso, audit } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';
import { requireFamily } from './family.mjs';
import { todayJst, addDays, studentByLink } from './schedule.mjs';

const STAFF_NOTE_KEYS = ['plannedUnit', 'understanding', 'pace', 'homeworkReview', 'homeworkAccuracy', 'nextFocus', 'memo'];
// 選ぶ項目の値（表記がずれないように）。写した記録の自由な文字は、直さない限りそのまま残す
export const NOTE_CHOICES = {
  understanding: ['5', '4', '3', '2', '1'],
  pace: ['ahead', 'onTrack', 'behind'],
  homeworkReview: ['done', 'partial', 'notDone', 'none'],
};
function cleanRangeParts(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 10) fail('badRange', '扱った範囲の項目は10件までにしてください');
  return list.map(p => ({ unit: String(p.unit || '').trim().slice(0, 60), material: String(p.material || '').trim().slice(0, 60), pages: String(p.pages || '').trim().slice(0, 30) })).filter(p => p.unit || p.material || p.pages);
}
const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const isManager = me => rolesOf(me).includes('manager');

async function getLesson(c, id) { const l = await c.db.prepare('select * from lessons where id = ?').bind(String(id || '')).first(); if (!l) fail('notFound', '授業が見つかりません', 404); return l; }
// 講師が見てよい生徒（担当中か、前後90日に担当した生徒）
async function teacherStudentIds(c, staffId) {
  const today = todayJst(c.now);
  return (await c.db.prepare('select distinct studentId from lessons where staffId = ? and date between ? and ?').bind(staffId, addDays(today, -120), addDays(today, 90)).all()).results.map(r => r.studentId);
}
async function mayWrite(c, me, lesson) { if (!isManager(me) && lesson.staffId !== me.id) fail('forbidden', '担当の授業だけ記録できます', 403); }
async function maySee(c, me, studentId) { if (!isManager(me) && !(await teacherStudentIds(c, me.id)).includes(studentId)) fail('forbidden', '担当の生徒だけ見られます', 403); }

function homeworkView(h, lessons = []) {
  let due = h.dueMode === 'date' ? h.dueDate : '';
  if (h.dueMode === 'nextLesson') {
    const after = h._after || '';
    const next = lessons.find(l => l.date > after && ['proposed', 'decided'].includes(l.status) && (!h.dueSubject || l.subject === h.dueSubject));
    due = next ? next.date : '';
  }
  return { id: h.id, recordId: h.recordId, kind: h.kind, title: h.title, material: h.material, dueMode: h.dueMode, dueDate: h.dueDate, dueSubject: h.dueSubject, due, status: h.status, reportedAt: h.reportedAt, reviewNote: h.reviewNote, checkResult: h.checkResult || '', checkedAt: h.checkedAt || '', checkedRecordId: h.checkedRecordId || '', version: h.version };
}
function recordStaffView(r) {
  return r ? { id: r.id, lessonId: r.lessonId, status: r.status, range: r.range, comment: r.comment, parentMessage: r.parentMessage, staffNotes: parse(r.staffNotes, {}), rangeParts: parse(r.rangeParts, []), publishedAt: r.publishedAt, voidReason: r.voidReason, authorId: r.authorId, version: r.version } : null;
}
// 宿題に「授業の日」を添える（次の授業までの宿題の期限を決めるため）
async function homeworkWithAfter(c, rows) {
  const recIds = [...new Set(rows.map(h => h.recordId).filter(Boolean))];
  const after = recIds.length ? Object.fromEntries((await c.db.prepare(`select r.id, l.date from lessonRecords r join lessons l on l.id = r.lessonId where r.id in (${recIds.map(() => '?').join(', ')})`).bind(...recIds).all()).results.map(x => [x.id, x.date])) : {};
  return rows.map(h => ({ ...h, _after: after[h.recordId] || '' }));
}
async function futureLessons(c, studentId) {
  return (await c.db.prepare("select date, subject, status from lessons where studentId = ? and status in ('proposed', 'decided') order by date, start").bind(studentId).all()).results;
}

// 宿題ごとのチェック [{ id, result }]。result: done（やってきた → 確認済み）/ partial・notDone（未完了のまま持ち越す）/ ''（チェックを外す）
const CHECK_RESULTS = ['done', 'partial', 'notDone', ''];
async function homeworkChecks(c, list, lesson, recordId, now, stmts) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) fail('badChecks', '宿題のチェックを確かめてください');
  const out = [];
  for (const x of list) {
    const result = String((x && x.result) || '');
    if (!CHECK_RESULTS.includes(result)) fail('badChecks', '宿題のチェックは「やってきた・一部・やってこなかった」から選んでください');
    const h = await c.db.prepare('select * from homework where id = ?').bind(String((x && x.id) || '')).first();
    if (!h || h.studentId !== lesson.studentId || h.kind !== 'homework' || h.recordId === recordId) fail('notFound', 'チェックする宿題が見つかりません', 404);
    const here = h.checkedRecordId === recordId;
    if (!here && !['open', 'reported'].includes(h.status)) fail('badStatus', 'この宿題はもう確認済みです。画面を更新してください', 409);
    if (!result) {
      // 外す: この記録で付けたチェックだけ戻す（確認済みにしていたら未完了へ）
      if (here) stmts.push(c.db.prepare("update homework set status = case when status = 'confirmed' then 'open' else status end, checkResult = '', checkedAt = '', checkedRecordId = '', updatedAt = ?, version = version + 1 where id = ?").bind(now, h.id));
      out.push(''); continue;
    }
    if (here && h.checkResult === result) { out.push(result); continue; }
    if (result === 'done') stmts.push(c.db.prepare("update homework set status = 'confirmed', reviewedAt = ?, checkResult = 'done', checkedAt = ?, checkedRecordId = ?, updatedAt = ?, version = version + 1 where id = ?").bind(now, now, recordId, now, h.id));
    else stmts.push(c.db.prepare("update homework set status = 'open', reportedAt = '', reportedBy = '', checkResult = ?, checkedAt = ?, checkedRecordId = ?, updatedAt = ?, version = version + 1 where id = ?").bind(result, now, recordId, now, h.id));
    out.push(result);
  }
  return out;
}
function cleanHomework(list) {
  if (!Array.isArray(list) || list.length > 10) fail('badHomework', '宿題は10件までにしてください');
  return list.map((h, i) => {
    const title = String(h.title || '').trim(); if (!title || title.length > 200) fail('badHomework', '宿題の内容を200文字以内で入れてください');
    const dueMode = ['date', 'nextLesson', 'none'].includes(h.dueMode) ? h.dueMode : 'nextLesson';
    if (dueMode === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(h.dueDate || ''))) fail('badHomework', '宿題の期限の日付を入れてください');
    return { id: h.id ? String(h.id) : '', kind: h.kind === 'item' ? 'item' : 'homework', title, material: String(h.material || '').trim().slice(0, 100), dueMode, dueDate: dueMode === 'date' ? String(h.dueDate) : '', dueSubject: dueMode === 'nextLesson' ? String(h.dueSubject || '').slice(0, 30) : '', sortOrder: i };
  });
}

export const recordRoutes = {
  // 記録を書く画面に必要なもの: 授業・記録・宿題・前回の記録・未完了の宿題・次の同じ科目・テスト・引き継ぎメモ
  'records/lesson': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const l = await getLesson(c, b.lessonId); await mayWrite(c, me, l);
    const s = await c.db.prepare('select * from students where id = ?').bind(l.studentId).first();
    const r = await c.db.prepare('select * from lessonRecords where lessonId = ?').bind(l.id).first();
    const lessons = await futureLessons(c, l.studentId);
    const hwRows = await homeworkWithAfter(c, (await c.db.prepare("select * from homework where studentId = ? and status <> 'withdrawn' order by createdAt, sortOrder").bind(l.studentId).all()).results);
    const prev = await c.db.prepare(`select r.*, l2.date, l2.start, l2.subject from lessonRecords r join lessons l2 on l2.id = r.lessonId where r.studentId = ? and r.status = 'published' and (l2.date < ? or (l2.date = ? and l2.start < ?)) order by l2.date desc, l2.start desc limit 3`).bind(l.studentId, l.date, l.date, l.start).all();
    const tests = (await c.db.prepare("select * from sharedEvents where studentId = ? and kind = 'test' and dateTo >= ? order by date limit 3").bind(l.studentId, l.date).all()).results;
    const notes = (await c.db.prepare("select n.*, s.name authorName, (select readAt from handoverReads where noteId = n.id and staffId = ?) readAt from handoverNotes n left join staff s on s.id = n.authorId where n.studentId = ? and n.status = 'open' and (n.toStaffId = '' or n.toStaffId = ? or n.authorId = ?) order by n.createdAt desc limit 20").bind(me.id, l.studentId, me.id, me.id).all()).results;
    const staff = (await c.db.prepare("select id, name, roles from staff where status = 'active'").all()).results;
    // 同じ講師が同じ時間に教えている授業（2人同時の授業）。記録の画面の上で切り替える
    const hm = t => { const [a, m] = String(t).split(':').map(Number); return a * 60 + m; };
    const together = (await c.db.prepare("select l.id, l.start, l.minutes, l.subject, s.familyName, s.givenName, (select status from lessonRecords where lessonId = l.id) recordStatus from lessons l join students s on s.id = l.studentId where l.date = ? and l.staffId = ? and l.status in ('decided', 'done') order by l.start, s.familyName, s.givenName")
      .bind(l.date, l.staffId).all()).results.filter(x => hm(x.start) < hm(l.start) + l.minutes && hm(x.start) + x.minutes > hm(l.start));
    // 教材の候補: この生徒の記録で使った教材と、宿題の教材（新しい順）
    const materials = [];
    for (const row of (await c.db.prepare("select rangeParts from lessonRecords where studentId = ? order by updatedAt desc limit 50").bind(l.studentId).all()).results)
      for (const p of parse(row.rangeParts, [])) if (p.material && !materials.includes(p.material)) materials.push(p.material);
    for (const h of hwRows.slice().reverse()) if (h.material && !materials.includes(h.material)) materials.push(h.material);
    return {
      lesson: { id: l.id, date: l.date, start: l.start, minutes: l.minutes, subject: l.subject, kind: l.kind, status: l.status, staffId: l.staffId, version: l.version },
      student: { id: s.id, name: fullName(s), grade: s.grade },
      record: recordStaffView(r),
      homework: hwRows.filter(h => r && h.recordId === r.id).map(h => homeworkView(h, lessons)),
      openHomework: hwRows.filter(h => (!r || h.recordId !== r.id) && ['open', 'reported'].includes(h.status)).map(h => homeworkView(h, lessons)),
      // 宿題ごとのチェック: この授業より前に出した未完了の宿題と、この記録でチェックしたもの
      checks: hwRows.filter(h => h.kind === 'homework' && (!r || h.recordId !== r.id) && (h._after || '') <= l.date
        && (['open', 'reported'].includes(h.status) || (r && h.checkedRecordId === r.id))).map(h => ({ ...homeworkView(h, lessons), assignedOn: h._after || '', checkedHere: !!(r && h.checkedRecordId === r.id) })),
      previous: prev.results.map(p => ({ date: p.date, start: p.start, subject: p.subject, range: p.range, comment: p.comment, staffNotes: parse(p.staffNotes, {}) })),
      nextSameSubject: lessons.find(x => x.date > l.date && x.subject === l.subject) || null,
      together: together.length > 1 ? together.map(x => ({ id: x.id, name: fullName(x), familyName: x.familyName, givenName: x.givenName, start: x.start, subject: x.subject, recordStatus: x.recordStatus || '' })) : [],
      tests: tests.map(t => ({ date: t.date, dateTo: t.dateTo, title: t.title })),
      handover: notes.map(n => ({ id: n.id, body: n.body, authorName: n.authorName || '', toStaffId: n.toStaffId, createdAt: n.createdAt, read: !!n.readAt || n.authorId === me.id, mine: n.authorId === me.id })),
      staff: staff.filter(x => rolesOf(x).includes('teacher')).map(x => ({ id: x.id, name: x.name })),
      materials: materials.slice(0, 30),
      today: todayJst(c.now),
    };
  },
  // 下書き保存・保存して公開。宿題は記録ごと置き換える（id のあるものは同じ行を直す）
  'records/save': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const l = await getLesson(c, b.lessonId); await mayWrite(c, me, l);
    if (!['decided', 'done'].includes(l.status)) fail('badStatus', '決定・実施済みの授業だけ記録できます');
    if (l.date > todayJst(c.now)) fail('future', 'まだ授業の日になっていません');
    const old = await c.db.prepare('select * from lessonRecords where lessonId = ?').bind(l.id).first();
    if (old && Number(b.version) !== Number(old.version)) fail('conflict', 'ほかの人が記録を直しました。画面を更新してください', 409);
    if (old && old.status === 'void') fail('void', '無効にした記録は直せません');
    const range = String(b.range || '').trim(), comment = String(b.comment || '').trim(), parentMessage = String(b.parentMessage || '').trim();
    if (range.length > 500 || comment.length > 2000 || parentMessage.length > 1000) fail('tooLong', '文字数が多すぎます（扱った範囲500・コメント2000・保護者への連絡1000まで）');
    const publish = b.publish === true;
    if (publish && !comment) fail('needComment', '公開するときはコメントを書いてください');
    const notes = {}, before = old ? parse(old.staffNotes, {}) : {};
    for (const k of STAFF_NOTE_KEYS) if (b.staffNotes && b.staffNotes[k] !== undefined) {
      const v = String(b.staffNotes[k]).slice(0, 1000);
      if (NOTE_CHOICES[k] && v && !NOTE_CHOICES[k].includes(v) && v !== before[k]) fail('badChoice', '選ぶ項目の値を確かめてください（' + k + '）');
      if (v) notes[k] = v;
    }
    if (!String(notes.plannedUnit || '').trim()) delete notes.pace; // 進度は予定があるときだけ
    const rangeParts = cleanRangeParts(b.rangeParts);
    const hw = cleanHomework(b.homework || []);
    const id = old ? old.id : newId('lr'), now = iso(c.now), stmts = [];
    const checks = await homeworkChecks(c, b.homeworkChecks, l, id, now, stmts);
    const results = checks.filter(Boolean);
    if (results.length) notes.homeworkReview = results.every(x => x === 'done') ? 'done' : results.every(x => x === 'notDone') ? 'notDone' : 'partial';
    const status = publish ? 'published' : old ? old.status : 'draft';
    const publishedJson = publish ? JSON.stringify({ range, comment, parentMessage }) : old ? old.publishedJson : '';
    if (old) stmts.push(c.db.prepare('update lessonRecords set range = ?, comment = ?, parentMessage = ?, staffNotes = ?, rangeParts = ?, status = ?, publishedJson = ?, publishedAt = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?')
      .bind(range, comment, parentMessage, JSON.stringify(notes), JSON.stringify(rangeParts), status, publishedJson, publish ? now : old.publishedAt, now, id, old.version));
    else stmts.push(c.db.prepare('insert into lessonRecords (id, lessonId, studentId, authorId, status, range, comment, parentMessage, staffNotes, rangeParts, publishedJson, publishedAt, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, l.id, l.studentId, me.id, status, range, comment, parentMessage, JSON.stringify(notes), JSON.stringify(rangeParts), publishedJson, publish ? now : '', now, now));
    // 宿題: 送られなかった行は取り下げ（できた・確認済みの行は残す）
    const existing = (await c.db.prepare('select * from homework where recordId = ?').bind(id).all()).results;
    const keep = new Set(hw.filter(h => h.id).map(h => h.id));
    for (const e of existing) if (!keep.has(e.id) && e.status === 'open') stmts.push(c.db.prepare("update homework set status = 'withdrawn', updatedAt = ?, version = version + 1 where id = ?").bind(now, e.id));
    for (const h of hw) {
      const cur = existing.find(e => e.id === h.id);
      if (cur) stmts.push(c.db.prepare('update homework set kind = ?, title = ?, material = ?, dueMode = ?, dueDate = ?, dueSubject = ?, sortOrder = ?, updatedAt = ?, version = version + 1 where id = ?').bind(h.kind, h.title, h.material, h.dueMode, h.dueDate, h.dueSubject, h.sortOrder, now, cur.id));
      else stmts.push(c.db.prepare('insert into homework (id, recordId, studentId, kind, title, material, dueMode, dueDate, dueSubject, sortOrder, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(newId('hw'), id, l.studentId, h.kind, h.title, h.material, h.dueMode, h.dueDate, h.dueSubject, h.sortOrder, now, now));
    }
    if (publish && l.status === 'decided') stmts.push(c.db.prepare("update lessons set status = 'done', updatedAt = ?, version = version + 1 where id = ? and status = 'decided'").bind(now, l.id));
    await c.db.batch(stmts);
    await audit(c, publish ? 'recordPublish' : 'recordDraft', id, { lessonId: l.id });
    return { record: recordStaffView(await c.db.prepare('select * from lessonRecords where id = ?').bind(id).first()) };
  },
  'records/void': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const r = await c.db.prepare('select * from lessonRecords where id = ?').bind(String(b.id || '')).first();
    if (!r) fail('notFound', '記録が見つかりません', 404);
    if (Number(b.version) !== Number(r.version)) fail('conflict', 'ほかの人が記録を直しました。画面を更新してください', 409);
    const reason = String(b.reason || '').trim(); if (!reason || reason.length > 300) fail('needReason', '無効にする理由を書いてください');
    await c.db.batch([
      c.db.prepare("update lessonRecords set status = 'void', voidReason = ?, updatedAt = ?, version = version + 1 where id = ?").bind(reason, iso(c.now), r.id),
      c.db.prepare("update homework set status = 'withdrawn', updatedAt = ?, version = version + 1 where recordId = ? and status = 'open'").bind(iso(c.now), r.id),
    ]);
    await audit(c, 'recordVoid', r.id, { reason });
    return {};
  },
  // 記録待ち（日が来た決定・実施済みの授業で、公開した記録がないもの）。講師は自分の担当だけ
  'records/pending': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const today = todayJst(c.now);
    const rows = (await c.db.prepare(`select l.*, s.familyName, s.givenName, r.status recordStatus from lessons l join students s on s.id = l.studentId left join lessonRecords r on r.lessonId = l.id
      where l.status in ('decided', 'done') and l.date <= ? and l.date >= ? and (r.id is null or r.status = 'draft') order by l.date desc, l.start desc`).bind(today, addDays(today, -60)).all()).results
      .filter(l => isManager(me) || l.staffId === me.id);
    const unread = (await c.db.prepare("select count(*) n from handoverNotes n where n.status = 'open' and n.authorId <> ? and (n.toStaffId = '' or n.toStaffId = ?) and not exists (select 1 from handoverReads r where r.noteId = n.id and r.staffId = ?)").bind(me.id, me.id, me.id).first()).n;
    const reported = (await c.db.prepare("select count(*) n from homework where status = 'reported'").first()).n;
    return { lessons: rows.map(l => ({ id: l.id, date: l.date, start: l.start, subject: l.subject, studentName: fullName(l), status: l.status, draft: l.recordStatus === 'draft' })), unreadHandover: unread, reportedHomework: isManager(me) ? reported : undefined };
  },
  // 宿題の確認待ち（生徒・保護者が「できた」と知らせたもの）。講師は担当の生徒だけ
  'homework/reported': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    let rows = (await c.db.prepare("select h.*, s.familyName, s.givenName from homework h join students s on s.id = h.studentId where h.status = 'reported' order by h.reportedAt").all()).results;
    if (!isManager(me)) { const ids = await teacherStudentIds(c, me.id); rows = rows.filter(h => ids.includes(h.studentId)); }
    return { homework: rows.map(h => ({ ...homeworkView(h), studentName: fullName(h) })) };
  },
  // 確認（confirm）・やり直し（redo、一言を添えて未完了に戻す）
  'homework/review': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const h = await c.db.prepare('select * from homework where id = ?').bind(String(b.id || '')).first();
    if (!h) fail('notFound', '宿題が見つかりません', 404); await maySee(c, me, h.studentId);
    if (Number(b.version) !== Number(h.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409);
    const note = String(b.note || '').trim().slice(0, 300);
    if (b.action === 'confirm') await c.db.prepare("update homework set status = 'confirmed', reviewedAt = ?, reviewNote = ?, updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), note, iso(c.now), h.id).run();
    else if (b.action === 'redo') { if (!note) fail('needNote', 'やり直してほしいところを書いてください'); await c.db.prepare("update homework set status = 'open', reportedAt = '', reviewedAt = ?, reviewNote = ?, updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), note, iso(c.now), h.id).run(); }
    else fail('badAction', '確認かやり直しを選んでください');
    await audit(c, 'homework:' + b.action, h.id);
    return {};
  },
  'handover/add': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'); await maySee(c, me, String(b.studentId || ''));
    const body = String(b.body || '').trim(); if (!body || body.length > 1000) fail('needBody', '伝えたいことを1000文字以内で書いてください');
    const id = newId('ho');
    await c.db.prepare('insert into handoverNotes (id, studentId, authorId, toStaffId, body, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?)').bind(id, String(b.studentId), me.id, String(b.toStaffId || ''), body, iso(c.now), iso(c.now)).run();
    await audit(c, 'handoverAdd', id);
    return { id };
  },
  'handover/read': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const n = await c.db.prepare('select * from handoverNotes where id = ?').bind(String(b.id || '')).first();
    if (!n) fail('notFound', 'メモが見つかりません', 404); await maySee(c, me, n.studentId);
    await c.db.prepare('insert into handoverReads (noteId, staffId, readAt) values (?, ?, ?) on conflict do nothing').bind(n.id, me.id, iso(c.now)).run();
    return {};
  },
  'handover/close': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const n = await c.db.prepare('select * from handoverNotes where id = ?').bind(String(b.id || '')).first();
    if (!n || (n.authorId !== me.id && !isManager(me))) fail('notFound', 'メモが見つかりません', 404);
    await c.db.prepare("update handoverNotes set status = 'closed', updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), n.id).run();
    return {};
  },

  // ---- 保護者・生徒: 公開した記録と宿題 ----
  'family/learning': async (c, b) => {
    const me = await requireFamily(c, b);
    const kids = (await c.db.prepare("select * from students where familyId = ? and status <> 'left'").bind(me.id).all()).results;
    return { students: kids.map(s => ({ id: s.id, name: fullName(s) })), ...(await learningOf(c, kids.map(s => s.id))) };
  },
  'family/homework/report': async (c, b) => { const me = await requireFamily(c, b); const ids = (await c.db.prepare('select id from students where familyId = ?').bind(me.id).all()).results.map(r => r.id); return reportHomework(c, ids, { kind: 'family', id: me.id }, b); },
  'student/learning': async (c, b) => { const s = await linkStudent(c, b); return { me: { id: s.id, name: fullName(s) }, ...(await learningOf(c, [s.id])) }; },
  'student/homework/report': async (c, b) => { const s = await linkStudent(c, b); return reportHomework(c, [s.id], { kind: 'student', id: s.id }, b); },
};

const linkStudent = studentByLink; // 専用リンク（とプレビュー）は予定と同じ確かめ方
async function learningOf(c, ids) {
  if (!ids.length) return { records: [], homework: [], today: todayJst(c.now) };
  const q = `(${ids.map(() => '?').join(', ')})`;
  const recs = (await c.db.prepare(`select r.*, l.date, l.start, l.subject, l.kind from lessonRecords r join lessons l on l.id = r.lessonId where r.studentId in ${q} and r.status = 'published' order by l.date desc, l.start desc limit 200`).bind(...ids).all()).results;
  const hw = await homeworkWithAfter(c, (await c.db.prepare(`select h.* from homework h left join lessonRecords r on r.id = h.recordId where h.studentId in ${q} and (h.recordId = '' or r.status = 'published') and h.status in ('open', 'reported', 'confirmed') order by h.createdAt desc limit 300`).bind(...ids).all()).results);
  const lessons = {}; for (const id of ids) lessons[id] = await futureLessons(c, id);
  return {
    today: todayJst(c.now),
    records: recs.map(r => { const p = parse(r.publishedJson, {}); return { id: r.id, studentId: r.studentId, date: r.date, start: r.start, subject: r.subject, kind: r.kind, range: p.range || '', comment: p.comment || '', parentMessage: p.parentMessage || '' }; }),
    homework: hw.map(h => ({ ...homeworkView(h, lessons[h.studentId] || []), studentId: h.studentId })),
  };
}
// 「できた」の知らせと取り消し（確認される前まで）
async function reportHomework(c, ids, who, b) {
  const h = await c.db.prepare('select * from homework where id = ?').bind(String(b.id || '')).first();
  if (!h || !ids.includes(h.studentId)) fail('notFound', '宿題が見つかりません', 404);
  if (b.undo === true) {
    if (h.status !== 'reported') fail('badStatus', '先生が確認した宿題は取り消せません', 409);
    await c.db.prepare("update homework set status = 'open', reportedAt = '', reportedBy = '', updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), h.id).run();
  } else {
    if (h.status === 'reported') return { homework: homeworkView(h) };
    if (h.status !== 'open') fail('badStatus', 'この宿題は報告できません', 409);
    await c.db.prepare("update homework set status = 'reported', reportedAt = ?, reportedBy = ?, updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), who.kind, iso(c.now), h.id).run();
  }
  await audit(c, b.undo ? 'homeworkUnreport' : 'homeworkReport', h.id);
  return { homework: homeworkView(await c.db.prepare('select * from homework where id = ?').bind(h.id).first()) };
}
