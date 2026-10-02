// v2（作り直し）の API の入口。POST /v2/<領域>/<操作> に JSON を送る。
// ログインのトークンは本文の auth に入れる（ヘッダーを使わないので、今の CORS の設定のまま使える）。
// 返す形: 成功 { ok: true, ... } / 失敗 { ok: false, error: { code, message } }
// データベースは今の台帳（env.DB）とは別の env.DB2。docs/REBUILD_DESIGN.md
import { ApiError } from './util.mjs';
import { staffRoutes } from './staff.mjs';
import { familyRoutes } from './family.mjs';
import { peopleRoutes } from './people.mjs';
import { migrateRoutes } from './migrate-identity.mjs';
import { scheduleRoutes, autoConfirm } from './schedule.mjs';
import { migrateScheduleRoutes } from './migrate-schedule.mjs';
import { recordRoutes } from './records.mjs';
import { migrateRecordsRoutes } from './migrate-records.mjs';
import { billingRoutes, autoCloseInvoices } from './billing.mjs';
import { migrateBillingRoutes } from './migrate-billing.mjs';
import { gradesRoutes, remindTestResults } from './grades.mjs';
import { fileRoutes, handleTransfer, cleanupFiles } from './files.mjs';
import { payrollRoutes } from './payroll.mjs';
import { migrateCheckRoutes } from './migrate-check.mjs';
import { cutoverRoutes } from './cutover.mjs';
import { previewRoutes, isPreviewToken, READS as PREVIEW_READS } from './preview.mjs';
import { homeRoutes } from './home.mjs';
import { studentHubRoutes } from './student-hub.mjs';
import { monthlyRoutes } from './monthly.mjs';
import { recordEffects, deliverEffects } from './effects.mjs';

const ROUTES = { ...staffRoutes, ...familyRoutes, ...peopleRoutes, ...migrateRoutes, ...scheduleRoutes, ...migrateScheduleRoutes, ...recordRoutes, ...migrateRecordsRoutes, ...billingRoutes, ...migrateBillingRoutes, ...gradesRoutes, ...fileRoutes, ...payrollRoutes, ...migrateCheckRoutes, ...cutoverRoutes, ...previewRoutes, ...homeRoutes, ...studentHubRoutes, ...monthlyRoutes };
const MAX_BODY = 200000;

// 毎日0時10分（Worker の定期実行）: 締め切りを過ぎた仮予定を決定する。切り替えたあとは、3日以降に前月分の請求を確定する
export async function runV2Scheduled(env, now = Date.now()) {
  if (!env.DB2) return null;
  const c = { env, db: env.DB2, now, effects: [], actor: null, userAgent: 'scheduled' };
  const result = await autoConfirm(c);
  result.invoices = await autoCloseInvoices(c);
  result.tests = await remindTestResults(c);
  result.files = await cleanupFiles(c);
  if (c.effects.length) await deliverEffects(env, c.db, await recordEffects(c.db, c.effects, c.now));
  return result;
}

export async function handleV2(request, env, ctx, head = {}) {
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...head } });
  // ファイルの中身を送る・開く口だけは JSON ではない（cf/v2/files.mjs）
  const path = new URL(request.url).pathname.replace(/^\/v2\//, '');
  if (env.DB2 && (path === 'files/put' || path === 'files/get')) {
    try { return await handleTransfer(request, env, ctx, path, head); }
    catch { return reply(500, { ok: false, error: { code: 'server', message: '処理に失敗しました。もう一度お試しください' } }); }
  }
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
  // スタッフのプレビューは表示だけ。読むだけの操作のほかは、ここですべて断る（書き込み・メール・ログアウト）
  if ((isPreviewToken(body.auth) || isPreviewToken(body.k)) && !PREVIEW_READS.has(route)) return reply(403, { ok: false, error: { code: 'preview', message: 'プレビュー中のため、変更はできません（表示だけです）' } });

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
