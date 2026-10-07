// スタッフ（講師・教室管理者・システム管理者）のログインと、スタッフの管理（システム管理者）。
import { fail, newId, normEmail, validEmail, iso, audit, sameText } from './util.mjs';
import { login, logout, changePassword, requestReset, confirmReset, acceptInvite, inviteInfo, issueChallenge, readSession, revokeSessions } from './accounts.mjs';

export const ROLES = ['teacher', 'manager', 'sysadmin'];
export const ROLE_LABEL = { teacher: '講師', manager: '教室管理者', sysadmin: 'システム管理者' };
export const rolesOf = who => String(who.roles || '').split(',').filter(r => ROLES.includes(r));

export function staffView(who) {
  return { id: who.id, name: who.name, familyName: who.familyName || '', givenName: who.givenName || '', email: who.email, roles: rolesOf(who), status: who.status, contractType: who.contractType, version: who.version };
}
// 姓と名。name（表示用）は「姓 名」にそろえる
function nameParts(b, base = {}) {
  const familyName = String(b.familyName ?? base.familyName ?? '').trim(), givenName = String(b.givenName ?? base.givenName ?? '').trim();
  if (!familyName || familyName.length > 30 || givenName.length > 30) fail('badName', '姓（必須）と名を30文字以内で入れてください');
  return { familyName, givenName, name: [familyName, givenName].filter(Boolean).join(' ') };
}

// ログイン中のスタッフを確かめ、必要な役割を持っているか見る。c.actor に入れる
export async function requireStaff(c, body, ...roles) {
  const me = c.serviceStaff || await readSession(c, 'staff', body.auth);
  if (!me) fail('needLogin', 'ログインし直してください', 401);
  c.actor = { kind: c.serviceStaff ? 'service' : 'staff', id: me.id };
  if (roles.length && !roles.some(r => rolesOf(me).includes(r))) fail('forbidden', 'この操作をする役割がありません', 403);
  return me;
}

const INVITE_MAIL = { subject: '【ステップワイズ】スタッフのアカウントの設定', body: url => 'ステップワイズのスタッフのアカウントが用意されました。7日以内に次のリンクを開き、パスワードを決めてください。\n\n' + url + '\n\n心当たりがない場合は、このメールを破棄してください。' };

function cleanRoles(list) {
  if (!Array.isArray(list) || !list.length || list.some(r => !ROLES.includes(r))) fail('badRoles', '役割を1つ以上選んでください');
  return ROLES.filter(r => list.includes(r)).join(',');
}

// 有効なシステム管理者が 1 人もいなくなる変更は断る（誰も設定を触れなくなるため）
async function keepsSysadmin(c, id, nextRoles, nextStatus) {
  const rows = (await c.db.prepare("select id, roles, status from staff where status = 'active'").all()).results;
  const left = rows.filter(r => (r.id === id ? nextStatus === 'active' && nextRoles.split(',').includes('sysadmin') : rolesOf(r).includes('sysadmin')));
  if (!left.length) fail('lastSysadmin', 'システム管理者が1人もいなくなるため、変更できません');
}

