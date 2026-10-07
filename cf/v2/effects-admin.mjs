// 送れなかったメール・カレンダーを見て、送り直す・取り下げる（教室管理者）。effects 表（effects.mjs）。
// 毎日の定期実行でも、失敗したものを 3 回まで送り直す（retryFailedEffects）。
import { fail, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { deliverEffects } from './effects.mjs';

const LABEL = { mail: 'メール', calendarCreate: 'カレンダーに予定を作る', calendarUpdate: 'カレンダーの予定を直す', calendarDelete: 'カレンダーの予定を消す', calendarMeet: 'Meet のリンク' };
const parse = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const view = r => { const p = parse(r.payload); const body = p.body && typeof p.body === 'object' ? p.body : {};
  return { id: r.id, createdAt: r.createdAt, kind: r.kind, label: LABEL[r.kind] || r.kind, status: r.status, attempts: r.attempts, error: r.error, sentAt: r.sentAt,
    to: p.to || '', subject: p.subject || body.summary || '', audience: p.audience || '', held: !!p.held, testOnly: !!p.testOnly }; };
const STALE_MS = 10 * 60e3;

export const effectsAdminRoutes = {
  // 直近 30 日。送れなかったもの（failed と、10 分以上たっても pending のもの）、送ったもの（最近 50 件）、送らなかったもの（切り替え前・テスト用）の数
  'admin/effects/list': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const since = new Date(c.now - 30 * 86400e3).toISOString(), stale = new Date(c.now - STALE_MS).toISOString();
    const rows = (await c.db.prepare('select id, createdAt, kind, payload, status, attempts, error, sentAt from effects where createdAt >= ? order by id desc limit 400').bind(since).all()).results;
    return {
      failed: rows.filter(r => r.status === 'failed' || (r.status === 'pending' && r.createdAt < stale)).map(view),
      recent: rows.filter(r => r.status === 'sent').slice(0, 50).map(view),
      dismissed: rows.filter(r => r.status === 'dismissed').length,
    };
  },
  // 送り直す（失敗したもの・止まっているものだけ）
  'admin/effects/retry': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 50);
    if (!ids.length) fail('needIds', '送り直すものを選んでください');
    const rows = (await c.db.prepare(`select * from effects where id in (${ids.map(() => '?').join(',')}) and status in ('failed', 'pending') order by id`).bind(...ids).all()).results;
    if (!rows.length) fail('nothing', '送り直せるものがありません（もう送ったか、取り下げたものです）');
    const r = await deliverEffects(c.env, c.db, rows.map(x => ({ id: x.id, item: parse(x.payload) })));
    await audit(c, 'effectsRetry', '', { ids: rows.map(x => x.id), sent: r.sent, error: r.error || r.skipped || '' });
    if (r.skipped) fail('unavailable', '送る先（Apps Script）の設定がありません', 503);
    return { sent: r.sent, failed: rows.length - r.sent, error: r.error || '' };
  },
  // 取り下げる（もう要らないもの。送らない）
  'admin/effects/dismiss': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 50);
    if (!ids.length) fail('needIds', '取り下げるものを選んでください');
    const r = await c.db.prepare(`update effects set status = 'dismissed', error = '教室管理者が取り下げ' where id in (${ids.map(() => '?').join(',')}) and status in ('failed', 'pending')`).bind(...ids).run();
    await audit(c, 'effectsDismiss', '', { ids });
    return { dismissed: Number(r.meta && r.meta.changes) || 0 };
  },
};

// 定期実行: 48 時間以内に失敗したものを、3 回まで送り直す
export async function retryFailedEffects(env, db, now) {
  const since = new Date(now - 48 * 3600e3).toISOString();
  const rows = (await db.prepare("select * from effects where status = 'failed' and attempts < 3 and createdAt >= ? order by id limit 50").bind(since).all()).results;
  if (!rows.length) return { retried: 0, sent: 0 };
  const r = await deliverEffects(env, db, rows.map(x => ({ id: x.id, item: parse(x.payload) })));
  return { retried: rows.length, sent: r.sent };
}
// 送れなかったものの数（「今日」の対応することに出す）
export async function failedEffectsCount(db, now) {
  const since = new Date(now - 30 * 86400e3).toISOString(), stale = new Date(now - STALE_MS).toISOString();
  const r = await db.prepare("select count(*) n from effects where createdAt >= ? and (status = 'failed' or (status = 'pending' and createdAt < ?))").bind(since, stale).first();
  return r ? Number(r.n) : 0;
}
