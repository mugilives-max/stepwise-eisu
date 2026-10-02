// 今の台帳（env.DB）から、家族・生徒を新しい形（env.DB2）へ写す。切り替えの準備（REBUILD_DESIGN 6章）。
// - 「見る（preview）」は書かずに、どう写るかと気になる点を返す。
// - 「写す（apply）」は、前に写した行（legacyId のある行）を消してから写し直す。何度でもやり直せる。
// - 保護者のパスワードは同じ方式なので、そのまま写す（登録し直しは要らない）。
// - 写すのはシステム管理者だけ。保護者へのメールは切り替え（live）まで送らない（accounts.mjs）。
import { fail, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { familyAdminView, studentAdminView } from './people.mjs';

const truthy = v => v === 1 || v === true || v === '1' || v === 'true' || v === 'TRUE';
const splitName = n => { const p = String(n || '').trim().split(/[\s　]+/); return p.length > 1 ? [p[0], p.slice(1).join(' ')] : [p[0] || '', '']; };
const isTestName = n => String(n || '').startsWith('【テスト】');
const goodHash = h => /^pbkdf2-sha256\$\d+\$[a-f0-9]{64}$/.test(String(h || ''));
function normDate(v) {
  const s = String(v || '').trim(), m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

export async function identityPlan(old) {
  const all = async sql => (await old.prepare(sql).all()).results;
  const [students, names, ledger, accounts, links, profiles] = await Promise.all([
    all('select * from students'), all('select * from studentNames'), all('select * from "生徒台帳"'),
    all('select * from familyAccounts'), all('select * from familyLinks'), all('select * from familyProfiles'),
  ]);
  const byId = (rows, key = 'id') => Object.fromEntries(rows.map(r => [String(r[key]), r]));
  const nameOf = byId(names), ledgerOf = byId(ledger, '生徒ID'), profileOf = byId(profiles);
  const problems = [], families = [], studs = [], usedEmails = new Set();

  for (const a of accounts) {
    const p = profileOf[a.id] || {};
    const status = a.status === 'disabled' ? 'stopped' : a.status === 'active' && goodHash(a.passHash) ? 'active' : 'invited';
    let email = String(a.email || '').trim().toLowerCase();
    if (email && usedEmails.has(email)) { problems.push(`家族「${a.label}」のメールアドレスがほかの家族と同じため、空にしました`); email = ''; }
    if (email) usedEmails.add(email);
    const label = String(a.label || '');
    families.push({
      id: 'fa_' + a.id, legacyId: String(a.id), name: p.familyName ? p.familyName + '家' : (label.replace(/さんのグループ$/, 'さんの家族') || '名前のない家族'),
      guardianName: [p.familyName, p.givenName].filter(Boolean).join(' '), email, phone: '', note: '',
      passSalt: status === 'active' ? String(a.passSalt || '') : '', passHash: status === 'active' ? String(a.passHash) : '',
      status, testOnly: truthy(a.testOnly) || isTestName(label) ? 1 : 0, createdAt: String(a.createdAt || ''),
    });
    if (status === 'invited') problems.push(`家族「${label}」は保護者の登録が済んでいません（写したあとで招待を送れます）`);
  }
  const famById = Object.fromEntries(families.map(f => [f.legacyId, f]));

  for (const s of students) {
    const sid = String(s.id), led = ledgerOf[sid] || {}, nm = nameOf[sid];
    const [fn, gn] = nm && (nm.familyName || nm.givenName) ? [nm.familyName, nm.givenName] : splitName(s.name);
    const [fk, gk] = splitName(led['ふりがな']);
    const active = links.filter(l => String(l.studentId) === sid && truthy(l.active));
    let fam = active.length ? famById[String(active[0].familyId)] : null;
    if (active.length > 1) problems.push(`生徒「${s.name}」が2つ以上の家族につながっています。最初の家族に入れました`);
    if (!fam) {
      fam = { id: 'fa_solo_' + sid, legacyId: 'solo:' + sid, name: (fn || s.name) + 'さんの家族', guardianName: String(led['保護者名'] || ''), email: '', phone: '', note: '',
        passSalt: '', passHash: '', status: 'invited', testOnly: isTestName(s.name) ? 1 : 0, createdAt: '' };
      families.push(fam); famById[fam.legacyId] = fam;
      problems.push(`生徒「${s.name}」は家族につながっていないため、新しい家族を作りました`);
    }
    if (!fam.guardianName && led['保護者名']) fam.guardianName = String(led['保護者名']);
    if (!fam.phone && led['保護者連絡先']) fam.phone = String(led['保護者連絡先']).slice(0, 30);
    const ledgerStatus = String(led['状態'] || '');
    const status = /退/.test(ledgerStatus) ? 'left' : /休/.test(ledgerStatus) ? 'paused' : (s.active === 0 || s.active === '0' || s.active === false || s.active === 'false') ? 'left' : 'enrolled';
    let code = String(s.code || '');
    if (!code) problems.push(`生徒「${s.name}」に専用リンクがないため、写したあとで作り直してください`);
    studs.push({
      id: 'su_' + sid, legacyId: sid, familyId: fam.id, familyName: String(fn || ''), givenName: String(gn || ''), familyKana: fk, givenKana: gk,
      grade: String(led['学年'] || ''), school: String(led['学校'] || ''), subjects: String(led['科目'] || '').slice(0, 100), note: String(led['備考'] || '').slice(0, 1000),
      baseRate30: Number(s.rate30) || Number(led['単価(30分)']) || 0, deliveryMode: ['in_person', 'online'].includes(s.deliveryMode) ? s.deliveryMode : '',
      status, enrolledOn: normDate(led['入塾日']), linkCode: code || ('missing-' + sid), testOnly: isTestName(s.name) || fam.testOnly ? 1 : 0,
    });
    if (!studs.at(-1).baseRate30 && status !== 'left') problems.push(`生徒「${s.name}」の基本単価が0円です`);
  }
  for (const f of families) if (!studs.some(s => s.familyId === f.id)) problems.push(`家族「${f.name}」には生徒がいません`);
  return { families, students: studs, problems };
}

export const migrateRoutes = {
  'admin/migrate/identity/preview': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const plan = await identityPlan(c.env.DB);
    const copied = (await c.db.prepare("select count(*) n from families where legacyId <> ''").first()).n;
    return {
      families: plan.families.map(f => ({ ...familyAdminView({ ...f, version: 0 }), students: plan.students.filter(s => s.familyId === f.id).map(s => studentAdminView({ ...s, version: 0 })) })),
      problems: plan.problems, copiedFamilies: copied,
    };
  },
  'admin/migrate/identity/apply': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (b.confirm !== true) fail('needConfirm', '確認してから写してください');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const plan = await identityPlan(c.env.DB);
    // 新しい仕組みで作った生徒が、前に写した家族に入っていたら消せないので止める
    const later = await c.db.prepare(`select (select count(*) from lessons where studentId in (select id from students where legacyId <> ''))
      + (select count(*) from sharedEvents where studentId in (select id from students where legacyId <> ''))
      + (select count(*) from homework where studentId in (select id from students where legacyId <> ''))
      + (select count(*) from handoverNotes where studentId in (select id from students where legacyId <> ''))
      + (select count(*) from meetings where familyId in (select id from families where legacyId <> ''))
      + (select count(*) from planLines where studentId in (select id from students where legacyId <> ''))
      + (select count(*) from invoices where familyId in (select id from families where legacyId <> '')) n`).first();
    if (later.n)
      fail('useAll', '予定を写したあとは、家族・生徒だけを写し直せません。「全部を順に写し直す」を使ってください', 409);
    const mixed = await c.db.prepare("select count(*) n from students s join families f on f.id = s.familyId where s.legacyId = '' and f.legacyId <> ''").first();
    if (mixed.n) fail('mixed', '写した家族に、新しい仕組みで登録した生徒がいます。先にその生徒をほかの家族へ移してください', 409);
    const now = iso(c.now), db = c.db, stmts = [
      db.prepare("delete from sessions where kind = 'family' and subjectId in (select id from families where legacyId <> '')"),
      db.prepare("delete from students where legacyId <> ''"),
      db.prepare("delete from families where legacyId <> ''"),
    ];
    for (const f of plan.families) stmts.push(db.prepare(`insert into families (id, legacyId, name, guardianName, email, phone, note, passSalt, passHash, status, testOnly, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(f.id, f.legacyId, f.name, f.guardianName, f.email, f.phone, f.note, f.passSalt, f.passHash, f.status, f.testOnly, f.createdAt || now, now));
    for (const s of plan.students) stmts.push(db.prepare(`insert into students (id, legacyId, familyId, familyName, givenName, familyKana, givenKana, grade, school, subjects, note, baseRate30, deliveryMode, status, enrolledOn, linkCode, testOnly, createdAt, updatedAt)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(s.id, s.legacyId, s.familyId, s.familyName, s.givenName, s.familyKana, s.givenKana, s.grade, s.school, s.subjects, s.note, s.baseRate30, s.deliveryMode, s.status, s.enrolledOn, s.linkCode, s.testOnly, now, now));
    await db.batch(stmts);
    await audit(c, 'migrateIdentity', '', { families: plan.families.length, students: plan.students.length, problems: plan.problems.length });
    return { families: plan.families.length, students: plan.students.length, problems: plan.problems };
  },
};