export const staffRoutes = {
  'staff/login': async (c, b) => { const r = await login(c, 'staff', b); return { auth: r.token, me: staffView(r.who) }; },
  'staff/logout': (c, b) => logout(c, 'staff', b.auth),
  'staff/me': async (c, b) => ({ me: staffView(await requireStaff(c, b)) }),
  'staff/password': async (c, b) => changePassword(c, 'staff', await requireStaff(c, b), b),
  'staff/reset/request': (c, b) => requestReset(c, 'staff', b),
  'staff/reset/confirm': async (c, b) => { const r = await confirmReset(c, 'staff', b); return { auth: r.token, me: staffView(r.who) }; },
  'staff/invite/info': (c, b) => inviteInfo(c, 'staff', b),
  'staff/invite/accept': async (c, b) => { const r = await acceptInvite(c, 'staff', b); return { auth: r.token, me: staffView(r.who) }; },

  // 最初の 1 人（代表）。今の管理画面にログインしている端末からだけ作れる。
  // 有効なシステム管理者がまだいないときだけ使える。パスワードは本人がこのあと画面で決める
  'staff/bootstrap/status': async c => ({ available: !(await c.db.prepare("select 1 from staff where status = 'active' and (',' || roles || ',') like '%,sysadmin,%'").first()) }),
  'staff/bootstrap': async (c, b) => {
    if (await c.db.prepare("select 1 from staff where status = 'active' and (',' || roles || ',') like '%,sysadmin,%'").first()) fail('already', 'すでに設定が済んでいます。ログインしてください', 409);
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    const cfg = Object.fromEntries((await c.env.DB.prepare("select key, value from config where key in ('adminToken', 'adminTokenExp', 'teacherEmail')").all()).results.map(r => [r.key, String(r.value || '')]));
    const legacy = String(b.legacyToken || '');
    if (!legacy || !cfg.adminToken || !sameText(legacy, cfg.adminToken) || !(Number(cfg.adminTokenExp) > c.now)) fail('needLegacyLogin', '今の管理画面にログインしてから、もう一度開いてください', 401);
    const email = normEmail(cfg.teacherEmail);
    if (!validEmail(email)) fail('noEmail', '今の管理画面に先生のメールアドレスが登録されていません', 400);
    let who = await c.db.prepare('select * from staff where email = ?').bind(email).first();
    if (!who) {
      who = { id: newId('st'), name: '代表', familyName: '代表', givenName: '', email, roles: ROLES.join(','), status: 'invited', contractType: 'owner' };
      await c.db.prepare('insert into staff (id, name, familyName, givenName, email, roles, status, contractType, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(who.id, who.name, who.familyName, who.givenName, who.email, who.roles, who.status, who.contractType, iso(c.now), iso(c.now)).run();
    }
    await audit(c, 'bootstrap', who.id, { email });
    return { inviteUrl: await issueChallenge(c, 'staff', 'staffInvite', who, null) };
  },

  // ---- スタッフの管理（システム管理者） ----
  'admin/staff/list': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    const rows = (await c.db.prepare('select * from staff order by createdAt').all()).results;
    return { staff: rows.map(staffView) };
  },
  'admin/staff/invite': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    const { familyName, givenName, name } = nameParts(b), email = normEmail(b.email), roles = cleanRoles(b.roles);
    if (!validEmail(email)) fail('badEmail', 'メールアドレスを確かめてください');
    if (await c.db.prepare('select 1 from staff where email = ?').bind(email).first()) fail('duplicate', 'このメールアドレスのスタッフはすでにいます', 409);
    const who = { id: newId('st'), name, familyName, givenName, email, roles, status: 'invited', contractType: b.contractType === 'owner' ? 'owner' : 'employee', version: 1 };
    await c.db.prepare('insert into staff (id, name, familyName, givenName, email, roles, status, contractType, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(who.id, name, familyName, givenName, email, roles, 'invited', who.contractType, iso(c.now), iso(c.now)).run();
    const inviteUrl = await issueChallenge(c, 'staff', 'staffInvite', who, INVITE_MAIL);
    await audit(c, 'staffInvite', who.id, { roles });
    return { staff: staffView(who), inviteUrl };
  },
  'admin/staff/reinvite': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    const who = await c.db.prepare('select * from staff where id = ?').bind(String(b.id || '')).first();
    if (!who || who.status !== 'invited') fail('notInvited', '招待中のスタッフだけ、招待をやり直せます');
    const inviteUrl = await issueChallenge(c, 'staff', 'staffInvite', who, INVITE_MAIL);
    await audit(c, 'staffReinvite', who.id);
    return { inviteUrl };
  },
  'admin/staff/update': async (c, b) => {
    const me = await requireStaff(c, b, 'sysadmin');
    const who = await c.db.prepare('select * from staff where id = ?').bind(String(b.id || '')).first();
    if (!who) fail('notFound', 'スタッフが見つかりません', 404);
    if (Number(b.version) !== Number(who.version)) fail('conflict', 'ほかの操作で変わりました。画面を更新してください', 409);
    const { familyName, givenName, name } = b.familyName === undefined && b.givenName === undefined ? { familyName: who.familyName || who.name, givenName: who.givenName || '', name: who.name } : nameParts(b, who);
    const roles = b.roles === undefined ? who.roles : cleanRoles(b.roles);
    const status = b.status === undefined ? who.status : String(b.status);
    // 変えられるのは 利用中 ⇄ 停止 と、招待中 → 停止 だけ。招待中は本人がパスワードを決めて利用中になる
    const allowed = status === who.status || (status === 'stopped') || (status === 'active' && who.status === 'stopped' && who.passHash);
    if (!allowed) fail('badStatus', '状態を確かめてください');
    await keepsSysadmin(c, who.id, roles, status === 'invited' ? 'invited' : status);
    await c.db.prepare('update staff set name = ?, familyName = ?, givenName = ?, roles = ?, status = ?, updatedAt = ?, version = version + 1 where id = ? and version = ?').bind(name, familyName, givenName, roles, status, iso(c.now), who.id, who.version).run();
    if (status === 'stopped') await revokeSessions(c, 'staff', who.id);
    await audit(c, 'staffUpdate', who.id, { roles, status, by: me.id });
    return { staff: staffView({ ...who, name, familyName, givenName, roles, status, version: who.version + 1 }) };
  },
};
