// 成績（6段目）。migrations-v2/0008_grades.sql、docs/REQUIREMENTS.md 5-2
// - 教室管理者: すべてを見て入力する（試験・科目ごと・全体・振り返り・成績票）
// - 講師: 担当の生徒の、担当科目の点数を見て入力する。ほかの科目は合計だけ。成績票は見ない
// - 保護者: 推移・振り返り・成績票・その期間の授業の実施状況。模試の志望校判定は持たない（成績票の PDF で足りる）。成績票の写真や PDF を送れる
// - 生徒: 科目ごとの点数の推移・次の対策・次のテストまでの日数。成績票の写真や PDF を送れる
// 成績票は送られた順に「取り込み待ち」に並び、スタッフが中身を確かめて点数を入れる。
import { fail, newId, iso, audit } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';
import { requireFamily } from './family.mjs';
import { isLive } from './accounts.mjs';
import { todayJst, addDays, staffNotice, studentByLink } from './schedule.mjs';

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T00:00:00Z'));
const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
const isManager = me => rolesOf(me).includes('manager');
const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const sameVersion = (row, b) => { if (Number(b.version) !== Number(row.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409); };
export const FILE_MAX = 10 * 1024 * 1024, CHUNK_MAX = 600 * 1024; // 1ファイル 10MB まで。1回に送るのは 600KB まで
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// ---- 講師の範囲 ----
// 担当の生徒と、その生徒に教えている科目（前後の授業から）
async function teacherScope(c, staffId) {
  const today = todayJst(c.now);
  const rows = (await c.db.prepare('select distinct studentId, subject from lessons where staffId = ? and date between ? and ?').bind(staffId, addDays(today, -120), addDays(today, 90)).all()).results;
  const out = {}; for (const r of rows) (out[r.studentId] = out[r.studentId] || []).push(r.subject);
  return out;
}
async function staffScope(c, me, studentId) {
  if (isManager(me)) return null; // すべて
  const scope = await teacherScope(c, me.id);
  if (!scope[studentId]) fail('forbidden', '担当の生徒だけ見られます', 403);
  return scope[studentId];
}

// ---- 数の確かめ ----
function num(v, { int = false, min = 0, max = 100000 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) fail('badNumber', '数を確かめてください（点数・順位・偏差値など）');
  return Math.round(n * 10) / 10;
}
function scoreFields(s) {
  const subject = String(s.subject || '').trim();
  if (!subject || subject.length > 20) fail('badSubject', '科目を20文字以内で入れてください');
  const out = { subject, score: num(s.score, { max: 10000 }), max: num(s.max, { max: 10000 }), average: num(s.average, { max: 10000 }), rank: num(s.rank, { int: true, min: 1 }), rankOf: num(s.rankOf, { int: true, min: 1 }), deviation: num(s.deviation, { min: 0, max: 150 }) };
  if (out.score !== null && out.max !== null && out.score > out.max) fail('badNumber', `${subject}の点数が満点を超えています`);
  if (out.rank !== null && out.rankOf !== null && out.rank > out.rankOf) fail('badNumber', `${subject}の順位が人数を超えています`);
  return out;
}

// ---- 読み出し（見る人ごとに絞る） ----
const scoreView = s => ({ subject: s.subject, score: s.score, max: s.max, average: s.average, rank: s.rank, rankOf: s.rankOf, deviation: s.deviation });
const sum = (rows, k) => rows.every(r => r[k] !== null && r[k] !== undefined) && rows.length ? rows.reduce((n, r) => n + r[k], 0) : null;
// who: 'manager' | 'teacher' | 'family' | 'student'。subjects は講師の担当科目
async function examsOf(c, studentId, who, subjects = null) {
  const exams = (await c.db.prepare("select * from exams where studentId = ? and status = 'recorded' order by date, createdAt").bind(studentId).all()).results;
  if (!exams.length) return [];
  const q = `(${exams.map(() => '?').join(', ')})`;
  const scores = (await c.db.prepare(`select * from examScores where examId in ${q} order by sortOrder, subject`).bind(...exams.map(e => e.id)).all()).results;
  const reviews = Object.fromEntries((await c.db.prepare(`select * from examReviews where examId in ${q}`).bind(...exams.map(e => e.id)).all()).results.map(r => [r.examId, r]));
  return exams.map(e => {
    const all = scores.filter(s => s.examId === e.id), r = reviews[e.id];
    const total = { score: e.totalScore ?? sum(all, 'score'), max: e.totalMax ?? sum(all, 'max'), rank: e.totalRank, rankOf: e.totalRankOf, deviation: e.totalDeviation, fromSubjects: e.totalScore === null && all.length > 0 };
    const out = { id: e.id, kind: e.kind, name: e.name, date: e.date, grade: e.grade, total, scores: all.map(scoreView), version: e.version };
    if (who === 'teacher') { out.scores = all.filter(s => subjects.includes(s.subject)).map(scoreView); out.otherSubjects = all.filter(s => !subjects.includes(s.subject)).map(s => s.subject); }
    if (r) out.review = who === 'student' ? { nextSteps: r.nextSteps } : who === 'teacher' ? { issues: r.issues, nextSteps: r.nextSteps, version: r.version } : { good: r.good, issues: r.issues, nextSteps: r.nextSteps, version: r.version };
    return out;
  });
}
// 保護者向け: 前の試験からその試験までに実施した授業の回数（科目ごと）
async function lessonsBetween(c, studentId, exams) {
  const lessons = (await c.db.prepare("select date, subject from lessons where studentId = ? and status = 'done' order by date").bind(studentId).all()).results;
  return exams.map((e, i) => {
    const from = i ? exams[i - 1].date : addDays(e.date, -92), counts = {};
    for (const l of lessons) if (l.date > from && l.date <= e.date) counts[l.subject] = (counts[l.subject] || 0) + 1;
    return { examId: e.id, from, counts };
  });
}
async function nextTest(c, studentId) {
  const e = await c.db.prepare("select * from sharedEvents where studentId = ? and kind = 'test' and date >= ? order by date limit 1").bind(studentId, todayJst(c.now)).first();
  return e ? { title: e.title, date: e.date, days: Math.round((Date.parse(e.date) - Date.parse(todayJst(c.now))) / 86400e3) } : null;
}
const fileView = f => ({ id: f.id, studentId: f.studentId, examId: f.examId, name: f.name, mime: f.mime, size: f.size, chunks: f.chunks, note: f.note, uploadedByKind: f.uploadedByKind, status: f.status, createdAt: f.createdAt });

// 結果の入力待ちのテスト: 共有されたテストの予定が終わって60日以内で、試験（記録・結果なし）がまだないもの
async function pendingTests(c, studentIds) {
  if (!studentIds.length) return [];
  const today = todayJst(c.now), q = `(${studentIds.map(() => '?').join(', ')})`;
  const events = (await c.db.prepare(`select e.*, s.familyName, s.givenName from sharedEvents e join students s on s.id = e.studentId where e.kind = 'test' and e.studentId in ${q} and e.dateTo < ? and e.dateTo >= ? order by e.dateTo`).bind(...studentIds, today, addDays(today, -60)).all()).results;
  const done = new Set((await c.db.prepare(`select eventId from exams where eventId <> '' and studentId in ${q}`).bind(...studentIds).all()).results.map(r => r.eventId));
  return events.filter(e => !done.has(e.id)).map(e => ({ eventId: e.id, studentId: e.studentId, studentName: fullName(e), title: e.title, date: e.date, dateTo: e.dateTo }));
}

// ---- 成績票（分けて送る・分けて読む） ----
async function uploadChunk(c, studentId, by, b) {
  const idx = Number(b.idx), total = Number(b.chunks), data = String(b.data || '');
  if (!Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || total > 20 || idx < 0 || idx >= total) fail('badChunk', '送り方が正しくありません');
  if (!data || data.length > Math.ceil(CHUNK_MAX / 3) * 4 || !/^[A-Za-z0-9+/]+=*$/.test(data)) fail('badChunk', '送り方が正しくありません');
  const now = iso(c.now);
  let f;
  if (idx === 0) {
    const mime = String(b.mime || ''), size = Number(b.size), name = String(b.name || '成績票').trim().slice(0, 80) || '成績票', note = String(b.note || '').trim();
    if (!MIMES.includes(mime)) fail('badType', '写真（JPEG・PNG）か PDF を送ってください');
    if (!Number.isInteger(size) || size < 1 || size > FILE_MAX) fail('tooLarge', 'ファイルは10MBまでにしてください');
    if (note.length > 200) fail('tooLong', '一言は200文字以内にしてください');
    const today = todayJst(c.now);
    const n = (await c.db.prepare("select count(*) n from examFiles where studentId = ? and createdAt >= ?").bind(studentId, new Date(Date.parse(today + 'T00:00:00+09:00')).toISOString()).first()).n;
    if (n >= 20) fail('tooMany', '1日に送れるのは20件までです');
    f = { id: newId('xf'), studentId, name, mime, size, chunks: total, note };
    await c.db.prepare("insert into examFiles (id, studentId, name, mime, size, chunks, note, uploadedByKind, uploadedById, status, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)")
      .bind(f.id, studentId, name, mime, size, total, note, by.kind, by.id, now, now).run();
  } else {
    f = await c.db.prepare('select * from examFiles where id = ?').bind(String(b.fileId || '')).first();
    if (!f || f.studentId !== studentId || f.uploadedById !== by.id || f.status !== 'uploading' || f.chunks !== total) fail('badChunk', '送り直してください');
  }
  await c.db.prepare('insert into examFileChunks (fileId, idx, data) values (?, ?, ?) on conflict(fileId, idx) do update set data = excluded.data').bind(f.id, idx, data).run();
  if (idx < total - 1) return { fileId: f.id, done: false };
  // 最後: そろっているか・大きさが合うかを確かめて「取り込み待ち」に
  const parts = (await c.db.prepare('select idx, length(data) len, data from examFileChunks where fileId = ? order by idx').bind(f.id).all()).results;
  const bytes = parts.reduce((n, p) => n + Math.floor(p.len * 3 / 4) - (p.data.endsWith('==') ? 2 : p.data.endsWith('=') ? 1 : 0), 0);
  if (parts.length !== total || bytes !== Number(f.size)) {
    await c.db.batch([c.db.prepare('delete from examFileChunks where fileId = ?').bind(f.id), c.db.prepare('delete from examFiles where id = ?').bind(f.id)]);
    fail('incomplete', '途中で切れました。もう一度送ってください');
  }
  await c.db.prepare("update examFiles set status = 'new', updatedAt = ? where id = ?").bind(now, f.id).run();
  if (by.kind !== 'staff') {
    const s = await c.db.prepare('select * from students where id = ?').bind(studentId).first();
    await staffNotice(c, `【成績票】${fullName(s)}さん`, `${fullName(s)}さん${by.kind === 'family' ? 'の保護者' : ''}から成績票が届きました（${f.name}）。${f.note ? '\n' + f.note : ''}\n「成績」の画面で点数を取り込んでください。`);
  }
  await audit(c, 'examFileUpload', f.id, { by: by.kind, size: f.size });
  return { fileId: f.id, done: true };
}
async function readChunk(c, f, b) {
  const idx = Number(b.idx || 0);
  if (!Number.isInteger(idx) || idx < 0 || idx >= f.chunks || f.status === 'uploading') fail('notFound', '成績票が見つかりません', 404);
  const p = await c.db.prepare('select data from examFileChunks where fileId = ? and idx = ?').bind(f.id, idx).first();
  if (!p) fail('notFound', '成績票が見つかりません', 404);
  return { file: fileView(f), idx, data: p.data };
}
async function getFile(c, id) { const f = await c.db.prepare('select * from examFiles where id = ?').bind(String(id || '')).first(); if (!f) fail('notFound', '成績票が見つかりません', 404); return f; }

// ---- 試験を作る・直す ----
async function saveExam(c, me, b) {
  const old = b.id ? await c.db.prepare('select * from exams where id = ?').bind(String(b.id)).first() : null;
  if (b.id && !old) fail('notFound', '試験が見つかりません', 404);
  if (old) sameVersion(old, b);
  const studentId = old ? old.studentId : String(b.studentId || '');
  const s = await c.db.prepare('select * from students where id = ?').bind(studentId).first(); if (!s) fail('notFound', '生徒が見つかりません', 404);
  await staffScope(c, me, s.id);
  const kind = String(b.kind ?? old?.kind ?? ''), name = String(b.name ?? old?.name ?? '').trim(), date = String(b.date ?? old?.date ?? ''), grade = String(b.grade ?? old?.grade ?? s.grade ?? '').trim().slice(0, 20);
  if (!['regular', 'mock'].includes(kind)) fail('badKind', '定期テストか模試かを選んでください');
  if (!name || name.length > 40) fail('badName', '試験の名前を40文字以内で入れてください（例: 2学期中間テスト）');
  if (!validDate(date) || date > todayJst(c.now)) fail('badDate', '実施日（今日まで）を入れてください');
  // 全体の数は教室管理者だけ
  const manager = isManager(me);
  const t = manager ? { totalScore: num(b.totalScore ?? old?.totalScore, { max: 100000 }), totalMax: num(b.totalMax ?? old?.totalMax, { max: 100000 }), totalRank: num(b.totalRank ?? old?.totalRank, { int: true, min: 1 }), totalRankOf: num(b.totalRankOf ?? old?.totalRankOf, { int: true, min: 1 }), totalDeviation: num(b.totalDeviation ?? old?.totalDeviation, { max: 150 }) }
    : old ? { totalScore: old.totalScore, totalMax: old.totalMax, totalRank: old.totalRank, totalRankOf: old.totalRankOf, totalDeviation: old.totalDeviation } : { totalScore: null, totalMax: null, totalRank: null, totalRankOf: null, totalDeviation: null };
  const eventId = old ? old.eventId : String(b.eventId || '');
  if (eventId && !(await c.db.prepare("select 1 from sharedEvents where id = ? and studentId = ?").bind(eventId, s.id).first())) fail('badEvent', 'テストの予定が見つかりません');
  const now = iso(c.now), id = old ? old.id : newId('ex');
  if (old) await c.db.prepare('update exams set kind = ?, name = ?, date = ?, grade = ?, totalScore = ?, totalMax = ?, totalRank = ?, totalRankOf = ?, totalDeviation = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?')
    .bind(kind, name, date, grade, t.totalScore, t.totalMax, t.totalRank, t.totalRankOf, t.totalDeviation, now, id, old.version).run();
  else await c.db.prepare("insert into exams (id, studentId, kind, name, date, grade, eventId, totalScore, totalMax, totalRank, totalRankOf, totalDeviation, createdBy, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, s.id, kind, name, date, grade, eventId, t.totalScore, t.totalMax, t.totalRank, t.totalRankOf, t.totalDeviation, 'staff:' + me.id, now, now).run();
  await audit(c, old ? 'examUpdate' : 'examCreate', id, { kind, date });
  return { examId: id };
}

export const gradesRoutes = {
  // ---- スタッフ ----
  // 一覧: 見られる生徒と最新の試験、結果の入力待ちのテスト、取り込み待ちの成績票（教室管理者）
  'grades/overview': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = isManager(me);
    const scope = manager ? null : await teacherScope(c, me.id);
    let students = (await c.db.prepare("select * from students where status <> 'left' order by familyKana, familyName, givenName").all()).results;
    if (scope) students = students.filter(s => scope[s.id]);
    const ids = students.map(s => s.id);
    const latest = {};
    if (ids.length) for (const e of (await c.db.prepare(`select studentId, max(date) d, count(*) n from exams where status = 'recorded' and studentId in (${ids.map(() => '?').join(', ')}) group by studentId`).bind(...ids).all()).results) latest[e.studentId] = { date: e.d, count: e.n };
    const files = manager ? (await c.db.prepare("select f.*, s.familyName, s.givenName from examFiles f join students s on s.id = f.studentId where f.status = 'new' order by f.createdAt").all()).results.map(f => ({ ...fileView(f), studentName: fullName(f) })) : [];
    return { students: students.map(s => ({ id: s.id, name: fullName(s), grade: s.grade, latest: latest[s.id] || null, subjects: scope ? scope[s.id] : null })), pendingTests: await pendingTests(c, ids), files };
  },
  'grades/student': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = isManager(me);
    const s = await c.db.prepare('select * from students where id = ?').bind(String(b.studentId || '')).first(); if (!s) fail('notFound', '生徒が見つかりません', 404);
    const subjects = await staffScope(c, me, s.id);
    const exams = await examsOf(c, s.id, manager ? 'manager' : 'teacher', subjects);
    const files = manager ? (await c.db.prepare("select * from examFiles where studentId = ? and status <> 'uploading' order by createdAt desc").bind(s.id).all()).results.map(fileView) : [];
    const lessonSubjects = (await c.db.prepare('select distinct subject from lessons where studentId = ? order by subject').bind(s.id).all()).results.map(r => r.subject);
    return { student: { id: s.id, name: fullName(s), grade: s.grade }, manager, subjects, lessonSubjects, exams, files, pendingTests: await pendingTests(c, [s.id]), nextTest: await nextTest(c, s.id) };
  },
  'grades/exams/save': async (c, b) => { const me = await requireStaff(c, b, 'manager', 'teacher'); return saveExam(c, me, b); },
  'grades/exams/delete': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const e = await c.db.prepare('select * from exams where id = ?').bind(String(b.id || '')).first(); if (!e) fail('notFound', '試験が見つかりません', 404); sameVersion(e, b);
    await c.db.batch([c.db.prepare('delete from examScores where examId = ?').bind(e.id), c.db.prepare('delete from examReviews where examId = ?').bind(e.id),
      c.db.prepare("update examFiles set examId = '', status = case when status = 'imported' then 'new' else status end where examId = ?").bind(e.id), c.db.prepare('delete from exams where id = ?').bind(e.id)]);
    await audit(c, 'examDelete', e.id, { name: e.name, date: e.date });
    return {};
  },
  // 科目ごとの点数。scores: [{ subject, score, max, average, rank, rankOf, deviation, remove }]。講師は担当科目だけ
  'grades/scores/save': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const e = await c.db.prepare('select * from exams where id = ?').bind(String(b.examId || '')).first(); if (!e || e.status !== 'recorded') fail('notFound', '試験が見つかりません', 404);
    const subjects = await staffScope(c, me, e.studentId);
    if (!Array.isArray(b.scores) || b.scores.length > 15) fail('badScores', '科目は15までにしてください');
    const rows = b.scores.map(s => ({ ...scoreFields(s), remove: s.remove === true }));
    if (new Set(rows.map(r => r.subject)).size !== rows.length) fail('badScores', '同じ科目が2つあります');
    if (subjects && rows.some(r => !subjects.includes(r.subject))) fail('forbidden', `担当の科目（${subjects.join('・')}）だけ入力できます`, 403);
    const now = iso(c.now), stmts = [];
    rows.forEach((r, i) => {
      if (r.remove) { stmts.push(c.db.prepare('delete from examScores where examId = ? and subject = ?').bind(e.id, r.subject)); return; }
      stmts.push(c.db.prepare('insert into examScores (id, examId, subject, score, max, average, rank, rankOf, deviation, enteredBy, sortOrder, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(examId, subject) do update set score = excluded.score, max = excluded.max, average = excluded.average, rank = excluded.rank, rankOf = excluded.rankOf, deviation = excluded.deviation, enteredBy = excluded.enteredBy, updatedAt = excluded.updatedAt')
        .bind(newId('xs'), e.id, r.subject, r.score, r.max, r.average, r.rank, r.rankOf, r.deviation, 'staff:' + me.id, i, now));
    });
    stmts.push(c.db.prepare('update exams set updatedAt = ?, version = version + 1 where id = ?').bind(now, e.id));
    await c.db.batch(stmts);
    await audit(c, 'examScores', e.id, { subjects: rows.map(r => r.subject) });
    return {};
  },
  // 振り返り（講師も書ける）
  'grades/reviews/save': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const e = await c.db.prepare('select * from exams where id = ?').bind(String(b.examId || '')).first(); if (!e || e.status !== 'recorded') fail('notFound', '試験が見つかりません', 404);
    await staffScope(c, me, e.studentId);
    const old = await c.db.prepare('select * from examReviews where examId = ?').bind(e.id).first();
    if (old) sameVersion(old, b);
    const good = String(b.good ?? old?.good ?? '').trim(), issues = String(b.issues ?? old?.issues ?? '').trim(), nextSteps = String(b.nextSteps ?? old?.nextSteps ?? '').trim();
    if ([good, issues, nextSteps].some(v => v.length > 1000)) fail('tooLong', '1000文字以内で書いてください');
    const now = iso(c.now);
    // 講師は「良かった点」を見ないので、送られてこなければ前のまま
    if (old) await c.db.prepare('update examReviews set good = ?, issues = ?, nextSteps = ?, updatedBy = ?, updatedAt = ?, version = version + 1 where examId = ? and version = ?').bind(isManager(me) ? good : old.good, issues, nextSteps, 'staff:' + me.id, now, e.id, old.version).run();
    else await c.db.prepare('insert into examReviews (examId, good, issues, nextSteps, updatedBy, updatedAt) values (?, ?, ?, ?, ?, ?)').bind(e.id, isManager(me) ? good : '', issues, nextSteps, 'staff:' + me.id, now).run();
    await audit(c, 'examReview', e.id);
    return {};
  },
  // 共有されたテストに「結果なし」（受けなかった・記録しない）
  'grades/tests/skip': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const ev = await c.db.prepare("select * from sharedEvents where id = ? and kind = 'test'").bind(String(b.eventId || '')).first(); if (!ev) fail('notFound', 'テストの予定が見つかりません', 404);
    await staffScope(c, me, ev.studentId);
    if (!(await c.db.prepare('select 1 from exams where eventId = ?').bind(ev.id).first()))
      await c.db.prepare("insert into exams (id, studentId, kind, name, date, status, eventId, createdBy, createdAt, updatedAt) values (?, ?, 'regular', ?, ?, 'skipped', ?, ?, ?, ?)").bind(newId('ex'), ev.studentId, ev.title || 'テスト', ev.dateTo, ev.id, 'staff:' + me.id, iso(c.now), iso(c.now)).run();
    await audit(c, 'examSkip', ev.id);
    return {};
  },
  // 成績票（教室管理者）: 読む・送る・取り込んだ／取り込まない
  'grades/files/read': async (c, b) => { await requireStaff(c, b, 'manager'); return readChunk(c, await getFile(c, b.id), b); },
  'grades/files/upload': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    if (!(await c.db.prepare('select 1 from students where id = ?').bind(String(b.studentId || '')).first())) fail('notFound', '生徒が見つかりません', 404);
    return uploadChunk(c, String(b.studentId), { kind: 'staff', id: me.id }, b);
  },
  'grades/files/resolve': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const f = await getFile(c, b.id), status = String(b.status || '');
    if (!['imported', 'dismissed', 'new'].includes(status)) fail('badStatus', '取り込んだ・取り込まないを選んでください');
    const examId = String(b.examId || '');
    if (examId && !(await c.db.prepare('select 1 from exams where id = ? and studentId = ?').bind(examId, f.studentId).first())) fail('notFound', '試験が見つかりません', 404);
    await c.db.prepare('update examFiles set status = ?, examId = ?, resolvedBy = ?, resolvedAt = ?, updatedAt = ? where id = ?').bind(status, examId || f.examId, 'staff:' + me.id, iso(c.now), iso(c.now), f.id).run();
    await audit(c, 'examFileResolve', f.id, { status, examId });
    return {};
  },

  // ---- 保護者 ----
  'family/grades': async (c, b) => {
    const me = await requireFamily(c, b);
    const kids = (await c.db.prepare("select * from students where familyId = ? and status <> 'left' order by createdAt").bind(me.id).all()).results, out = [];
    for (const s of kids) {
      const exams = await examsOf(c, s.id, 'family');
      const files = (await c.db.prepare("select * from examFiles where studentId = ? and status <> 'uploading' order by createdAt desc").bind(s.id).all()).results.map(fileView);
      out.push({ id: s.id, name: fullName(s), exams, lessons: await lessonsBetween(c, s.id, exams), files, nextTest: await nextTest(c, s.id) });
    }
    return { students: out };
  },
  'family/grades/upload': async (c, b) => {
    const me = await requireFamily(c, b);
    const s = await c.db.prepare('select * from students where id = ?').bind(String(b.studentId || '')).first();
    if (!s || s.familyId !== me.id) fail('notFound', '生徒が見つかりません', 404);
    return uploadChunk(c, s.id, { kind: 'family', id: me.id }, b);
  },
  'family/grades/file': async (c, b) => {
    const me = await requireFamily(c, b);
    const f = await getFile(c, b.id), s = await c.db.prepare('select familyId from students where id = ?').bind(f.studentId).first();
    if (!s || s.familyId !== me.id) fail('notFound', '成績票が見つかりません', 404);
    return readChunk(c, f, b);
  },

  // ---- 生徒（専用リンク） ----
  'student/grades': async (c, b) => {
    const s = await studentByLink(c, b);
    const exams = await examsOf(c, s.id, 'student');
    const files = (await c.db.prepare("select * from examFiles where studentId = ? and uploadedByKind = 'student' and status <> 'uploading' order by createdAt desc limit 20").bind(s.id).all()).results.map(fileView);
    return { me: { id: s.id, name: fullName(s) }, exams, files, nextTest: await nextTest(c, s.id) };
  },
  'student/grades/upload': async (c, b) => { const s = await studentByLink(c, b); return uploadChunk(c, s.id, { kind: 'student', id: s.id }, b); },
  'student/grades/file': async (c, b) => {
    const s = await studentByLink(c, b), f = await getFile(c, b.id);
    if (f.studentId !== s.id || f.uploadedByKind !== 'student') fail('notFound', '成績票が見つかりません', 404);
    return readChunk(c, f, b);
  },
};

