// 保護者（家族）のログイン。家族の登録・招待の画面は 2 段目（家族・生徒の管理）で作る。
import { fail } from './util.mjs';
import { isPreviewToken, previewSubject } from './preview.mjs';
import { login, logout, changePassword, requestReset, confirmReset, acceptInvite, inviteInfo, readSession } from './accounts.mjs';

export function familyView(f) { return { id: f.id, name: f.name, email: f.email, version: f.version }; }

export async function requireFamily(c, body) {
  // スタッフのプレビュー（読むだけ。書き込みは index.mjs の入口で断る）
  if (isPreviewToken(body.auth)) { const f = await previewSubject(c, body.auth, 'family'); if (!f) fail('needLogin', 'プレビューの期限が切れました。管理画面からもう一度開いてください', 401); return f; }
  const me = await readSession(c, 'family', body.auth);
  if (!me) fail('needLogin', 'ログインし直してください', 401);
  c.actor = { kind: 'family', id: me.id };
  return me;
}

export const familyRoutes = {
  'family/login': async (c, b) => { const r = await login(c, 'family', b); return { auth: r.token, me: familyView(r.who) }; },
  'family/logout': (c, b) => logout(c, 'family', b.auth),
  'family/me': async (c, b) => ({ me: familyView(await requireFamily(c, b)) }),
  'family/password': async (c, b) => changePassword(c, 'family', await requireFamily(c, b), b),
  'family/reset/request': (c, b) => requestReset(c, 'family', b),
  'family/reset/confirm': async (c, b) => { const r = await confirmReset(c, 'family', b); return { auth: r.token, me: familyView(r.who) }; },
  'family/invite/info': (c, b) => inviteInfo(c, 'family', b),
  'family/invite/accept': async (c, b) => { const r = await acceptInvite(c, 'family', b); return { auth: r.token, me: familyView(r.who) }; },
};
