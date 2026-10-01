// 送れなかった付随処理（メール・Google カレンダー）を先生が1件ずつ確かめる口。
//
// 付随処理は Apps Script に頼んでいて、失敗しても自動では送り直さない（2026-10-01 先生の判断）。
// 数日前の通知をまとめて送ると混乱するので、一覧で中身を見てから「再送」か「送らない」を選ぶ。
// Meet の取り直し（calendarMeet）は画面を開くたびに自動で頼み直すので、一覧には出さない。
import { createRuntime } from './read.mjs';
import { deliverEffects } from './write.mjs';

export const EFFECT_ADMIN_OPS = ['effectsList', 'effectRetry', 'effectDismiss', 'effectsLog'];
const LISTED = ['mail', 'calendarCreate', 'calendarPatch', 'calendarDelete'];
// 送っている最中のものは出さない（応答を返したあとで送るので、作った直後は pending のまま）
const IN_FLIGHT_MS = 10 * 60 * 1000;

function jst(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// 一覧に出す要約。宛先・件名・本文の冒頭（メール）、予定の題名と日時（カレンダー）
export function effectSummary(kind, payload) {
  const p = payload || {};
  if (kind === 'mail') return { label: 'メール', title: String(p.subject || '（件名なし）'), to: String(p.to || ''), preview: String(p.body || '').slice(0, 2000) };
  const body = p.body || {};
  const when = body.start && body.start.dateTime ? jst(body.start.dateTime) : '';
  if (kind === 'calendarCreate') return { label: 'カレンダーに予定を作る', title: String(body.summary || ''), when, meet: !!p.wantMeet };
  if (kind === 'calendarPatch') return { label: 'カレンダーの予定を変える', title: String(body.summary || ''), when };
  return { label: 'カレンダーの予定を消す', title: '', when: '' };
}

async function teacherOnly(body, env) {
  const gas = await createRuntime(env);
  return gas.authMode_() === 'account' && gas.tokenOk_(body.token);
}

export async function handleEffectsAdmin(body, env, options = {}) {
  if (!(await teacherOnly(body, env))) return { error: 'ログインし直してください', badAuth: true };
  const now = options.now ?? Date.now();
  if (body.op === 'effectsList') {
    const cutoff = new Date(now - IN_FLIGHT_MS).toISOString();
    const { results } = await env.DB.prepare(
      `select id, createdAt, kind, status, attempts, error, payload from _effects
        where status in ('failed', 'pending') and kind in (${LISTED.map(() => '?').join(',')}) and createdAt < ?
        order by id`).bind(...LISTED, cutoff).all();
    const items = (results || []).map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload); } catch (e) { payload = {}; }
      return { id: Number(r.id), createdAt: String(r.createdAt), at: jst(r.createdAt), kind: String(r.kind), status: String(r.status), attempts: Number(r.attempts) || 0, error: String(r.error || '').slice(0, 160), ...effectSummary(r.kind, payload) };
    });
    return { ok: true, count: items.length, items: body.countOnly ? [] : items };
  }
  // 送信の記録（新しい順・50件ずつ）。kind: mail | calendar | all、status: all | sent | problem（失敗・未送信・送らない）
  if (body.op === 'effectsLog') {
    const kind = ['mail', 'calendar', 'all'].indexOf(body.kind) >= 0 ? body.kind : 'mail';
    const status = ['all', 'sent', 'problem'].indexOf(body.status) >= 0 ? body.status : 'all';
    const before = Number.isInteger(body.before) && body.before > 0 ? body.before : 2147483647;
    const kinds = kind === 'mail' ? ['mail'] : kind === 'calendar' ? LISTED.filter(k => k !== 'mail') : LISTED;
    const statuses = status === 'sent' ? ['sent'] : status === 'problem' ? ['failed', 'pending', 'dismissed'] : ['sent', 'failed', 'pending', 'dismissed'];
    const { results } = await env.DB.prepare(
      `select id, createdAt, kind, status, attempts, error, sentAt, payload from _effects
        where id < ? and kind in (${kinds.map(() => '?').join(',')}) and status in (${statuses.map(() => '?').join(',')})
        order by id desc limit 51`).bind(before, ...kinds, ...statuses).all();
    const rows = results || [];
    const items = rows.slice(0, 50).map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload); } catch (e) { payload = {}; }
      return { id: Number(r.id), createdAt: String(r.createdAt), at: jst(r.createdAt), sentAt: jst(r.sentAt), kind: String(r.kind), status: String(r.status), attempts: Number(r.attempts) || 0, error: String(r.error || '').slice(0, 160), ...effectSummary(r.kind, payload) };
    });
    return { ok: true, kind, status, items, more: rows.length > 50, next: items.length ? items[items.length - 1].id : 0 };
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return { error: '対象を選び直してください' };
  const row = await env.DB.prepare('select id, kind, status, payload from _effects where id = ?').bind(id).first();
  if (!row || LISTED.indexOf(String(row.kind)) < 0) return { error: '対象が見つかりません。一覧を読み直してください', errorCode: 'notFound' };
  if (row.status !== 'failed' && row.status !== 'pending') return { error: 'この処理はすでに' + (row.status === 'sent' ? '送信済み' : '対応済み') + 'です。一覧を読み直してください', errorCode: 'conflict' };
  if (body.op === 'effectDismiss') {
    await env.DB.prepare("update _effects set status = 'dismissed', error = ? where id = ? and status in ('failed', 'pending')")
      .bind('先生が送らないことにしました ' + new Date(now).toISOString(), id).run();
    return { ok: true, id, status: 'dismissed' };
  }
  // 再送: 同じ中身をもう一度 Apps Script に頼む。結果（送信済み・失敗）は控えに残る
  let payload;
  try { payload = JSON.parse(row.payload); } catch (e) { return { error: '中身を読めないため再送できません' }; }
  const out = await deliverEffects(env, [payload], [id]);
  if (out.error) return { error: '再送に失敗しました: ' + String(out.error).slice(0, 160), errorCode: 'upstream' };
  return { ok: true, id, status: 'sent', writebacks: out.writebacks || 0 };
}
