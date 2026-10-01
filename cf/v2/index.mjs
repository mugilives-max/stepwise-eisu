// v2（作り直し）の API の入口。POST /v2/<領域>/<操作> に JSON を送る。
// ログインのトークンは本文の auth に入れる（ヘッダーを使わないので、今の CORS の設定のまま使える）。
// 返す形: 成功 { ok: true, ... } / 失敗 { ok: false, error: { code, message } }
// データベースは今の台帳（env.DB）とは別の env.DB2。docs/REBUILD_DESIGN.md
import { ApiError } from './util.mjs';
import { staffRoutes } from './staff.mjs';
import { familyRoutes } from './family.mjs';
import { peopleRoutes } from './people.mjs';
import { migrateRoutes } from './migrate-identity.mjs';
import { recordEffects, deliverEffects } from './effects.mjs';

const ROUTES = { ...staffRoutes, ...familyRoutes, ...peopleRoutes, ...migrateRoutes };
const MAX_BODY = 200000;

export async function handleV2(request, env, ctx, head = {}) {
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...head } });
  if (request.method !== 'POST') return reply(405, { ok: false, error: { code: 'method', message: 'POST で送ってください' } });
  if (!env.DB2) return reply(503, { ok: false, error: { code: 'unavailable', message: '準備中です' } });
  const route = new URL(request.url).pathname.replace(/^\/v2\//, '');
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!handler) return reply(404, { ok: false, error: { code: 'notFound', message: '操作が見つかりません' } });
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('too large');
    body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
  } catch { return reply(400, { ok: false, error: { code: 'badRequest', message: '送った内容を読めませんでした' } }); }

  const c = { env, db: env.DB2, now: Date.now(), effects: [], actor: null, userAgent: request.headers.get('user-agent') || '' };
  try {
    const result = await handler(c, body);
    if (c.effects.length) {
      const queued = await recordEffects(c.db, c.effects, c.now);
      const finish = deliverEffects(env, c.db, queued).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(finish); else await finish;
    }
    return reply(200, { ok: true, ...(result || {}) });
  } catch (e) {
    if (e instanceof ApiError) return reply(e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
    console.error('v2 error', route, e && e.stack || e);
    return reply(500, { ok: false, error: { code: 'server', message: '処理に失敗しました。もう一度お試しください' } });
  }
}
