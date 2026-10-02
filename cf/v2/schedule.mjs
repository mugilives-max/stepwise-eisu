// 予定（3段目）。授業は行を消さずに状態で表す（migrations-v2/0003_schedule.sql）。
// - 教室管理者: 仮予定を送る・予定表にまとめて送る・直接決定・日時の変更・お休み・キャンセル・実施済み・削除（入力ミス）
// - 講師: 自分の担当の授業を見る・実施済みにする・自分の休みを登録する
// - 保護者・生徒: 予定を見る、「変更・お休みの連絡」、予定の共有（テスト・行事・授業ができない日）
// - 毎日0時10分: 締め切りを過ぎた仮予定を決定する（autoConfirm）
// カレンダー・Meet と保護者へのメールは、切り替え（settings.live）まで実際には行わない（effects に held で残る）。
import { fail, newId, iso, audit, sha256Hex } from './util.mjs';
import { requireStaff, rolesOf } from './staff.mjs';
import { requireFamily } from './family.mjs';
import { isLive } from './accounts.mjs';

const CAL_PREFIX = '【塾】';
const ACTIVE = ['held', 'proposed', 'decided', 'done'];
const DAY = 86400e3;

// ---- 日本時間の日付と時刻 ----
export const todayJst = now => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const nextMonthStart = d => { const [y, m] = d.split('-').map(Number); return (m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0')) + '-01'; };
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const startMs = (date, start) => Date.parse(date + 'T' + start + ':00+09:00');
export const freeDeadline = date => Date.parse(date + 'T23:00:00+09:00') - DAY; // 前日23時
const overlap = (a, b) => a.date === b.date && toMin(a.start) < toMin(b.start) + Number(b.minutes) && toMin(b.start) < toMin(a.start) + Number(a.minutes);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T00:00:00Z'));
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));

// 締め切り: 送った日の3日後。翌月以降の授業だけなら今月25日と遅い方。授業の2日前を超えない（それより近い授業は締め切りなし）
export function confirmByFor(dates, today, requested) {
  let base;
  if (requested) { if (!validDate(requested) || requested < today) fail('badConfirmBy', '締め切りは今日以降の日付にしてください'); base = requested; }
  else {
    base = addDays(today, 3);
    if (dates.every(d => d >= nextMonthStart(today))) { const d25 = today.slice(0, 8) + '25'; if (d25 > base) base = d25; }
  }
  return dates.map(d => { const limit = addDays(d, -2), v = base < limit ? base : limit; return v >= today ? v : ''; });
}

// ---- 見せ方 ----
const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
function lessonView(l, extra = {}) {
  return { id: l.id, studentId: l.studentId, staffId: l.staffId, date: l.date, start: l.start, minutes: l.minutes, subject: l.subject, kind: l.kind, deliveryMode: l.deliveryMode,
    status: l.status, confirmBy: l.confirmBy, meetUrl: l.meetUrl, lateStart: !!l.lateStart, version: l.version, ...extra };
}
const requestView = r => ({ id: r.id, lessonId: r.lessonId, kind: r.kind, note: r.note, fromKind: r.fromKind, receivedAt: r.receivedAt, status: r.status });
const eventView = e => ({ id: e.id, studentId: e.studentId, kind: e.kind, date: e.date, dateTo: e.dateTo, start: e.start, end: e.end, title: e.title, createdByKind: e.createdByKind, version: e.version });

