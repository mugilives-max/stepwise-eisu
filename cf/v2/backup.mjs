// 台帳の控え（D1 → R2）。毎日の定期実行（runV2Scheduled）で、DB2 の全表を 1 つの JSON にして R2（FILES）の backup/<日付>.json に置く。
// - 守るもの: D1 の巻き戻し（30 日）を過ぎてから気づく間違い。同じ Cloudflare のアカウントの中なので、アカウントごとの事故は
//   ドライブへの週次の写し（独立 Apps Script、11 月）で守る（issues/stepwise-v2-backup.md）。
// - 90 日より古い控えは消す。鍵は backup/ で始まり、files 表には載らないので、files/get からは開けない（教室管理者が admin/backup/list で見る）。
// - 教室管理者は admin/backup/run でいつでも取れる（切り替えや移行の前に）。
import { fail, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';

export const BACKUP_PREFIX = 'backup/';
export const KEEP_DAYS = 90;
export const jstDate = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

export async function listTables(db) {
  const { results } = await db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'd1_%' and name not like '_cf_%' order by name").all();
  return results.map(r => r.name);
}

// 全表をそのまま（行の配列）。D1 は 1 回の応答が大きすぎると断るので、表ごとに取る
export async function snapshot(db, now) {
  const tables = {}; let rows = 0;
  for (const name of await listTables(db)) { const r = (await db.prepare(`select * from "${name}"`).all()).results; tables[name] = r; rows += r.length; }
  return { takenAt: new Date(now).toISOString(), tables, rows };
}

export async function backupToR2(env, db, now) {
  if (!env.FILES) return { skipped: 'FILES が未設定' };
  const snap = await snapshot(db, now);
  const key = BACKUP_PREFIX + jstDate(now) + '.json';
  const counts = Object.fromEntries(Object.entries(snap.tables).map(([k, v]) => [k, v.length]));
  const body = JSON.stringify({ takenAt: snap.takenAt, counts, tables: snap.tables });
  await env.FILES.put(key, body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { takenAt: snap.takenAt, rows: String(snap.rows) } });
  const removed = await prune(env, now);
  return { key, tables: Object.keys(snap.tables).length, rows: snap.rows, bytes: body.length, removed };
}

async function prune(env, now) {
  const cutoff = BACKUP_PREFIX + jstDate(now - KEEP_DAYS * 86400e3) + '.json'; let removed = 0;
  for (const o of await listBackups(env)) if (o.key < cutoff) { await env.FILES.delete(o.key); removed++; }
  return removed;
}

export async function listBackups(env) {
  if (!env.FILES) return [];
  const out = []; let cursor;
  do {
    const r = await env.FILES.list({ prefix: BACKUP_PREFIX, cursor });
    for (const o of r.objects) out.push({ key: o.key, date: o.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10), size: o.size, rows: Number((o.customMetadata || {}).rows || 0) || 0 });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (a.key < b.key ? 1 : -1)); // 新しい順
}

// 画面に出す形: 最新の日付、何日分、古すぎないか（2 日以上たっていたら注意）
export async function backupStatus(env, now) {
  const list = await listBackups(env);
  const latest = list[0] || null;
  const stale = !latest || latest.date < jstDate(now - 2 * 86400e3);
  return { latest, count: list.length, keepDays: KEEP_DAYS, stale, recent: list.slice(0, 7) };
}

export const backupRoutes = {
  'admin/backup/list': async (c, b) => { await requireStaff(c, b, 'manager'); return backupStatus(c.env, c.now); },
  'admin/backup/run': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const r = await backupToR2(c.env, c.db, c.now);
    if (r.skipped) fail('unavailable', r.skipped, 503);
    await audit(c, 'backupRun', '', { key: r.key, rows: r.rows, bytes: r.bytes });
    return r;
  },
};
