// 家族・生徒の管理（教室管理者）と、保護者・生徒から見た自分の情報。家族が根っこ（生徒は必ず家族に属する）。
import { fail, newId, normEmail, validEmail, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { requireFamily } from './family.mjs';
import { issueChallenge, revokeSessions, SITE } from './accounts.mjs';

// 生徒の専用リンクの鍵。推測できない長さにする（今の鍵もそのまま使える）
function newLinkCode() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const studentLink = code => SITE + '/student/?k=' + encodeURIComponent(code);
const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');

export function familyAdminView(f) {
  return { id: f.id, name: f.name, guardianName: f.guardianName, email: f.email, phone: f.phone, note: f.note, status: f.status, hasPassword: !!f.passHash, testOnly: !!f.testOnly, legacyId: f.legacyId, version: f.version };
}
export function studentAdminView(s) {
  return { id: s.id, familyId: s.familyId, name: fullName(s), familyName: s.familyName, givenName: s.givenName, familyKana: s.familyKana, givenKana: s.givenKana,
    grade: s.grade, school: s.school, baseRate30: s.baseRate30, deliveryMode: s.deliveryMode, status: s.status, enrolledOn: s.enrolledOn, subjects: s.subjects, note: s.note,
    testOnly: !!s.testOnly, link: studentLink(s.linkCode), legacyId: s.legacyId, version: s.version };
}
// 保護者・生徒に見せる形（料金・先生用の備考・専用リンクは出さない）
const studentPublicView = s => ({ id: s.id, name: fullName(s), familyName: s.familyName, givenName: s.givenName, grade: s.grade, school: s.school, status: s.status });

const TEXT_LIMITS = { familyName: 40, givenName: 40, familyKana: 40, givenKana: 40, grade: 20, school: 60, subjects: 100, note: 1000 };
function studentFields(b, base = {}) {
  const out = { ...base };
  for (const [k, max] of Object.entries(TEXT_LIMITS)) if (b[k] !== undefined) {
    const v = String(b[k]).trim(); if (v.length > max) fail('tooLong', `${max}文字以内で入れてください（${k}）`); out[k] = v;
  }
  if (b.baseRate30 !== undefined) { const n = Number(b.baseRate30); if (!Number.isInteger(n) || n < 0 || n > 100000) fail('badRate', '基本単価（30分）は0〜100,000円の整数で入れてください'); out.baseRate30 = n; }
  if (b.deliveryMode !== undefined) { if (!['', 'in_person', 'online'].includes(b.deliveryMode)) fail('badMode', '授業の形式を選んでください'); out.deliveryMode = b.deliveryMode; }
  if (b.status !== undefined) { if (!['enrolled', 'paused', 'left'].includes(b.status)) fail('badStatus', '在籍の状態を選んでください'); out.status = b.status; }
  if (b.enrolledOn !== undefined) { if (b.enrolledOn && !/^\d{4}-\d{2}-\d{2}$/.test(b.enrolledOn)) fail('badDate', '入塾日を確かめてください'); out.enrolledOn = b.enrolledOn || ''; }
  if (!out.familyName && !out.givenName) fail('needName', '生徒の名前を入れてください');
  return out;
}
function familyFields(b, base = {}) {
  const out = { ...base };
  for (const [k, max] of Object.entries({ name: 60, guardianName: 60, phone: 30, note: 1000 })) if (b[k] !== undefined) {
    const v = String(b[k]).trim(); if (v.length > max) fail('tooLong', `${max}文字以内で入れてください（${k}）`); out[k] = v;
  }
  if (b.email !== undefined) { const e = normEmail(b.email); if (e && !validEmail(e)) fail('badEmail', 'メールアドレスを確かめてください'); out.email = e; }
  if (!out.name) fail('needName', '家族の表示名を入れてください（例: 山田家）');
  return out;
}
async function emailFree(c, email, exceptId = '') {
  if (email && await c.db.prepare('select 1 from families where email = ? and id <> ?').bind(email, exceptId).first()) fail('duplicate', 'このメールアドレスはほかの家族で使われています', 409);
}
async function getFamily(c, id) { const f = await c.db.prepare('select * from families where id = ?').bind(String(id || '')).first(); if (!f) fail('notFound', '家族が見つかりません', 404); return f; }
async function getStudent(c, id) { const s = await c.db.prepare('select * from students where id = ?').bind(String(id || '')).first(); if (!s) fail('notFound', '生徒が見つかりません', 404); return s; }
const sameVersion = (row, b) => { if (Number(b.version) !== Number(row.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409); };

const INVITE_MAIL = { subject: '【ステップワイズ】保護者ページの登録', body: url => 'ステップワイズの保護者ページの登録のご案内です。7日以内に次のリンクを開き、パスワードを決めてください。授業の予定・記録・授業計画・請求をご確認いただけます。\n\n' + url + '\n\n心当たりがない場合は、このメールを破棄してください。' };

export const peopleRoutes = {
  'admin/families/list': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const fams = (await c.db.prepare('select * from families order by testOnly, name').all()).results;
    const studs = (await c.db.prepare('select * from students order by familyKana, givenKana, familyName, givenName').all()).results;
    return { families: fams.map(f => ({ ...familyAdminView(f), students: studs.filter(s => s.familyId === f.id).map(studentAdminView) })) };
  },
  'admin/families/get': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const f = await getFamily(c, b.id);
    const studs = (await c.db.prepare('select * from students where familyId = ? order by createdAt').bind(f.id).all()).results;
    return { family: { ...familyAdminView(f), students: studs.map(studentAdminView) } };
  },
  'admin/families/create': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const f = familyFields(b, { name: '', guardianName: '', email: '', phone: '', note: '' });
    await emailFree(c, f.email);
    const id = newId('fa'), test = b.testOnly ? 1 : 0;
    await c.db.prepare('insert into families (id, name, guardianName, email, phone, note, status, testOnly, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, f.name, f.guardianName, f.email, f.phone, f.note, 'invited', test, iso(c.now), iso(c.now)).run();
    await audit(c, 'familyCreate', id);
    return { family: familyAdminView(await getFamily(c, id)) };
  },
  'admin/families/update': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const f = await getFamily(c, b.id); sameVersion(f, b);
    const next = familyFields(b, f);
    await emailFree(c, next.email, f.id);
    let status = f.status;
    if (b.status !== undefined && b.status !== f.status) {
      if (b.status === 'stopped') status = 'stopped';
      else if (b.status === 'active' && f.status === 'stopped' && f.passHash) status = 'active';
      else if (b.status === 'invited' && f.status === 'stopped' && !f.passHash) status = 'invited';
      else fail('badStatus', '状態を確かめてください');
    }
    await c.db.prepare('update families set name = ?, guardianName = ?, email = ?, phone = ?, note = ?, status = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?')
      .bind(next.name, next.guardianName, next.email, next.phone, next.note, status, iso(c.now), f.id, f.version).run();
    // 停止・ログインのメールの変更では、今のログインを切る
    if (status === 'stopped' || next.email !== f.email) await revokeSessions(c, 'family', f.id);
    await audit(c, 'familyUpdate', f.id, { status, emailChanged: next.email !== f.email });
    return { family: familyAdminView(await getFamily(c, f.id)) };
  },
  // 保護者ページの登録の招待（メール）。切り替え前は実際には送らない（effects.mjs）。リンクは画面にも出す
  'admin/families/invite': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const f = await getFamily(c, b.id);
    if (!f.email) fail('needEmail', '先に保護者のメールアドレスを登録してください');
    if (f.status === 'stopped') fail('stopped', '停止中の家族には送れません');
    const inviteUrl = await issueChallenge(c, 'family', 'familyInvite', f, INVITE_MAIL);
    await audit(c, 'familyInvite', f.id);
    return { inviteUrl, mailHeld: c.effects.some(e => e.audience === 'family' && e.held) };
  },
  'admin/students/create': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const fam = await getFamily(c, b.familyId);
    const s = studentFields(b, { familyName: '', givenName: '', familyKana: '', givenKana: '', grade: '', school: '', subjects: '', note: '', baseRate30: 0, deliveryMode: '', status: 'enrolled', enrolledOn: '' });
    const id = newId('su');
    await c.db.prepare(`insert into students (id, familyId, familyName, givenName, familyKana, givenKana, grade, school, subjects, note, baseRate30, deliveryMode, status, enrolledOn, linkCode, testOnly, createdAt, updatedAt)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, fam.id, s.familyName, s.givenName, s.familyKana, s.givenKana, s.grade, s.school, s.subjects, s.note, s.baseRate30, s.deliveryMode, s.status, s.enrolledOn, newLinkCode(), fam.testOnly ? 1 : 0, iso(c.now), iso(c.now)).run();
    await audit(c, 'studentCreate', id, { familyId: fam.id });
    return { student: studentAdminView(await getStudent(c, id)) };
  },
  'admin/students/update': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await getStudent(c, b.id); sameVersion(s, b);
    const n = studentFields(b, s);
    await c.db.prepare(`update students set familyName = ?, givenName = ?, familyKana = ?, givenKana = ?, grade = ?, school = ?, subjects = ?, note = ?, baseRate30 = ?, deliveryMode = ?, status = ?, enrolledOn = ?,
      updatedAt = ?, version = version + 1 where id = ? and version = ?`)
      .bind(n.familyName, n.givenName, n.familyKana, n.givenKana, n.grade, n.school, n.subjects, n.note, n.baseRate30, n.deliveryMode, n.status, n.enrolledOn, iso(c.now), s.id, s.version).run();
    await audit(c, 'studentUpdate', s.id, { status: n.status, baseRate30: n.baseRate30 });
    return { student: studentAdminView(await getStudent(c, s.id)) };
  },
  // 生徒を別の家族へ移す（兄弟をまとめる・登録の間違いを直す）
  'admin/students/move': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await getStudent(c, b.id); sameVersion(s, b);
    const to = await getFamily(c, b.familyId);
    if (to.id === s.familyId) return { student: studentAdminView(s) };
    await c.db.prepare('update students set familyId = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?').bind(to.id, iso(c.now), s.id, s.version).run();
    await audit(c, 'studentMove', s.id, { from: s.familyId, to: to.id });
    return { student: studentAdminView(await getStudent(c, s.id)) };
  },
  // 専用リンクの作り直し。前のリンクはすぐに使えなくなる
  'admin/students/newLink': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const s = await getStudent(c, b.id); sameVersion(s, b);
    await c.db.prepare('update students set linkCode = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?').bind(newLinkCode(), iso(c.now), s.id, s.version).run();
    await audit(c, 'studentNewLink', s.id);
    return { student: studentAdminView(await getStudent(c, s.id)) };
  },

  // ---- 保護者・生徒から見た自分の情報 ----
  'family/students': async (c, b) => {
    const me = await requireFamily(c, b);
    const rows = (await c.db.prepare("select * from students where familyId = ? and status <> 'left' order by createdAt").bind(me.id).all()).results;
    return { students: rows.map(studentPublicView) };
  },
  'student/me': async (c, b) => {
    const code = String(b.k || '');
    // スタッフのプレビュー（読むだけ）も、予定と同じ鍵で通す
    if (isPreviewToken(code)) { const p = await previewSubject(c, code, 'student'); if (!p) fail('badLink', 'プレビューの期限が切れました。管理画面からもう一度開いてください', 401); return { me: studentPublicView(p) }; }
    const s = code && code.length <= 100 ? await c.db.prepare("select * from students where linkCode = ? and status <> 'left'").bind(code).first() : null;
    if (!s) fail('badLink', '専用リンクが正しくありません。先生から届いたリンクを開き直してください', 401);
    c.actor = { kind: 'student', id: s.id };
    return { me: studentPublicView(s) };
  },
};
