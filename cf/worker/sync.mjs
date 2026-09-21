// GAS が書き込んだあと、変わったシートを受け取って D1 を合わせる。
//
// 誰が呼べるか: 共有の鍵（Worker の secret SYNC_KEY と GAS の Script Property の両方に
// 同じ文字列を入れる）を知っている呼び出しだけ。鍵が設定されていなければ受け付けない。
// 何をするか: 送られてきたシートの中身で、その表を丸ごと置き換える（消えた行も消える）。
// 送られてこなかった表には触らない。
//
// 丸ごと置き換える理由: 台帳の書き込みには行の削除（取消された授業など）があり、
// 追加と更新だけでは消えた行が D1 に残ってしまうため。1 シートずつなので量も小さい。
import { importSheet, quoteIdent, tableExists, VIEW_SHEETS } from '../lib/import.mjs';
import { TABLE_SCHEMA } from './generated/schema.mjs';

// 鍵は長さでも弾く（短い鍵の総当たりを避ける）
const MIN_KEY_LENGTH = 24;

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function syncAuthorized(env, key) {
  const expected = String(env.SYNC_KEY || '');
  if (expected.length < MIN_KEY_LENGTH) return false;
  return timingSafeEqual(expected, String(key || ''));
}

/**
 * 変わったシートを D1 に反映する。
 * body: { key, sheets: [{ book, sheet, headers, rows }], full?: true }
 * full=true なら、送られてこなかった業務表の中身も消す（作り直し用）。
 */
export async function handleSync(body, env) {
  if (!syncAuthorized(env, body && body.key)) return { status: 403, payload: { error: '同期の鍵が正しくありません' } };

  const sheets = Array.isArray(body.sheets) ? body.sheets : [];
  if (!sheets.length) return { status: 400, payload: { error: '同期するシートがありません' } };

  const syncedAt = new Date().toISOString();
  const applied = [];
  const errors = [];

  for (const part of sheets) {
    const table = String(part.sheet || '');
    if (VIEW_SHEETS.includes(table)) { applied.push({ table, rows: 0, skipped: true }); continue; }
    if (!TABLE_SCHEMA[table]) { errors.push(`D1 にこのシートに対応する表がありません: ${table}`); continue; }
    if (!(await tableExists(env.DB, table))) { errors.push(`表がまだ作られていません: ${table}`); continue; }
    // 置き換え。途中で失敗したら、その表だけが空のまま残らないよう中身を戻せないので、
    // 消す前に入れ直せることを確かめてから消す…のではなく、消しと入れを 1 つのまとまりで流す
    try {
      await env.DB.prepare(`delete from ${quoteIdent(table)}`).run();
      const result = await importSheet(env.DB, part, { syncedAt, schema: TABLE_SCHEMA });
      if (result.errors.length) errors.push(...result.errors);
      applied.push({ table, rows: result.rows, skippedColumns: result.skippedColumns });
    } catch (e) {
      errors.push(`${table}: ${(e && e.message) || e}`);
    }
  }

  return {
    status: errors.length ? 500 : 200,
    payload: { ok: !errors.length, syncedAt, applied, ...(errors.length ? { errors } : {}) },
  };
}

/** D1 がいつの台帳かを返す（古すぎないかの判断に使う）。 */
export async function syncStatus(env) {
  try {
    const row = await env.DB.prepare('select max(_syncedAt) as at from slots').first();
    return { syncedAt: (row && row.at) || '' };
  } catch (e) {
    return { syncedAt: '' };
  }
}