// ---- カレンダー（切り替え前は held） ----
async function calendarEffect(c, kind, lesson, studentName) {
  const live = await isLive(c);
  if (kind === 'delete') {
    if (lesson.calendarEventId && !lesson.calendarEventId.startsWith('swv2')) c.effects.push({ kind: 'calendarDelete', eventId: lesson.calendarEventId, audience: 'calendar', held: !live });
    return '';
  }
  const marker = lesson.calendarEventId && !lesson.calendarEventId.startsWith('swv2') ? lesson.calendarEventId : 'swv2' + sha256Hex(lesson.id + ':' + c.now).slice(0, 40);
  const end = new Date(startMs(lesson.date, lesson.start) + lesson.minutes * 60000).toISOString();
  const body = { summary: CAL_PREFIX + studentName + 'さん ' + (lesson.subject || '授業') + ' (' + (lesson.deliveryMode === 'online' ? 'オンライン' : '対面') + ')',
    start: { dateTime: new Date(startMs(lesson.date, lesson.start)).toISOString(), timeZone: 'Asia/Tokyo' }, end: { dateTime: end, timeZone: 'Asia/Tokyo' },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] }, extendedProperties: { private: { stepwiseLesson: lesson.id } } };
  const wantMeet = lesson.deliveryMode === 'online';
  if (kind === 'create' || marker.startsWith('swv2')) {
    body.id = marker;
    if (wantMeet) body.conferenceData = { createRequest: { requestId: marker, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    c.effects.push({ kind: 'calendarCreate', marker, body, wantMeet, audience: 'calendar', held: !live });
  } else c.effects.push({ kind: 'calendarPatch', marker, body, wantMeet, audience: 'calendar', held: !live });
  return marker;
}
// 保護者あての短いお知らせ（中身は保護者ページで見る）。切り替え前は held
async function familyNotice(c, studentId, subject, text) {
  const s = await c.db.prepare('select f.email, f.testOnly, f.status from students s join families f on f.id = s.familyId where s.id = ?').bind(studentId).first();
  if (!s || !s.email || s.status !== 'active') return;
  c.effects.push({ kind: 'mail', to: s.email, name: 'ステップワイズ英数教室', subject: '【ステップワイズ】' + subject, body: text + '\n保護者ページでご確認ください。\n\nhttps://www.stepwise-education.jp/family/', testOnly: !!s.testOnly, audience: 'family', held: !(await isLive(c)) });
}
// スタッフ（教室管理者）あてのお知らせ
async function staffNotice(c, subject, text) {
  const rows = (await c.db.prepare("select email, roles from staff where status = 'active'").all()).results.filter(r => rolesOf(r).includes('manager'));
  for (const r of rows) c.effects.push({ kind: 'mail', to: r.email, name: 'ステップワイズ', subject: '[ステップワイズ] ' + subject, body: text + '\n\nhttps://www.stepwise-education.jp/staff/', audience: 'staff' });
}

// ---- 読み書きの共通 ----
async function getLesson(c, id) { const l = await c.db.prepare('select * from lessons where id = ?').bind(String(id || '')).first(); if (!l) fail('notFound', '授業が見つかりません', 404); return l; }
const sameVersion = (row, b) => { if (Number(b.version) !== Number(row.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409); };
async function studentRow(c, id) { const s = await c.db.prepare('select * from students where id = ?').bind(String(id || '')).first(); if (!s) fail('notFound', '生徒が見つかりません', 404); return s; }
async function setLesson(c, l, patch) {
  const cols = Object.keys(patch);
  await c.db.prepare(`update lessons set ${cols.map(k => k + ' = ?').join(', ')}, updatedAt = ?, version = version + 1 where id = ? and version = ?`)
    .bind(...cols.map(k => patch[k]), iso(c.now), l.id, l.version).run();
  return { ...l, ...patch, version: l.version + 1 };
}
async function closeRequests(c, lessonId, kinds, by) {
  await c.db.prepare(`update lessonRequests set status = 'done', resolvedAt = ?, resolvedBy = ?, updatedAt = ?, version = version + 1 where lessonId = ? and status = 'open' and kind in (${kinds.map(() => '?').join(', ')})`)
    .bind(iso(c.now), by, iso(c.now), lessonId, ...kinds).run();
}

// 授業の中身の確かめ（作る・直す共通）
function lessonFields(b, base = {}) {
  const out = { ...base };
  for (const k of ['date', 'start', 'minutes', 'subject', 'kind', 'deliveryMode', 'staffId']) if (b[k] !== undefined) out[k] = b[k];
  out.minutes = Number(out.minutes);
  if (!validDate(out.date) || !validTime(out.start)) fail('badTime', '日付と開始時刻を確かめてください');
  if (!Number.isInteger(out.minutes) || out.minutes < 15 || out.minutes > 300) fail('badMinutes', '授業の長さは15〜300分にしてください');
  if (toMin(out.start) + out.minutes > 24 * 60) fail('badTime', '日をまたぐ授業は登録できません');
  out.subject = String(out.subject || '').trim(); if (!out.subject || out.subject.length > 30) fail('badSubject', '科目を入れてください');
  out.kind = String(out.kind || '通常').trim().slice(0, 20) || '通常';
  if (!['in_person', 'online'].includes(out.deliveryMode)) fail('badMode', '授業の形式（対面・オンライン）を選んでください');
  out.staffId = String(out.staffId || '');
  return out;
}
// 重なりの確かめ。同じ生徒・同じ講師の授業が重なれば断る。休み・授業ができない日は、force がなければ確かめを求める
async function checkConflicts(c, candidates, { force, exceptId = '' } = {}) {
  const dates = [...new Set(candidates.map(x => x.date))];
  const q = `(${dates.map(() => '?').join(', ')})`;
  const lessons = (await c.db.prepare(`select * from lessons where date in ${q} and status in ('held', 'proposed', 'decided', 'done') and id <> ?`).bind(...dates, exceptId).all()).results;
  const offs = (await c.db.prepare(`select * from staffUnavailability where date in ${q}`).bind(...dates).all()).results;
  const events = (await c.db.prepare(`select * from sharedEvents where kind = 'unavailable' and date <= ? and dateTo >= ?`).bind(dates.slice().sort().at(-1), dates.slice().sort()[0]).all()).results;
  const errors = [], warnings = [];
  candidates.forEach((x, i) => {
    const others = lessons.concat(candidates.filter((_, j) => j !== i));
    if (others.some(o => o.studentId === x.studentId && overlap(o, x))) errors.push(`${x.date} ${x.start} は同じ生徒の授業と重なっています`);
    if (x.staffId && others.some(o => o.staffId === x.staffId && overlap(o, x))) errors.push(`${x.date} ${x.start} は同じ講師の授業と重なっています`);
    const span = o => o.start ? { date: o.date, start: o.start, minutes: toMin(o.end) - toMin(o.start) } : { date: o.date, start: '00:00', minutes: 1440 };
    if (offs.some(o => (!o.staffId || o.staffId === x.staffId) && overlap(span(o), x))) warnings.push(`${x.date} ${x.start} は講師の休みに入っています`);
    if (events.some(e => e.studentId === x.studentId && e.date <= x.date && x.date <= e.dateTo && (!e.start || overlap({ date: x.date, start: e.start, minutes: toMin(e.end) - toMin(e.start) }, x)))) warnings.push(`${x.date} ${x.start} は生徒が「授業ができない」と共有した日です`);
  });
  if (errors.length) fail('overlap', [...new Set(errors)].join('。'), 409);
  if (warnings.length && !force) fail('needForce', [...new Set(warnings)].join('。') + '。それでも登録しますか？', 409, { needForce: true });
}

// 講師が見てよい生徒（担当中か、前後90日に担当した生徒）
async function teacherStudentIds(c, staffId) {
  const today = todayJst(c.now);
  return (await c.db.prepare('select distinct studentId from lessons where staffId = ? and date between ? and ?').bind(staffId, addDays(today, -90), addDays(today, 90)).all()).results.map(r => r.studentId);
}

// ---- 毎日0時10分（Worker の定期実行）: 締め切りを過ぎた仮予定を決定する ----
export async function autoConfirm(c) {
  const today = todayJst(c.now);
  const due = (await c.db.prepare(`select l.*, s.familyName, s.givenName from lessons l join students s on s.id = l.studentId
    where l.status = 'proposed' and l.confirmBy <> '' and l.confirmBy < ? and l.date >= ?
    and not exists (select 1 from lessonRequests r where r.lessonId = l.id and r.status = 'open' and r.kind = 'move') order by l.date, l.start`).bind(today, today).all()).results;
  const byStudent = {};
  for (const l of due) {
    const marker = await calendarEffect(c, 'create', l, fullName(l));
    await c.db.prepare("update lessons set status = 'decided', decidedAt = ?, decidedBy = 'system:auto', calendarEventId = ?, updatedAt = ?, version = version + 1 where id = ? and status = 'proposed'").bind(iso(c.now), marker, iso(c.now), l.id).run();
    (byStudent[l.studentId] = byStudent[l.studentId] || []).push(l);
  }
  for (const [sid, list] of Object.entries(byStudent)) {
    const months = [...new Set(list.map(l => Number(l.date.slice(5, 7)) + '月'))].join('・');
    await familyNotice(c, sid, months + 'の授業予定日が決定しました', months + 'の授業予定日が決定しました。変更する場合は前日の23時までにお申し付けください。');
  }
  if (due.length) { c.actor = { kind: 'system', id: 'autoConfirm' }; await audit(c, 'autoConfirm', '', { lessons: due.length }); }
  return { confirmed: due.length, students: Object.keys(byStudent).length };
}

// ---- 生徒・保護者からの「変更・お休みの連絡」 ----
// いつ押したかで選べるものが決まる。rest と cancel は受け付けた時点で授業の状態を変える
export function choicesFor(l, now) {
  if (l.status === 'proposed') return ['move', 'rest'];
  if (l.status !== 'decided') return [];
  if (now <= freeDeadline(l.date)) return ['move', 'rest'];
  return now < startMs(l.date, l.start) ? ['late', 'cancel'] : [];
}
async function lessonRequest(c, studentIds, who, b) {
  const l = await getLesson(c, b.lessonId);
  if (!studentIds.includes(l.studentId) || l.status === 'held') fail('notFound', '授業が見つかりません', 404);
  const kind = String(b.kind || ''), note = String(b.note || '').trim();
  if (!choicesFor(l, c.now).includes(kind)) fail('notNow', kind === 'move' || kind === 'rest' ? '前日23時を過ぎたため、日時の変更・お休みは連絡できません。画面を更新してください' : 'この授業には今この連絡はできません。画面を更新してください', 409);
  if (note.length > 500) fail('tooLong', '500文字以内で書いてください');
  if (kind !== 'rest' || l.status !== 'proposed') if (!note) fail('needNote', kind === 'move' ? '希望の日時などを書いてください' : kind === 'late' ? '何分ほど遅らせたいかを書いてください' : '理由を書いてください');
  if ((await c.db.prepare("select 1 from lessonRequests where lessonId = ? and status = 'open' and kind = ?").bind(l.id, kind).first())) return { lesson: lessonView(l), replayed: true };
  const id = newId('rq'), s = await studentRow(c, l.studentId), name = fullName(s);
  const stmts = [c.db.prepare('insert into lessonRequests (id, lessonId, studentId, kind, note, fromKind, fromId, receivedAt, status, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, l.id, l.studentId, kind, note, who.kind, who.id, iso(c.now), kind === 'rest' ? 'done' : 'open', iso(c.now), iso(c.now))];
  let next = l;
  if (kind === 'rest' || kind === 'cancel') {
    next = { ...l, status: kind === 'rest' ? 'rested' : 'cancelled', version: l.version + 1 };
    stmts.push(c.db.prepare('update lessons set status = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?').bind(next.status, iso(c.now), l.id, l.version));
    if (l.status === 'decided') await calendarEffect(c, 'delete', l, name);
  }
  await c.db.batch(stmts);
  const when = `${l.date.slice(5).replace('-', '/')} ${l.start}〜（${l.subject}）`, from = who.kind === 'family' ? name + 'さんの保護者' : name + 'さん';
  const title = { move: '日時の変更のお願い', rest: 'お休みの連絡', late: '開始を遅らせたい', cancel: 'キャンセル' }[kind];
  await staffNotice(c, `【${title}】${name}さん`, `${from}から${title}が届きました。\n${when}${l.status === 'proposed' ? '（仮予定）' : ''}\n${note ? '内容: ' + note : ''}${kind === 'cancel' ? '\n前日23時を過ぎた連絡です（キャンセル料の対象）。' : ''}`);
  await audit(c, 'lessonRequest:' + kind, l.id, { request: id });
  return { lesson: lessonView(next), request: { id, kind, status: kind === 'rest' ? 'done' : 'open' } };
}
// 取り下げ: 開始前なら、日時の変更・開始を遅らせたいのお願いを取り下げられる。お休み・キャンセルは授業を決定に戻す
async function withdrawRequest(c, studentIds, b) {
  const r = await c.db.prepare('select * from lessonRequests where id = ?').bind(String(b.requestId || '')).first();
  if (!r || !studentIds.includes(r.studentId)) fail('notFound', '連絡が見つかりません', 404);
  const l = await getLesson(c, r.lessonId);
  if (c.now >= startMs(l.date, l.start)) fail('started', '授業が始まっているため、取り下げられません', 409);
  if (r.status === 'withdrawn') return { lesson: lessonView(l) };
  let next = l;
  if (['rest', 'cancel'].includes(r.kind) && l.status === (r.kind === 'rest' ? 'rested' : 'cancelled')) {
    const back = (await c.db.prepare("select decidedAt from lessons where id = ?").bind(l.id).first()).decidedAt ? 'decided' : 'proposed';
    next = await setLesson(c, l, { status: back });
    if (back === 'decided') next = await setLesson(c, next, { calendarEventId: await calendarEffect(c, 'create', next, fullName(await studentRow(c, l.studentId))) });
  } else if (r.status !== 'open') fail('closed', 'この連絡はもう対応が済んでいます', 409);
  await c.db.prepare("update lessonRequests set status = 'withdrawn', updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), r.id).run();
  await audit(c, 'lessonRequestWithdraw', l.id, { request: r.id });
  return { lesson: lessonView(next) };
}

// 生徒・保護者が見る予定（未送信の仮予定は見せない。講師名・メモは出さない）
async function familyScheduleOf(c, studentIds, from, to) {
  if (!studentIds.length) return { lessons: [], events: [], requests: [] };
  const q = `(${studentIds.map(() => '?').join(', ')})`;
  const lessons = (await c.db.prepare(`select * from lessons where studentId in ${q} and date between ? and ? and status <> 'held' order by date, start`).bind(...studentIds, from, to).all()).results;
  const events = (await c.db.prepare(`select * from sharedEvents where studentId in ${q} and dateTo >= ? and date <= ? order by date`).bind(...studentIds, from, to).all()).results;
  const ids = lessons.map(l => l.id);
  const requests = ids.length ? (await c.db.prepare(`select * from lessonRequests where lessonId in (${ids.map(() => '?').join(', ')}) and status <> 'withdrawn' order by receivedAt`).bind(...ids).all()).results : [];
  return {
    lessons: lessons.map(l => { const v = lessonView(l, { choices: choicesFor(l, c.now), requests: requests.filter(r => r.lessonId === l.id).map(requestView) }); delete v.staffId; return v; }),
    events: events.map(eventView),
  };
}
function range(b, today) {
  const from = validDate(b.from) ? b.from : addDays(today, -7), to = validDate(b.to) ? b.to : addDays(today, 62);
  if (to < from || Date.parse(to) - Date.parse(from) > 400 * DAY) fail('badRange', '期間を確かめてください');
  return { from, to };
}
async function studentByLink(c, b) {
  const code = String(b.k || '');
  const s = code && code.length <= 100 ? await c.db.prepare("select * from students where linkCode = ? and status <> 'left'").bind(code).first() : null;
  if (!s) fail('badLink', '専用リンクが正しくありません。先生から届いたリンクを開き直してください', 401);
  c.actor = { kind: 'student', id: s.id };
  return s;
}
const studentMay = (s, key) => { try { return JSON.parse(s.permissions || '{}')[key] !== false; } catch { return true; } };
const EVENT_KINDS = ['test', 'event', 'unavailable'];
async function addEvent(c, studentId, by, b) {
  const kind = String(b.kind || ''), date = String(b.date || ''), dateTo = String(b.dateTo || b.date || ''), title = String(b.title || '').trim();
  if (!EVENT_KINDS.includes(kind)) fail('badKind', '種類を選んでください（テスト・行事・授業ができない日）');
  if (!validDate(date) || !validDate(dateTo) || dateTo < date || Date.parse(dateTo) - Date.parse(date) > 62 * DAY) fail('badDate', '日付を確かめてください');
  const start = b.start ? String(b.start) : '', end = b.end ? String(b.end) : '';
  if ((start || end) && (!validTime(start) || !validTime(end) || end <= start)) fail('badTime', '時間帯を確かめてください（開始 < 終了）');
  if (title.length > 60 || (kind !== 'unavailable' && !title)) fail('needTitle', '内容を60文字以内で入れてください（例: 2学期中間テスト）');
  const id = newId('ev');
  await c.db.prepare('insert into sharedEvents (id, studentId, kind, date, dateTo, start, end, title, createdByKind, createdById, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, studentId, kind, date, dateTo, start, end, title, by.kind, by.id, iso(c.now), iso(c.now)).run();
  await audit(c, 'eventAdd', id, { kind });
  return { event: eventView(await c.db.prepare('select * from sharedEvents where id = ?').bind(id).first()) };
}
async function deleteEvent(c, studentIds, by, b) {
  const e = await c.db.prepare('select * from sharedEvents where id = ?').bind(String(b.id || '')).first();
  if (!e || (studentIds && !studentIds.includes(e.studentId))) fail('notFound', '予定が見つかりません', 404);
  await c.db.prepare('delete from sharedEvents where id = ?').bind(e.id).run();
  await audit(c, 'eventDelete', e.id);
  return {};
}

export const scheduleRoutes = {
  // ---- スタッフ ----
  'schedule/staff/range': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = rolesOf(me).includes('manager');
    const { from, to } = range(b, todayJst(c.now));
    let lessons = (await c.db.prepare('select * from lessons where date between ? and ? order by date, start').bind(from, to).all()).results;
    let allowed = null;
    if (!manager) { allowed = await teacherStudentIds(c, me.id); lessons = lessons.filter(l => l.staffId === me.id); }
    if (b.studentId) lessons = lessons.filter(l => l.studentId === b.studentId);
    const students = (await c.db.prepare('select * from students').all()).results.filter(s => !allowed || allowed.includes(s.id));
    const staff = (await c.db.prepare("select id, name, roles, status from staff where status = 'active'").all()).results;
    const ids = lessons.map(l => l.id);
    const requests = ids.length ? (await c.db.prepare(`select * from lessonRequests where lessonId in (${ids.map(() => '?').join(', ')}) and status <> 'withdrawn'`).bind(...ids).all()).results : [];
    const openRequests = manager ? (await c.db.prepare("select r.*, l.date, l.start, l.subject, l.status lessonStatus from lessonRequests r join lessons l on l.id = r.lessonId where r.status = 'open' order by r.receivedAt").all()).results : [];
    const nameOf = Object.fromEntries(students.map(s => [s.id, fullName(s)]));
    const events = (await c.db.prepare('select * from sharedEvents where dateTo >= ? and date <= ? order by date').bind(from, to).all()).results.filter(e => !allowed || allowed.includes(e.studentId));
    const offs = (await c.db.prepare('select * from staffUnavailability where date between ? and ? order by date, start').bind(from, to).all()).results.filter(o => manager || !o.staffId || o.staffId === me.id);
    const meetings = manager ? (await c.db.prepare("select * from meetings where date between ? and ? and status <> 'cancelled' order by date, start").bind(from, to).all()).results : [];
    const kinds = (await c.db.prepare('select name from lessonKinds where active = 1 order by sortOrder, name').all()).results.map(k => k.name);
    return {
      from, to, today: todayJst(c.now),
      lessons: lessons.map(l => lessonView(l, { studentName: nameOf[l.studentId] || '（不明）', note: l.note, requests: requests.filter(r => r.lessonId === l.id).map(requestView) })),
      openRequests: openRequests.map(r => ({ ...requestView(r), studentName: nameOf[r.studentId] || '', date: r.date, start: r.start, subject: r.subject, lessonStatus: r.lessonStatus })),
      events: events.map(e => ({ ...eventView(e), studentName: nameOf[e.studentId] || '' })),
      unavailability: offs.map(o => ({ id: o.id, staffId: o.staffId, date: o.date, start: o.start, end: o.end, note: o.note })),
      meetings: meetings.map(m => ({ id: m.id, familyId: m.familyId, studentId: m.studentId, staffId: m.staffId, date: m.date, start: m.start, minutes: m.minutes, deliveryMode: m.deliveryMode, title: m.title, meetUrl: m.meetUrl, status: m.status, version: m.version })),
      students: students.filter(s => s.status !== 'left').map(s => ({ id: s.id, name: fullName(s), familyId: s.familyId, deliveryMode: s.deliveryMode })),
      staff: staff.map(s => ({ id: s.id, name: s.name, teacher: rolesOf(s).includes('teacher') })),
      kinds: kinds.length ? kinds : ['通常'], live: await isLive(c),
    };
  },
  // 仮予定を作る。hold=true は予定表にまとめてあとで送る（生徒・保護者に見せない）
  'schedule/lessons/create': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await studentRow(c, b.studentId);
    if (s.status === 'left') fail('left', '退会した生徒には授業を登録できません');
    const repeat = Number(b.repeat || 1);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 12) fail('badRepeat', 'くり返しは1〜12回にしてください');
    const rows = [b, ...(Array.isArray(b.extra) ? b.extra.slice(0, 11) : [])].map(x => lessonFields({ ...x, date: b.date }));
    const today = todayJst(c.now);
    const candidates = [];
    for (let w = 0; w < repeat; w++) for (const x of rows) candidates.push({ ...x, studentId: s.id, date: addDays(b.date, w * 7) });
    if (candidates.some(x => x.date < today)) fail('past', '過去の日付には仮予定を作れません');
    await checkConflicts(c, candidates, { force: !!b.force });
    const hold = b.hold === true, bys = hold ? candidates.map(() => '') : confirmByFor(candidates.map(x => x.date), today, b.confirmBy || '');
    const stmts = candidates.map((x, i) => c.db.prepare('insert into lessons (id, studentId, staffId, date, start, minutes, subject, kind, deliveryMode, status, confirmBy, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(x.id = newId('ls'), s.id, x.staffId, x.date, x.start, x.minutes, x.subject, x.kind, x.deliveryMode, hold ? 'held' : 'proposed', bys[i], iso(c.now), iso(c.now)));
    await c.db.batch(stmts);
    if (!hold) await familyNotice(c, s.id, '授業の仮予定が届いています', `${fullName(s)}さんの授業の仮予定が届いています。${bys[0] ? Number(bys[0].slice(5, 7)) + '/' + Number(bys[0].slice(8)) + 'までに連絡がなければ、この日時で決定します。' : ''}`);
    await audit(c, hold ? 'lessonsHold' : 'lessonsPropose', s.id, { count: candidates.length });
    return { created: candidates.length, held: hold, confirmBy: bys[0] || '' };
  },
  // 予定表を送る（まとめておいた未送信の仮予定に締め切りを付けて、保護者に1回知らせる）
  'schedule/lessons/sendHeld': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await studentRow(c, b.studentId), today = todayJst(c.now);
    const held = (await c.db.prepare("select * from lessons where studentId = ? and status = 'held' and date >= ? order by date, start").bind(s.id, today).all()).results;
    if (!held.length) return { sent: 0 };
    const bys = confirmByFor(held.map(l => l.date), today, b.confirmBy || '');
    await c.db.batch(held.map((l, i) => c.db.prepare("update lessons set status = 'proposed', confirmBy = ?, updatedAt = ?, version = version + 1 where id = ? and status = 'held'").bind(bys[i], iso(c.now), l.id)));
    const months = [...new Set(held.map(l => Number(l.date.slice(5, 7)) + '月'))].join('・');
    await familyNotice(c, s.id, months + 'の授業予定表が届いています', `${fullName(s)}さんの${months}の授業予定表が届いています。締め切りまでに連絡がなければ、この日時で決定します。`);
    await audit(c, 'scheduleSend', s.id, { count: held.length });
    return { sent: held.length };
  },
  // 直接決定（連絡を受けて先生が決める・締め切りのない授業）
  'schedule/lessons/decide': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (!['held', 'proposed'].includes(l.status)) fail('badStatus', '仮予定だけ決定できます');
    const s = await studentRow(c, l.studentId);
    const next = await setLesson(c, l, { status: 'decided', decidedAt: iso(c.now), decidedBy: 'staff:' + c.actor.id, calendarEventId: '' });
    const done = await setLesson(c, next, { calendarEventId: await calendarEffect(c, 'create', next, fullName(s)) });
    await closeRequests(c, l.id, ['move'], 'staff:' + c.actor.id);
    await audit(c, 'lessonDecide', l.id);
    return { lesson: lessonView(done) };
  },
  // 日時・長さ・科目・形式・担当を直す。日時を直すと「日時の変更のお願い」は済みになる。前日23時を過ぎた開始時刻の変更は lateStart で記録（料金は変わらない）
  'schedule/lessons/update': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (!['held', 'proposed', 'decided'].includes(l.status)) fail('badStatus', 'この授業は直せません');
    const n = lessonFields(b, l);
    const moved = n.date !== l.date || n.start !== l.start || n.minutes !== l.minutes;
    if (moved) await checkConflicts(c, [{ ...n, studentId: l.studentId }], { force: !!b.force, exceptId: l.id });
    const patch = { date: n.date, start: n.start, minutes: n.minutes, subject: n.subject, kind: n.kind, deliveryMode: n.deliveryMode, staffId: n.staffId };
    if (b.note !== undefined) patch.note = String(b.note).slice(0, 1000);
    if (moved && l.status === 'decided' && c.now > freeDeadline(l.date) && b.lateStart === true) patch.lateStart = 1;
    let next = await setLesson(c, l, patch);
    if (l.status === 'decided' && (moved || n.subject !== l.subject || n.deliveryMode !== l.deliveryMode)) next = await setLesson(c, next, { calendarEventId: await calendarEffect(c, 'patch', next, fullName(await studentRow(c, l.studentId))) });
    if (moved) {
      await closeRequests(c, l.id, ['move', 'late'], 'staff:' + c.actor.id);
      if (l.status !== 'held') await familyNotice(c, l.studentId, '授業の日時を変更しました', `授業の日時を変更しました。\n変更前: ${l.date} ${l.start}（${l.minutes}分）\n変更後: ${n.date} ${n.start}（${n.minutes}分）`);
    }
    await audit(c, 'lessonUpdate', l.id, { moved, lateStart: !!patch.lateStart });
    return { lesson: lessonView(next) };
  },
  // 先生が記録するお休み・キャンセル（LINE などで連絡を受けたとき）。生徒・保護者からの連絡も、ここで済みにする
  'schedule/lessons/rest': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (!['proposed', 'decided'].includes(l.status)) fail('badStatus', '仮予定・決定した授業だけお休みにできます');
    const next = await setLesson(c, l, { status: 'rested' });
    if (l.status === 'decided') await calendarEffect(c, 'delete', l, '');
    await closeRequests(c, l.id, ['move', 'late', 'rest'], 'staff:' + c.actor.id);
    await audit(c, 'lessonRest', l.id);
    return { lesson: lessonView(next) };
  },
  'schedule/lessons/cancel': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (l.status !== 'decided') fail('badStatus', '決定した授業だけキャンセルにできます');
    const next = await setLesson(c, l, { status: 'cancelled' });
    await calendarEffect(c, 'delete', l, '');
    await closeRequests(c, l.id, ['move', 'late', 'cancel', 'rest'], 'staff:' + c.actor.id);
    await audit(c, 'lessonCancel', l.id);
    return { lesson: lessonView(next) };
  },
  // 実施済み（教室管理者か、担当の講師）
  'schedule/lessons/done': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (!rolesOf(me).includes('manager') && l.staffId !== me.id) fail('forbidden', '担当の授業だけ実施済みにできます', 403);
    if (l.status !== 'decided') fail('badStatus', '決定した授業だけ実施済みにできます');
    if (l.date > todayJst(c.now)) fail('future', 'まだ授業の日になっていません');
    const next = await setLesson(c, l, { status: 'done' });
    await closeRequests(c, l.id, ['late'], 'staff:' + c.actor.id);
    await audit(c, 'lessonDone', l.id);
    return { lesson: lessonView(next) };
  },
  // 入力ミスの削除（記録を残さない）。実施済みは消せない
  'schedule/lessons/delete': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const l = await getLesson(c, b.id); sameVersion(l, b);
    if (l.status === 'done') fail('badStatus', '実施済みの授業は消せません');
    if (l.status === 'decided') await calendarEffect(c, 'delete', l, '');
    await c.db.batch([c.db.prepare('delete from lessonRequests where lessonId = ?').bind(l.id), c.db.prepare('delete from lessons where id = ?').bind(l.id)]);
    await audit(c, 'lessonDelete', l.id, { date: l.date, start: l.start, status: l.status });
    return {};
  },
  'schedule/requests/resolve': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const r = await c.db.prepare('select * from lessonRequests where id = ?').bind(String(b.id || '')).first();
    if (!r) fail('notFound', '連絡が見つかりません', 404);
    await c.db.prepare("update lessonRequests set status = 'done', resolvedAt = ?, resolvedBy = ?, updatedAt = ?, version = version + 1 where id = ? and status = 'open'").bind(iso(c.now), 'staff:' + c.actor.id, iso(c.now), r.id).run();
    await audit(c, 'requestResolve', r.lessonId, { request: r.id });
    return {};
  },
  // 講師の休み（講師は自分の分、教室管理者は全員分と教室全体）
  'schedule/unavailability/add': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = rolesOf(me).includes('manager');
    const staffId = manager ? String(b.staffId ?? me.id) : me.id;
    const date = String(b.date || ''), start = b.start ? String(b.start) : '', end = b.end ? String(b.end) : '';
    if (!validDate(date)) fail('badDate', '日付を確かめてください');
    if ((start || end) && (!validTime(start) || !validTime(end) || end <= start)) fail('badTime', '時間帯を確かめてください（開始 < 終了）。終日なら空のまま');
    const id = newId('un');
    await c.db.prepare('insert into staffUnavailability (id, staffId, date, start, end, note, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, staffId, date, start, end, String(b.note || '').slice(0, 100), iso(c.now), iso(c.now)).run();
    await audit(c, 'unavailabilityAdd', id);
    return { id };
  },
  'schedule/unavailability/delete': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher');
    const o = await c.db.prepare('select * from staffUnavailability where id = ?').bind(String(b.id || '')).first();
    if (!o || (!rolesOf(me).includes('manager') && o.staffId !== me.id)) fail('notFound', '休みが見つかりません', 404);
    await c.db.prepare('delete from staffUnavailability where id = ?').bind(o.id).run();
    await audit(c, 'unavailabilityDelete', o.id);
    return {};
  },
  'schedule/events/add': async (c, b) => { await requireStaff(c, b, 'manager'); await studentRow(c, b.studentId); return addEvent(c, String(b.studentId), { kind: 'staff', id: c.actor.id }, b); },
  'schedule/events/delete': async (c, b) => { await requireStaff(c, b, 'manager'); return deleteEvent(c, null, null, b); },
  'schedule/meetings/create': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const fam = await c.db.prepare('select * from families where id = ?').bind(String(b.familyId || '')).first();
    if (!fam) fail('notFound', '家族が見つかりません', 404);
    const date = String(b.date || ''), start = String(b.start || ''), minutes = Number(b.minutes || 30);
    if (!validDate(date) || !validTime(start) || !Number.isInteger(minutes) || minutes < 10 || minutes > 180) fail('badTime', '日時と長さを確かめてください');
    const id = newId('mt'), mode = b.deliveryMode === 'online' ? 'online' : 'in_person';
    await c.db.prepare('insert into meetings (id, familyId, studentId, staffId, date, start, minutes, deliveryMode, title, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, fam.id, String(b.studentId || ''), String(b.staffId || c.actor.id), date, start, minutes, mode, String(b.title || '面談').slice(0, 60), iso(c.now), iso(c.now)).run();
    const m = await c.db.prepare('select * from meetings where id = ?').bind(id).first();
    const marker = await calendarEffect(c, 'create', { ...m, id, subject: m.title, calendarEventId: '' }, fam.name.replace(/さん$/, ''));
    await c.db.prepare('update meetings set calendarEventId = ? where id = ?').bind(marker, id).run();
    await audit(c, 'meetingCreate', id);
    return { id };
  },
  'schedule/meetings/cancel': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const m = await c.db.prepare('select * from meetings where id = ?').bind(String(b.id || '')).first();
    if (!m || m.status !== 'scheduled') fail('notFound', '面談が見つかりません', 404);
    await c.db.prepare("update meetings set status = 'cancelled', updatedAt = ?, version = version + 1 where id = ?").bind(iso(c.now), m.id).run();
    await calendarEffect(c, 'delete', m, '');
    await audit(c, 'meetingCancel', m.id);
    return {};
  },

  // ---- 保護者 ----
  'family/schedule': async (c, b) => {
    const me = await requireFamily(c, b), { from, to } = range(b, todayJst(c.now));
    const kids = (await c.db.prepare("select * from students where familyId = ? and status <> 'left'").bind(me.id).all()).results;
    return { today: todayJst(c.now), students: kids.map(s => ({ id: s.id, name: fullName(s) })), ...(await familyScheduleOf(c, kids.map(s => s.id), from, to)) };
  },
  'family/lessons/request': async (c, b) => { const me = await requireFamily(c, b); const ids = (await c.db.prepare('select id from students where familyId = ?').bind(me.id).all()).results.map(r => r.id); return lessonRequest(c, ids, { kind: 'family', id: me.id }, b); },
  'family/lessons/withdraw': async (c, b) => { const me = await requireFamily(c, b); const ids = (await c.db.prepare('select id from students where familyId = ?').bind(me.id).all()).results.map(r => r.id); return withdrawRequest(c, ids, b); },
  'family/events/add': async (c, b) => { const me = await requireFamily(c, b); const s = await studentRow(c, b.studentId); if (s.familyId !== me.id) fail('notFound', '生徒が見つかりません', 404); return addEvent(c, s.id, { kind: 'family', id: me.id }, b); },
  'family/events/delete': async (c, b) => { const me = await requireFamily(c, b); const ids = (await c.db.prepare('select id from students where familyId = ?').bind(me.id).all()).results.map(r => r.id); return deleteEvent(c, ids, null, b); },

  // ---- 生徒（専用リンク）。保護者が「保護者だけ」にした操作はできない ----
  'student/schedule': async (c, b) => { const s = await studentByLink(c, b), { from, to } = range(b, todayJst(c.now)); return { today: todayJst(c.now), me: { id: s.id, name: fullName(s) }, permissions: { reschedule: studentMay(s, 'reschedule'), events: studentMay(s, 'events') }, ...(await familyScheduleOf(c, [s.id], from, to)) }; },
  'student/lessons/request': async (c, b) => { const s = await studentByLink(c, b); if (!studentMay(s, 'reschedule')) fail('forbidden', 'この連絡は保護者の方からお願いします', 403); return lessonRequest(c, [s.id], { kind: 'student', id: s.id }, b); },
  'student/lessons/withdraw': async (c, b) => { const s = await studentByLink(c, b); if (!studentMay(s, 'reschedule')) fail('forbidden', 'この連絡は保護者の方からお願いします', 403); return withdrawRequest(c, [s.id], b); },
  'student/events/add': async (c, b) => { const s = await studentByLink(c, b); if (!studentMay(s, 'events')) fail('forbidden', '予定の共有は保護者の方からお願いします', 403); return addEvent(c, s.id, { kind: 'student', id: s.id }, b); },
  'student/events/delete': async (c, b) => { const s = await studentByLink(c, b); if (!studentMay(s, 'events')) fail('forbidden', '予定の共有は保護者の方からお願いします', 403); return deleteEvent(c, [s.id], null, b); },
};