// 毎日0時10分（切り替えたあと）: 前日に終わったテストについて、担当の講師と教室管理者に結果の入力を頼む
export async function remindTestResults(c) {
  if (!(await isLive(c))) return { skipped: 'notLive' };
  const yesterday = addDays(todayJst(c.now), -1);
  const events = (await c.db.prepare("select e.*, s.familyName, s.givenName from sharedEvents e join students s on s.id = e.studentId where e.kind = 'test' and e.dateTo = ?").bind(yesterday).all()).results;
  if (!events.length) return { tests: 0 };
  const lines = events.map(e => `・${fullName(e)}さん ${e.title || 'テスト'}（${e.date.slice(5).replace('-', '/')}${e.dateTo !== e.date ? '〜' + e.dateTo.slice(5).replace('-', '/') : ''}）`);
  // 教室管理者へ1通。担当の講師には、その講師の生徒の分だけ
  await staffNotice(c, 'テストが終わりました（結果の入力のお願い）', lines.join('\n') + '\n成績票や点数が分かったら「成績」に入れてください。');
  const teachers = (await c.db.prepare("select id, email, roles from staff where status = 'active'").all()).results.filter(t => !rolesOf(t).includes('manager') && rolesOf(t).includes('teacher'));
  for (const t of teachers) {
    const scope = await teacherScope(c, t.id), mine = events.filter(e => scope[e.studentId]);
    if (mine.length) c.effects.push({ kind: 'mail', to: t.email, name: 'ステップワイズ', subject: '[ステップワイズ] テストが終わりました（結果の入力のお願い）', body: mine.map(e => lines[events.indexOf(e)]).join('\n') + '\n担当の科目の点数が分かったら「成績」に入れてください。\n\nhttps://www.stepwise-education.jp/staff/#grades', audience: 'staff' });
  }
  return { tests: events.length };
}
